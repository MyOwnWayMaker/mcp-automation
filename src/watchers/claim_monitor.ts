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
import { runOrchestrator } from "./assignment_orchestrator.js";
import { getMatchableText } from "../util/email_text.js";

// ── Config ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000;
const NTFY_TOPIC = process.env.CLAIM_MONITOR_NTFY_TOPIC || "dino-claims-alerts-fpx";
const NTFY_SERVER = process.env.CLAIM_MONITOR_NTFY_SERVER || "https://ntfy.sh";
// The monitored mailbox itself. Outbound mail (sent items, drafts) from this
// address must never produce an alert — alerts are for INBOUND only.
const SELF_ADDRESS = (process.env.CLAIM_MONITOR_SELF_ADDRESS || "hakiel.mcqueen@erseville.com").toLowerCase();
const ALERTED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Per-call timeout for every external API the poll loop touches (Gmail,
// Gemini, ntfy, draft creation). 90s is forgiving for a slow Gemini call
// and still well under the 60s polling interval × 3 = 180s stall budget.
const EXTERNAL_CALL_TIMEOUT_MS = 90_000;
// Hard ceiling on pollInFlight. If a cycle hangs past this, the watchdog
// forcibly releases the guard so the next tick can proceed. Anything
// genuinely longer than this is a bug; the silent-5h-hang on 2026-05-19
// would have surfaced after 3 min instead of 5.5 hours.
const POLL_INFLIGHT_MAX_MS = 3 * 60 * 1000;
// Watchdog stall threshold: alert if no successful cycle in this long.
const WATCHDOG_STALL_MS = 3 * 60 * 1000;
// Throttle for repeated stall alerts so a long hang doesn't spam ntfy.
const WATCHDOG_REPEAT_MS = 30 * 60 * 1000;

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
  // IANet (IA Network). New assignments come from Assignments@ianetwork.net
  // with subject "New IAnet Assignment File ID: … | Claim Number: … |
  // Carrier: …". Captured from File ID 1395132 / claim R23723743 on
  // 2026-05-18. Sender-based so it fires [NEW] regardless of subject phrasing
  // (HIGH_RE's "new (claim )?assignment" does NOT match "New IAnet Assignment").
  "@ianetwork.net",
];

// HIGH_RE (formerly HIGH_SUBJECT_RE) is now applied to subject+body via
// getMatchableText. Broadened from the strict "^new claim assignment" anchor
// to also catch examiner cold-asks in the body like "Are you available to
// handle a new claim at <zip>" and "first contact within 24 hours" - the
// telltale phrases of an IA-firm new-assignment ping.
const HIGH_RE = /(^|\n)\s*(re:\s*)?new (claim )?assignment\b|\bnew claim\b|\bfirst contact (within|in)\b|\bare you available to (handle|take|cover)\b|\bcapacity for (a |an )?new\b|\binspection (request|needed|assignment)\b/i;
const HIGH_XACTWARE_RE = /^new .+ claim/i; // sender-specific, kept subject-only
const SUPPLEMENT_RE = /\bsupplement(al)?\s+(request|payment)\b|\bcan you supplement\b|\bsupplemental? (claim|estimate|needed|required)\b|\bneed (a |another )?supplement\b/i;

