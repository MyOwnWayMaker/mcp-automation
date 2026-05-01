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
const ALERT_RECIPIENT = process.env.CLAIM_MONITOR_PHONE || "+14244663685";
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

// ── iMessage send ────────────────────────────────────────────────────────────

function sendIMessage(text, recipient) {
  if (os.platform() !== "darwin") {
    log(`[SKIP iMessage on ${os.platform()}] would have sent to ${recipient}: ${text.substring(0, 100)}...`);
    return;
  }
  // Escape for AppleScript: backslashes, double quotes, newlines
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  const script = `tell application "Messages" to send "${escaped}" to participant "${recipient}"`;
  // Use single quotes around the script, escape any single quotes in the script
  const shellSafe = script.replace(/'/g, "'\\''");
  try {
    execSync(`osascript -e '${shellSafe}'`, { timeout: 10_000 });
    log(`iMessage sent to ${recipient}`);
  } catch (e) {
    log(`iMessage send failed: ${e.message}`);
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
    const prefix = tier === "HIGH" ? "🚨 NEW ASSIGNMENT" : "📋 STATUS UPDATE";
    const text = `${prefix}\nFrom: ${fromHeader}\nSubject: ${subject}\n\n${snippet}\n\n[id: ${m.id}]`;

    log(`[${tier}] ${fromHeader} — ${subject}`);
    sendIMessage(text, ALERT_RECIPIENT);
    state.alerted[m.id] = Date.now();
    alerted++;
  }

  return { scanned, alerted };
}

async function main() {
  log("=== Claim monitor starting ===");
  log(`Polling every ${POLL_INTERVAL_MS / 1000}s, alerting to ${ALERT_RECIPIENT}`);
  log(`Platform: ${os.platform()} (iMessage will ${os.platform() === "darwin" ? "fire" : "be skipped"})`);

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
