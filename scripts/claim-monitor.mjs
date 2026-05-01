/**
 * Claim assignment monitor — runs locally on the Mac mini.
 *
 * Polls hakiel.mcqueen@erseville.com every 60 seconds for new assignment emails.
 * On match, sends iMessage to +14244663685 via osascript.
 *
 * Run from repo root:
 *   node scripts/claim-monitor.mjs
 *
 * Logs to claim_monitor.log in the repo root.
 * Tracks already-alerted message IDs in claim_monitor_state.json (gitignored).
 *
 * Reads from env vars or local files at the repo root:
 *   - GOOGLE_CREDENTIALS_JSON  or credentials.json
 *   - GOOGLE_TOKEN_JSON        or token.json
 *   - CLAIM_MONITOR_PHONE      (defaults to +14244663685)
 *
 * Stop with Ctrl+C.
 */
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import dotenv from "dotenv";

const REPO_ROOT = process.cwd();
const ENV_PATH = path.resolve(REPO_ROOT, ".env");
if (fs.existsSync(ENV_PATH)) dotenv.config({ path: ENV_PATH });

const STATE_PATH = path.resolve(REPO_ROOT, "claim_monitor_state.json");
const LOG_PATH = path.resolve(REPO_ROOT, "claim_monitor.log");
const POLL_INTERVAL_MS = 60_000; // 60 seconds
const NTFY_TOPIC = process.env.CLAIM_MONITOR_NTFY_TOPIC || "Dino-claims-alerts-fpx";
const NTFY_SERVER = process.env.CLAIM_MONITOR_NTFY_SERVER || "https://ntfy.sh";
// iMessage fallback (only used if CLAIM_MONITOR_IMESSAGE_PHONE is set AND we're on macOS)
const IMESSAGE_PHONE = process.env.CLAIM_MONITOR_IMESSAGE_PHONE || "";
const ALERTED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // prune alerts older than 7 days

// ── Filter rules (derived from 2026-04-30 inbox scan) ────────────────────────

const HIGH_PRIORITY_SENDERS = new Set([
  "info@pcsadj.com",
  "newclaim@usclaimsolutions.co",
  "noreply@app.associatedadjusting.com",
  "crr2day@gmail.com",
]);

const HIGH_PRIORITY_DOMAINS = [
  "@usclaimsolutions.co",
  "@straightlineglobal.com",
];

const HIGH_SUBJECT_RE = /^(re:\s*)?new (claim )?assignment/i;
const HIGH_XACTWARE_RE = /^new .+ claim/i;
const SUPPLEMENT_RE = /supplement(al)?\s+(request|payment)/i;

const MEDIUM_XACTWARE_RE = /(Status Has Been Updated|Note Has Been Added|Reviewed with Exceptions)/i;
const MEDIUM_SLG_RE = /^re:\s*an assignment note/i;

function classify(fromHeader, subject) {
  const fromLower = (fromHeader || "").toLowerCase();
  const senderEmail = (fromLower.match(/<([^>]+)>/) || [null, fromLower])[1];

  // ── HIGH priority ────────────────────────────────────────────
  if (HIGH_PRIORITY_SENDERS.has(senderEmail)) return "HIGH";
  for (const dom of HIGH_PRIORITY_DOMAINS) {
    if (senderEmail.endsWith(dom)) return "HIGH";
  }
  if (senderEmail === "donotreply@xactware.com" && HIGH_XACTWARE_RE.test(subject)) return "HIGH";
  if (HIGH_SUBJECT_RE.test(subject)) return "HIGH";
  if (SUPPLEMENT_RE.test(subject)) return "HIGH";

  // ── MEDIUM priority ──────────────────────────────────────────
  if (senderEmail === "donotreply@xactware.com" && MEDIUM_XACTWARE_RE.test(subject)) return "MEDIUM";
  if (senderEmail === "claims@straightlineglobal.com" && MEDIUM_SLG_RE.test(subject)) return "MEDIUM";

  return null; // no match
}

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

// ── State (already-alerted message IDs) ──────────────────────────────────────

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { alerted: {}, started_at: Date.now() };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { alerted: {}, started_at: Date.now() };
  }
}

