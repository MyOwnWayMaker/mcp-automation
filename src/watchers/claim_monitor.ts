/**
 * Claim assignment monitor — runs INSIDE the deployed MCP server on Railway.
 *
 * Replaces scripts/claim-monitor.mjs which previously had to run as a
 * standalone Node process on Hakiel's Mac mini. The Mac path was unreliable
 * (silently dies on OOM, doesn't survive reboots without LaunchAgent install,
 * blocked by Xcode CLT prereqs on a low-disk Mac). Hosting the polling loop
 * in the MCP server itself fixes all of those by inheriting Railway's uptime.
 *
 * Polls hakiel.mcqueen@erseville.com every 60s. Classifies new emails as:
 *   HIGH        new claim assignments (USCS / PCAS / XactAnalysis / SLG / etc.)
 *   CORRECTION  carrier/firm asking for revision/clarification on a submitted report
 *   MEDIUM      status updates / note additions on existing claims
 * Fires ntfy push on a match. Tracks alerted message IDs in memory (so a
 * server restart re-checks recent emails — that's fine since the started_at
 * cutoff prevents backfilling old inbox).
 *
 * State (alerted message IDs) lives in process memory only. Acceptable
 * because Railway's auto-redeploy is rare and the state-loss-on-restart cost
 * is minimal: at worst, the watcher re-fires alerts for emails received
 * between the previous boot and now, which the alerted-set quickly catches up.
 */

import { google } from "googleapis";
import { getGoogleAuthClient } from "../auth/google.js";
import { classifyImportant, buildImportantNtfyPayload } from "./important_classifier.js";
import { createImportantDraft } from "./important_drafter.js";

// ── Config ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000;
const NTFY_TOPIC = process.env.CLAIM_MONITOR_NTFY_TOPIC || "dino-claims-alerts-fpx";
const NTFY_SERVER = process.env.CLAIM_MONITOR_NTFY_SERVER || "https://ntfy.sh";
const ALERTED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Filter rules (mirror scripts/claim-monitor.mjs — keep these in sync) ────

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

const CORRECTION_KEYWORD_RE = /\b(correction|revis(e|ion|ed)|clarif(y|ication)|rework|kindly correct|please correct|please update)\b/i;
const CLAIM_REF_RE = /\b(claim|file)\s*[#:]?\s*[\w-]{4,}\b/i;

const MEDIUM_XACTWARE_RE = /(Status Has Been Updated|Note Has Been Added|Reviewed with Exceptions)/i;
const MEDIUM_SLG_RE = /^re:\s*an assignment note/i;

type Tier = "HIGH" | "CORRECTION" | "MEDIUM" | null;

function classify(fromHeader: string, subject: string): Tier {
  const fromLower = (fromHeader || "").toLowerCase();
  const senderEmail = (fromLower.match(/<([^>]+)>/) || [null, fromLower])[1] as string;

  // CORRECTION before HIGH so a "Re: claim 12-1226 please revise" reply from
  // a known firm domain routes correctly.
  if (CORRECTION_KEYWORD_RE.test(subject) && CLAIM_REF_RE.test(subject)) {
    return "CORRECTION";
  }

  if (HIGH_PRIORITY_SENDERS.has(senderEmail)) return "HIGH";
  for (const dom of HIGH_PRIORITY_DOMAINS) {
    if (senderEmail.endsWith(dom)) return "HIGH";
  }
  if (senderEmail === "donotreply@xactware.com" && HIGH_XACTWARE_RE.test(subject)) return "HIGH";
  if (HIGH_SUBJECT_RE.test(subject)) return "HIGH";
  if (SUPPLEMENT_RE.test(subject)) return "HIGH";

  if (senderEmail === "donotreply@xactware.com" && MEDIUM_XACTWARE_RE.test(subject)) return "MEDIUM";
  if (senderEmail === "claims@straightlineglobal.com" && MEDIUM_SLG_RE.test(subject)) return "MEDIUM";

  return null;
}

// ── In-memory state ─────────────────────────────────────────────────────────

const alerted: Map<string, number> = new Map(); // msg ID -> timestamp
let started_at = 0;
let pollInFlight = false;

function pruneAlerted() {
  const cutoff = Date.now() - ALERTED_TTL_MS;
  for (const [id, ts] of alerted) {
    if (ts < cutoff) alerted.delete(id);
  }
}

// ── Body extraction ─────────────────────────────────────────────────────────

function extractBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  if (Array.isArray(payload.parts)) {
    return payload.parts.map(extractBody).join("\n");
  }
  return "";
}