// An XA "Assignment Note Has Been Added" carrying a contractor/reconstruction
// estimate with a request to revise the carrier estimate is a SUPPLEMENT in
// Hakiel's taxonomy (it produces a supplement deliverable + a (supplement)
// Drive folder) — NOT a generic CORRECTION. CORRECTION_KEYWORD_RE matches the
// bare word "revise" and is checked first, so without this the Grove-type
// note (2026-05-15, claim KWSKWS26030053) silently tiered as [CORRECTION].
// This pattern is estimate-specific so it does NOT swallow genuine
// "revise the report/photos/narrative" corrections on a submitted report.
// Note the apostrophe class ['’] so "contractor's estimate" matches whether the
// body uses a straight (') or curly (’, from HTML &#8217;) apostrophe — XA
// notes are HTML and decode to curly quotes, which a bare `'` would miss.
const SUPP_ESTIMATE_RE = /\b(revise|review and revise|adjust|update)\b[^.\n]{0,40}\bestimate\b|\b(reconstruction|contractor['’]?s?|reconstruction repair) estimate\b|\bapproval of the attached\b[^.\n]{0,60}\bestimate\b|\bnotes? from the contractor\b/i;

// Natural-language supplement variants the estimate-specific pattern misses.
// XA "Assignment Note" emails describe supplements in plain prose that names
// neither "contractor estimate" nor "supplement request". Seen on Sean Thomas
// (2026-05-20, claim 12-1226000034): "I have received 2 estimates from insured
// … in addition to the supplement you wrote for us. Can you please review and
// advise." Covers: insured-submitted estimates, in-addition-to-a-prior-
// supplement, additional/another supplement, and additional-scope/work/items.
// Still gated on CLAIM_REF at the call site to avoid marketing false positives.
const SUPP_VARIANT_RE = new RegExp([
  /\bestimates?\b[^.\n]{0,30}\bfrom (the )?insured\b/.source,       // "estimates from insured"
  /\binsured(?:['’]s)?\b[^.\n]{0,25}\bestimates?\b/.source,          // "insured's estimate(s)"
  /\bin addition to\b[^.\n]{0,40}\bsupplement\b/.source,            // "in addition to the supplement"
  /\bsupplement\b[^.\n]{0,25}\byou (wrote|sent|submitted|did|created)\b/.source, // "supplement you wrote"
  /\b(additional|another|second|third|new|further)\b[^.\n]{0,20}\bsupplement\b/.source,
  /\b(additional|added|new|extra|increased|supplemental)\b[^.\n]{0,20}\b(scope|work|items|line items|repairs?|estimate)\b/.source,
  /\bscope\b[^.\n]{0,15}\b(addition|increase|change|added|expansion)\b/.source,
].join("|"), "i");

// Re-inspection: examiner advisory variant ("re-inspection necessary"), or
// explicit reinspection-request phrasing. Note the optional hyphen/space.
const REINSP_RE = /\bre[\s-]?inspection (necessary|needed|required|requested)\b|\bre[\s-]?inspect (the|this|that)\b|\bif a re[\s-]?inspection\b|\brequest(ing)? (a |another )?re[\s-]?inspection\b/i;

const CORRECTION_KEYWORD_RE = /\b(correction|revis(e|ion|ed|ing)|clarif(y|ication|ied)|rework|redo and resubmit|kindly correct|please correct|please update|asked (us )?to (revise|redo|correct))\b/i;
// Was /\b(claim|file)\s*[#:]?\s*[\w-]{4,}\b/i — the single optional [#:]?
// could not span XactAnalysis's "Claim #:" (both '#' AND ':' plus spaces),
// so XA assignment-note emails NEVER satisfied CLAIM_REF and always fell
// through SUPP/CORRECTION to MEDIUM/[STATUS]. That is the true reason the
// Grove supplement (2026-05-15) silently fell through. Now tolerates
// "Claim #:", "Claim#", "File No.:", "File Number -", etc.
const CLAIM_REF_RE = /\b(claim|file)\s*(?:no\.?|number)?[\s#:.\-]*[\w-]{4,}\b/i;

const MEDIUM_XACTWARE_RE = /(Status Has Been Updated|Note Has Been Added|Reviewed with Exceptions)/i;
const MEDIUM_SLG_RE = /^re:\s*an assignment note/i;

export type Tier = "HIGH" | "CORRECTION" | "SUPP" | "REINSP" | "MEDIUM" | null;

// Exported so dry-run scripts and tests can exercise the same classifier
// the watcher uses. Subject + body are concatenated upstream via
// getMatchableText; this function expects the already-combined text.
export function classify(args: {
  fromHeader: string;
  subject: string;
  matchableText: string;
}): Tier {
  const { fromHeader, subject, matchableText } = args;
  const fromLower = (fromHeader || "").toLowerCase();
  const senderEmail = (fromLower.match(/<([^>]+)>/) || [null, fromLower])[1] as string;

  // Supplemental-estimate requests (contractor/reconstruction estimate +
  // "revise the estimate") are SUPP, not CORRECTION — checked first so the
  // broad "revise" in CORRECTION_KEYWORD_RE doesn't capture them. Still
  // gated on CLAIM_REF to avoid marketing false positives.
  if ((SUPP_ESTIMATE_RE.test(matchableText) || SUPP_VARIANT_RE.test(matchableText)) && CLAIM_REF_RE.test(matchableText)) {
    return "SUPP";
  }

  // CORRECTION before everything else - "please revise" wins over "new
  // claim" if both phrases somehow co-occur.
  if (CORRECTION_KEYWORD_RE.test(matchableText) && CLAIM_REF_RE.test(matchableText)) {
    return "CORRECTION";
  }

  // SUPP and REINSP are also gated on CLAIM_REF presence to avoid false
  // positives from generic "we recently updated our supplement policy"
  // marketing or "needs reinspection" in unrelated contexts.
  if (SUPPLEMENT_RE.test(matchableText) && CLAIM_REF_RE.test(matchableText)) {
    return "SUPP";
  }
  if (REINSP_RE.test(matchableText) && CLAIM_REF_RE.test(matchableText)) {
    return "REINSP";
  }

  // HIGH path - sender-based detection first (works regardless of body),
  // then content-based on subject+body.
  if (HIGH_PRIORITY_SENDERS.has(senderEmail)) return "HIGH";
  for (const dom of HIGH_PRIORITY_DOMAINS) {
    if (senderEmail.endsWith(dom)) return "HIGH";
  }
  if (senderEmail === "donotreply@xactware.com" && HIGH_XACTWARE_RE.test(subject)) return "HIGH";
  if (HIGH_RE.test(matchableText)) return "HIGH";

  // MEDIUM stays subject + sender only. These are XactAnalysis system
  // notifications and SLG note threads - the relevant signal is in the
  // subject line alone, body scanning would just add noise.
  if (senderEmail === "donotreply@xactware.com" && MEDIUM_XACTWARE_RE.test(subject)) return "MEDIUM";
  if (senderEmail === "claims@straightlineglobal.com" && MEDIUM_SLG_RE.test(subject)) return "MEDIUM";

  return null;
}

// ── In-memory state ─────────────────────────────────────────────────────────

const alerted: Map<string, number> = new Map(); // msg ID -> timestamp
let started_at = 0;
let pollInFlight = false;
let pollInFlightSince = 0;
let lastSuccessfulCycleAt = 0;
let lastStallAlertAt = 0;

// ── External-call timeout helper ────────────────────────────────────────────

// Race a promise against a hard timeout. On timeout, the original promise is
// not actually cancelled (we can't reach into googleapis to kill the in-flight
// request), but the await unblocks so pollInFlight gets released. The dangling
// promise then resolves into the void without harm. This is the smallest fix
// that eliminates the silent-hang failure mode without rewriting every caller
// to thread AbortControllers through.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout ${ms}ms in ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function pruneAlerted() {
  const cutoff = Date.now() - ALERTED_TTL_MS;
  for (const [id, ts] of alerted) {
    if (ts < cutoff) alerted.delete(id);
  }
}

// ── Body extraction ─────────────────────────────────────────────────────────

// XactAnalysis-style notification emails ALWAYS arrive from
// donotreply@xactware.com but quote the actual human sender + CCs in the body
// using forward-style headers ("From: ...", "Cc: ...", etc.). Replying to
// donotreply@ bounces, so for these emails we surface the real sender so the
// drafter can reply to the human directly via regular Gmail.
function extractEmbeddedFrom(body: string): { from: string | null; cc: string | null } {
  // Use only the first 4 KB of body — the embedded headers are at the top.
  const head = body.slice(0, 4000);
  const fromMatch = head.match(/^\s*From:\s*(.+?)\s*$/im);
  const ccMatch = head.match(/^\s*Cc:\s*(.+?)\s*$/im);
  const fromValue = fromMatch ? fromMatch[1].trim() : null;
  const ccValue = ccMatch ? ccMatch[1].trim() : null;
  return { from: fromValue, cc: ccValue };
}

// Build a Reply-All cc list: original Cc + original To addresses minus self.
// Returns comma-separated string or null if nothing.
function buildReplyAllCc(args: {
  originalTo: string;
  originalCc: string;
  self: string;
  primaryRecipient: string; // the address we're putting in `To:` (excluded from Cc)
}): string | null {
  const { originalTo, originalCc, self, primaryRecipient } = args;
  const selfLower = (self || "").toLowerCase();
  const primaryLower = (primaryRecipient || "").toLowerCase();
  const primaryEmail = (primaryLower.match(/<([^>]+)>/) || [null, primaryLower])[1] as string;

  const seen = new Set<string>();
  const out: string[] = [];

  const collect = (raw: string) => {
    if (!raw) return;
    // Split on commas but be tolerant of "Name, Lastname <addr>" patterns by
    // also looking for the "<addr>" form. Simpler: split on commas + trim.
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const email = ((trimmed.match(/<([^>]+)>/) || [null, trimmed])[1] as string).toLowerCase().trim();
      if (!email) continue;
      if (email === selfLower) continue;
      if (email === primaryEmail) continue;
      if (seen.has(email)) continue;
      seen.add(email);
      out.push(trimmed);
    }
  };

  collect(originalTo);
  collect(originalCc);
  return out.length ? out.join(", ") : null;
}

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
    const res = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          "Title": safeTitle,
          "Priority": String(args.priority ?? 3),
          "Tags": (args.tags ?? []).map(asciiSafe).filter(Boolean).join(","),
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: `${args.title}\n\n${args.message}`,
      }),
      EXTERNAL_CALL_TIMEOUT_MS,
      "ntfy.POST",
    );
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

  // -in:sent -in:drafts -in:chats keeps outbound mail (Hakiel's own replies
  // and unsent drafts) out of the scan entirely. Without this, gmail.list
  // over userId:me returns SENT + DRAFT messages too, which is exactly how
  // outbound replies were leaking into [CORRECTION]/[IMPORTANT] alerts and
  // even getting auto-drafted replies. Mirrors notary_monitor's query.
  const list = await withTimeout(
    gmail.users.messages.list({
      userId: "me",
      q: "newer_than:1d -in:sent -in:drafts -in:chats",
      maxResults: 30,
    }),
    EXTERNAL_CALL_TIMEOUT_MS,
    "gmail.messages.list",
  );
  const messages = list.data.messages || [];

  for (const m of messages) {
    if (!m.id) continue;
    if (alerted.has(m.id)) continue;
    scanned++;

    const full = await withTimeout(
      gmail.users.messages.get({ userId: "me", id: m.id, format: "full" }),
      EXTERNAL_CALL_TIMEOUT_MS,
      `gmail.messages.get(${m.id})`,
    );
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

    // Belt-and-suspenders: even with -in:sent -in:drafts on the query, skip
    // anything whose From is the monitored mailbox itself (loopback / send-to-
    // self / list reflections). Outbound never alerts.
    const senderAddr = (fromHeader.match(/<([^>]+)>/)?.[1] || fromHeader).trim().toLowerCase();
    if (senderAddr === SELF_ADDRESS) {
      alerted.set(m.id, Date.now());
      continue;
    }

    const body = extractBody(full.data.payload);
    // XA "Assignment Note Has Been Added" emails carry the entire note (often a
    // forwarded examiner thread) in the body. Quote-stripping would delete that
    // note, and the 1000-char default can truncate before the supplement signal
    // — both of which silently demoted real supplements to [STATUS]. For
    // xactware notifications, scan the full note (no quote-strip, larger window).
    const isXactware = senderAddr === "donotreply@xactware.com";
    const matchableText = getMatchableText(
      { subject, payload: full.data.payload },
      isXactware ? { stripQuotes: false, charLimit: 4000 } : undefined,
    );
    const tier = classify({ fromHeader, subject, matchableText });

    // If no adjuster-pattern match, try the general "outside the adjuster
    // path" importance classifier. This catches grant-writer, tax/CPA, legal,
    // banking, regulatory, and personally-important emails that don't match
    // any of the existing tag patterns. Fires [IMPORTANT][category] alerts.
    if (!tier) {
      const dateHeader = get("Date");
      const messageIdHeader = get("Message-ID") || get("Message-Id") || get("message-id");
      const toHeader = get("To");
      const ccHeader = get("Cc");
      const hasUnsubscribe = headers.some(h => /^list-unsubscribe$/i.test(h.name || ""));

      // XA notification emails are sent from donotreply@xactware.com but the
      // ACTUAL human author is in the body's forward-style "From:" line.
      // Replying to donotreply@ bounces — we need the real person.
      let primaryRecipient = fromHeader;
      let extraCcFromBody: string | null = null;
      if (senderAddr === "donotreply@xactware.com") {
        const embedded = extractEmbeddedFrom(body);
        if (embedded.from) {
          primaryRecipient = embedded.from;
          extraCcFromBody = embedded.cc;
          console.log(`[claim-monitor] xactware notification — replying to embedded sender ${embedded.from}`);
        }
      }

      // Reply-All by default: take original To + Cc (and any embedded Cc from
      // XA-style notifications), remove self + the primary reply target, and
      // CC the rest. Matches Hakiel's "always reply-all" rule.
      const replyAllCc = buildReplyAllCc({
        originalTo: toHeader,
        originalCc: [ccHeader, extraCcFromBody].filter(Boolean).join(", "),
        self: SELF_ADDRESS,
        primaryRecipient,
      });

      try {
        const verdict = await withTimeout(
          classifyImportant({
            from: fromHeader,
            subject,
            date: dateHeader,
            body,
            has_unsubscribe: hasUnsubscribe,
          }),
          EXTERNAL_CALL_TIMEOUT_MS,
          "classifyImportant",
        );
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
              const result = await withTimeout(
                createImportantDraft({
                  thread_id: full.data.threadId,
                  in_reply_to_message_id: messageIdHeader,
                  reply_to_address: primaryRecipient,
                  cc_addresses: replyAllCc || undefined,
                  original_subject: subject,
                  reply_body: replyText,
                  category: verdict.category,
                  source_email_id: m.id,
                }),
                EXTERNAL_CALL_TIMEOUT_MS,
                "createImportantDraft",
              );
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

    // Tier -> ntfy prefix + priority + tag mapping. HIGH stays priority 5
    // (action required); SUPP/REINSP/CORRECTION are also priority 5 since
    // they imply a deliverable; MEDIUM stays priority 3 (informational).
    let title: string;
    let priority: number;
    let tags: string[];
    switch (tier) {
      case "CORRECTION":
        title = `[CORRECTION] ${subject}`;
        priority = 5;
        tags = ["pencil2"];
        break;
      case "SUPP":
        title = `[SUPP] ${subject}`;
        priority = 5;
        tags = ["heavy_plus_sign"];
        break;
      case "REINSP":
        title = `[REINSP] ${subject}`;
        priority = 5;
        tags = ["mag"];
        break;
      case "HIGH":
        title = `[NEW] ${subject}`;
        priority = 5;
        tags = ["rotating_light"];
        break;
      case "MEDIUM":
      default:
        title = `[STATUS] ${subject}`;
        priority = 3;
        tags = ["clipboard"];
        break;
    }
    const message = `From: ${fromHeader}\n\n${snippet}\n\n[id: ${m.id}]`;

    console.log(`[claim-monitor] [${tier}] ${fromHeader} - ${subject}`);
    await sendNtfy({ title, message, priority, tags });

    // Fire the orchestrator scaffold for new assignments / supplements /
    // reinspections. Fire-and-forget — never blocks the alert path, never
    // throws into the caller. Inside it parses metadata, creates the Drive
    // folder (idempotent), geocodes + classifies the loss address, and
    // pushes a second "[ORCH][...]" ntfy with all the details Hakiel needs
    // to act. CORRECTION + MEDIUM tiers don't trigger the orchestrator —
    // they're already-existing claims being updated, not new work.
    if (tier === "HIGH" || tier === "SUPP" || tier === "REINSP") {
      runOrchestrator({
        tier,
        fromHeader,
        subject,
        body,
        msgId: m.id,
        threadId: full.data.threadId ?? undefined,
      }).catch((e: any) => {
        console.error(`[orchestrator] runOrchestrator threw: ${e?.message || e}`);
      });
    }

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

  lastSuccessfulCycleAt = started_at;

  // Run pollOnce on a setInterval. Reentrancy guard via pollInFlight + a hard
  // ceiling (POLL_INFLIGHT_MAX_MS) so a single hung cycle can never lock the
  // watcher out for hours like it did on 2026-05-19 (5.5h silent silence
  // after a hung Gmail/Gemini call).
  setInterval(async () => {
    // Hard re-entrancy ceiling: if a cycle has been "in flight" for too long
    // it's almost certainly stuck on an external call that never resolved.
    // Force-release the guard so the next tick can proceed (the old await
    // may still be hanging out somewhere but that's not our problem now).
    if (pollInFlight && pollInFlightSince > 0 && Date.now() - pollInFlightSince > POLL_INFLIGHT_MAX_MS) {
      console.error(`[claim-monitor] re-entrancy ceiling hit: cycle has been in-flight ${(Date.now() - pollInFlightSince) / 1000}s — force-releasing guard`);
      pollInFlight = false;
      pollInFlightSince = 0;
    }
    if (pollInFlight) return;
    pollInFlight = true;
    pollInFlightSince = Date.now();
    try {
      const { scanned, alerted: a } = await pollOnce();
      if (a > 0) console.log(`[claim-monitor] cycle: scanned=${scanned}, alerted=${a}`);
      pruneAlerted();
      lastSuccessfulCycleAt = Date.now();
    } catch (e: any) {
      console.error(`[claim-monitor] poll error: ${e?.message || e}`);
    } finally {
      pollInFlight = false;
      pollInFlightSince = 0;
    }
  }, POLL_INTERVAL_MS);

  // Watchdog: independent timer that fires a [STALL] ntfy if no successful
  // cycle completed within WATCHDOG_STALL_MS. Throttled to one alert per
  // WATCHDOG_REPEAT_MS so a long hang doesn't spam.
  setInterval(() => {
    const gap = Date.now() - lastSuccessfulCycleAt;
    if (gap < WATCHDOG_STALL_MS) return;
    if (Date.now() - lastStallAlertAt < WATCHDOG_REPEAT_MS) return;
    lastStallAlertAt = Date.now();
    const minutes = Math.round(gap / 60000);
    console.error(`[claim-monitor] WATCHDOG STALL: no successful cycle in ${minutes}m (pollInFlight=${pollInFlight})`);
    sendNtfy({
      title: "[STALL] claim-monitor watchdog",
      message: `No successful cycle in ${minutes} minutes. pollInFlight=${pollInFlight}. Check Railway logs for hung external calls.`,
      priority: 5,
      tags: ["warning"],
    }).catch(() => { /* swallow */ });
  }, 60_000);

  // Daily reconciliation: at 23:55 PT (06:55 UTC) check the inbox for HIGH-
  // tier emails received in the last 24h and surface any that aren't in the
  // alerted set. Independent of the live polling — if the watcher itself was
  // broken, this is the safety net.
  scheduleDailyReconciliation();
}

// ── Daily reconciliation ────────────────────────────────────────────────────

function nextReconcileDelayMs(): number {
  // Fire at 23:55 PT = 06:55 UTC the next day.
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(6, 55, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - now.getTime();
}

async function runDailyReconciliation(): Promise<void> {
  try {
    console.log("[claim-monitor] daily reconciliation starting");
    const auth = await getGoogleAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    const list = await withTimeout(
      gmail.users.messages.list({
        userId: "me",
        q: "newer_than:1d -in:sent -in:drafts -in:chats",
        maxResults: 100,
      }),
      EXTERNAL_CALL_TIMEOUT_MS,
      "reconcile.gmail.list",
    );
    const messages = list.data.messages || [];

    type Miss = { from: string; subject: string; id: string; receivedAt: string };
    const misses: Miss[] = [];

    for (const m of messages) {
      if (!m.id) continue;
      if (alerted.has(m.id)) continue;
      const full = await withTimeout(
        gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] }),
        EXTERNAL_CALL_TIMEOUT_MS,
        `reconcile.gmail.get(${m.id})`,
      );
      const headers = full.data.payload?.headers || [];
      const get = (name: string) => headers.find(h => h.name === name)?.value || "";
      const fromHeader = get("From");
      const subject = get("Subject");
      const senderEmail = (fromHeader.toLowerCase().match(/<([^>]+)>/) || [null, fromHeader.toLowerCase()])[1] as string;

      const isHigh =
        HIGH_PRIORITY_SENDERS.has(senderEmail) ||
        HIGH_PRIORITY_DOMAINS.some(d => senderEmail.endsWith(d));
      if (!isHigh) continue;
      if (senderEmail === SELF_ADDRESS) continue;

      const internalDate = parseInt(full.data.internalDate || "0", 10);
      misses.push({
        from: fromHeader,
        subject,
        id: m.id,
        receivedAt: new Date(internalDate).toISOString(),
      });
    }

    if (misses.length === 0) {
      console.log("[claim-monitor] daily reconciliation: 0 missed HIGH emails in last 24h ✓");
      return;
    }

    console.log(`[claim-monitor] daily reconciliation: ${misses.length} missed HIGH email(s)`);
    const lines = misses.map(m => `• ${m.receivedAt} ${m.from} — ${m.subject} [id:${m.id}]`);
    await sendNtfy({
      title: `[MISSED] ${misses.length} HIGH email(s) not alerted`,
      message: `Reconciliation found HIGH-tier emails in the last 24h that never fired a [NEW] alert:\n\n${lines.join("\n")}\n\nLikely watcher was stalled during their arrival.`,
      priority: 5,
      tags: ["mag_right"],
    });
  } catch (e: any) {
    console.error(`[claim-monitor] daily reconciliation error: ${e?.message || e}`);
  }
}

function scheduleDailyReconciliation() {
  const delay = nextReconcileDelayMs();
  console.log(`[claim-monitor] daily reconciliation scheduled in ${Math.round(delay / 60000)}m (next 23:55 PT)`);
  setTimeout(() => {
    runDailyReconciliation().finally(() => {
      // Reschedule for the next 24h cycle.
      setInterval(() => {
        runDailyReconciliation().catch(() => { /* swallow */ });
      }, 24 * 60 * 60 * 1000);
    });
  }, delay);
}