function saveState(state) {
  // Prune entries older than TTL
  const cutoff = Date.now() - ALERTED_TTL_MS;
  for (const [id, ts] of Object.entries(state.alerted)) {
    if (ts < cutoff) delete state.alerted[id];
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function loadCreds() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  const p = path.resolve(REPO_ROOT, "credentials.json");
  if (!fs.existsSync(p)) {
    throw new Error("Need GOOGLE_CREDENTIALS_JSON env var or credentials.json at repo root.");
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function loadToken() {
  if (process.env.GOOGLE_TOKEN_JSON) {
    return JSON.parse(process.env.GOOGLE_TOKEN_JSON);
  }
  const p = path.resolve(REPO_ROOT, "token.json");
  if (!fs.existsSync(p)) {
    throw new Error("Need GOOGLE_TOKEN_JSON env var or token.json at repo root.");
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function buildGmailClient() {
  const creds = loadCreds();
  const token = loadToken();
  const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  auth.setCredentials(token);
  return google.gmail({ version: "v1", auth });
}

// ── ntfy.sh push notification ────────────────────────────────────────────────

// HTTP headers must be ASCII. Strip emoji and other non-ASCII from anything
// going into a header (Title, Tags) — they go fine in the message body.
function asciiSafe(s) {
  return (s || "").replace(/[^\x00-\x7F]/g, "").trim();
}

async function sendNtfy({ title, message, priority = 3, tags = [] }) {
  const url = `${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`;
  // Move any emoji from the title into the message body so the title is ASCII-clean.
  const safeTitle = asciiSafe(title) || "Alert";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Title": safeTitle,
        "Priority": String(priority),
        "Tags": tags.map(asciiSafe).filter(Boolean).join(","),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: `${title}\n\n${message}`, // include the original (possibly emoji-laden) title in the body
    });
    if (!res.ok) {
      log(`ntfy POST failed: HTTP ${res.status}`);
    } else {
      log(`ntfy sent: ${safeTitle}`);
    }
  } catch (e) {
    log(`ntfy POST error: ${e.message}`);
  }
}

// ── iMessage send (optional, macOS only) ─────────────────────────────────────

function sendIMessage(text, recipient) {
  if (os.platform() !== "darwin") return; // silent skip
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  const script = `tell application "Messages" to send "${escaped}" to participant "${recipient}"`;
  const shellSafe = script.replace(/'/g, "'\\''");
  try {
    execSync(`osascript -e '${shellSafe}'`, { timeout: 10_000 });
    log(`iMessage sent to ${recipient}`);
  } catch (e) {
    log(`iMessage send failed: ${e.message}`);
  }
}

async function sendAlert({ title, message, priority, tags }) {
  // Primary: ntfy
  await sendNtfy({ title, message, priority, tags });
  // Optional secondary: iMessage if user has phone configured AND we're on macOS
  if (IMESSAGE_PHONE && os.platform() === "darwin") {
    sendIMessage(`${title}\n${message}`, IMESSAGE_PHONE);
  }
}

// ── Email body extraction ────────────────────────────────────────────────────

function extractBody(payload) {
  if (!payload) return "";
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  if (payload.parts) {
    return payload.parts.map(extractBody).join("\n");
  }
  return "";
}

function snippetFromBody(body, limit = 200) {
  return body
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim()
    .substring(0, limit);
}

// ── Main poll cycle ──────────────────────────────────────────────────────────

async function pollOnce(gmail, state) {
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "newer_than:1d",
    maxResults: 30,
  });
  const messages = list.data.messages || [];

  let scanned = 0;
  let alerted = 0;

  for (const m of messages) {
    if (state.alerted[m.id]) continue;
    scanned++;

    const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
    const headers = full.data.payload?.headers || [];
    const get = (name) => headers.find((h) => h.name === name)?.value || "";
    const fromHeader = get("From");
    const subject = get("Subject");
    const internalDate = parseInt(full.data.internalDate, 10);

    // Skip emails older than this script's start time, to avoid backfilling old inbox
    if (internalDate < state.started_at) {
      state.alerted[m.id] = Date.now(); // mark as seen so we never re-check
      continue;
    }

    const tier = classify(fromHeader, subject);
    if (!tier) {
      state.alerted[m.id] = Date.now(); // mark as seen
      continue;
    }

    // Match — build the alert
    const body = extractBody(full.data.payload);
    const snippet = snippetFromBody(body, 220);
    const isHigh = tier === "HIGH";
    const title = isHigh
      ? `🚨 NEW ASSIGNMENT — ${subject}`
      : `📋 Status update — ${subject}`;
    const message = `From: ${fromHeader}\n\n${snippet}\n\n[id: ${m.id}]`;
    const priority = isHigh ? 5 : 3; // ntfy: 5=urgent, 3=default
    const tags = isHigh ? ["rotating_light"] : ["clipboard"];

    log(`[${tier}] ${fromHeader} — ${subject}`);
    await sendAlert({ title, message, priority, tags });
    state.alerted[m.id] = Date.now();
    alerted++;
  }

  return { scanned, alerted };
}

async function main() {
  log("=== Claim monitor starting ===");
  log(`Polling every ${POLL_INTERVAL_MS / 1000}s`);
  log(`ntfy: ${NTFY_SERVER}/${NTFY_TOPIC}`);
  log(`iMessage fallback: ${IMESSAGE_PHONE && os.platform() === "darwin" ? `enabled to ${IMESSAGE_PHONE}` : "disabled"}`);

  const state = loadState();
  log(`State: ${Object.keys(state.alerted).length} previously-alerted IDs, started_at=${new Date(state.started_at).toISOString()}`);

  let gmail;
  try {
    gmail = buildGmailClient();
    log("Gmail client built OK");
  } catch (e) {
    log(`FATAL: cannot build Gmail client: ${e.message}`);
    process.exit(1);
  }

  // Send a startup ping so you know the monitor came up cleanly.
  await sendAlert({
    title: "🟢 Claim monitor started",
    message: "Watching the inbox every 60s. You'll get an alert when a new assignment lands.",
    priority: 3,
    tags: ["white_check_mark"],
  });

  while (true) {
    try {
      const { scanned, alerted } = await pollOnce(gmail, state);
      saveState(state);
      if (alerted > 0) log(`Cycle: scanned=${scanned}, alerted=${alerted}`);
      // else: stay quiet on no-op cycles to keep the log readable
    } catch (e) {
      log(`Poll error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

process.on("SIGINT", () => {
  log("=== Claim monitor stopped (SIGINT) ===");
  process.exit(0);
});

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