function snippetFromBody(body: string, limit = 220): string {
  return body
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim()
    .substring(0, limit);
}

// ── ntfy push ───────────────────────────────────────────────────────────────

function asciiSafe(s: string): string {
  return (s || "").replace(/[^\x00-\x7F]/g, "").trim();
}

async function sendNtfy(args: { title: string; message: string; priority?: number; tags?: string[] }) {
  const url = `${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`;
  const safeTitle = asciiSafe(args.title) || "Alert";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Title": safeTitle,
        "Priority": String(args.priority ?? 3),
        "Tags": (args.tags ?? []).map(asciiSafe).filter(Boolean).join(","),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: `${args.title}\n\n${args.message}`,
    });
    if (!res.ok) {
      console.error(`[claim-monitor] ntfy POST failed: HTTP ${res.status}`);
    }
  } catch (e: any) {
    console.error(`[claim-monitor] ntfy POST error: ${e?.message || e}`);
  }
}

// ── Poll cycle ──────────────────────────────────────────────────────────────

async function pollOnce(): Promise<{ scanned: number; alerted: number }> {
  let scanned = 0;
  let alerts = 0;

  const auth = await getGoogleAuthClient();
  const gmail = google.gmail({ version: "v1", auth });

  const list = await gmail.users.messages.list({
    userId: "me",
    q: "newer_than:1d",
    maxResults: 30,
  });
  const messages = list.data.messages || [];

  for (const m of messages) {
    if (!m.id) continue;
    if (alerted.has(m.id)) continue;
    scanned++;

    const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
    const headers = full.data.payload?.headers || [];
    const get = (name: string) => headers.find(h => h.name === name)?.value || "";
    const fromHeader = get("From");
    const subject = get("Subject");
    const internalDate = parseInt(full.data.internalDate || "0", 10);

    // Skip emails older than the watcher's started_at (avoids backfilling old
    // inbox on first run / after a Railway redeploy).
    if (internalDate < started_at) {
      alerted.set(m.id, Date.now());
      continue;
    }

    const tier = classify(fromHeader, subject);
    const body = extractBody(full.data.payload);

    // If no adjuster-pattern match, try the general "outside the adjuster
    // path" importance classifier. This catches grant-writer, tax/CPA, legal,
    // banking, regulatory, and personally-important emails that don't match
    // any of the existing tag patterns. Fires [IMPORTANT][category] alerts.
    if (!tier) {
      const dateHeader = get("Date");
      const messageIdHeader = get("Message-ID") || get("Message-Id") || get("message-id");
      const ccHeader = get("Cc");
      const hasUnsubscribe = headers.some(h => /^list-unsubscribe$/i.test(h.name || ""));
      try {
        const verdict = await classifyImportant({
          from: fromHeader,
          subject,
          date: dateHeader,
          body,
          has_unsubscribe: hasUnsubscribe,
        });
        if (verdict) {
          // Try to draft a Gmail reply (skipped if Hakiel replied recently or
          // the LLM returned no reply text). Best-effort — never block the alert.
          let draft_status: "drafted" | "skipped_active_thread" | "failed" | "no_reply_text" | null = null;
          let draft_reason: string | undefined;

          const replyText = (verdict.suggested_reply || "").trim();
          if (!replyText) {
            draft_status = "no_reply_text";
          } else if (full.data.threadId && messageIdHeader) {
            try {
              const result = await createImportantDraft({
                thread_id: full.data.threadId,
                in_reply_to_message_id: messageIdHeader,
                reply_to_address: fromHeader,
                cc_addresses: ccHeader || undefined,
                original_subject: subject,
                reply_body: replyText,
                category: verdict.category,
                source_email_id: m.id,
              });
              draft_status = result.status;
              draft_reason = result.reason;
            } catch (e: any) {
              draft_status = "failed";
              draft_reason = String(e?.message || e);
              console.error(`[claim-monitor] draft create threw: ${draft_reason}`);
            }
          }

          const { title, message } = buildImportantNtfyPayload({
            from: fromHeader,
            subject,
            verdict,
            draft_status,
            draft_reason,
          });
          const fullMessage = `${message}\n\n[id: ${m.id}]`;
          await sendNtfy({
            title,
            message: fullMessage,
            priority: 5,
            tags: ["bell"],
          });
          console.log(`[claim-monitor] [IMPORTANT/${verdict.category}] draft=${draft_status || "n/a"} — ${fromHeader} — ${subject}`);
          alerts++;
        }
      } catch (e: any) {
        console.error(`[claim-monitor] importance classifier error: ${e?.message || e}`);
      }
      alerted.set(m.id, Date.now());
      continue;
    }

    const snippet = snippetFromBody(body);

    const isCorrection = tier === "CORRECTION";
    const isHigh = tier === "HIGH" || isCorrection;
    const title = isCorrection
      ? `[CORRECTION] ${subject}`
      : isHigh
        ? `[NEW] ${subject}`
        : `[STATUS] ${subject}`;
    const message = `From: ${fromHeader}\n\n${snippet}\n\n[id: ${m.id}]`;
    const priority = isHigh ? 5 : 3;
    const tags = isCorrection ? ["pencil2"] : isHigh ? ["rotating_light"] : ["clipboard"];

    console.log(`[claim-monitor] [${tier}] ${fromHeader} — ${subject}`);
    await sendNtfy({ title, message, priority, tags });
    alerted.set(m.id, Date.now());
    alerts++;
  }

  return { scanned, alerted: alerts };
}

// ── Public start ────────────────────────────────────────────────────────────

export function startClaimMonitor() {
  // Allow disabling via env var (useful for local dev / testing).
  if (process.env.CLAIM_MONITOR_DISABLED === "1") {
    console.log("[claim-monitor] disabled via CLAIM_MONITOR_DISABLED=1");
    return;
  }

  started_at = Date.now();
  console.log(`[claim-monitor] starting — polling every ${POLL_INTERVAL_MS / 1000}s, ntfy: ${NTFY_SERVER}/${NTFY_TOPIC}`);

  // Kick off a startup ping so Hakiel knows the watcher is alive after every
  // Railway redeploy. Async + best-effort — doesn't block server startup.
  sendNtfy({
    title: "Claim monitor started",
    message: "Watching the inbox every 60s. You'll get an alert when a new assignment / supplement / correction email lands.",
    priority: 3,
    tags: ["white_check_mark"],
  }).catch(() => { /* swallow startup ping errors */ });

  // Run pollOnce on a setInterval. Single-fire reentrancy guard via
  // pollInFlight to prevent overlap if a poll takes >60s (unlikely but safe).
  setInterval(async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const { scanned, alerted: a } = await pollOnce();
      if (a > 0) console.log(`[claim-monitor] cycle: scanned=${scanned}, alerted=${a}`);
      pruneAlerted();
    } catch (e: any) {
      console.error(`[claim-monitor] poll error: ${e?.message || e}`);
    } finally {
      pollInFlight = false;
    }
  }, POLL_INTERVAL_MS);
}
