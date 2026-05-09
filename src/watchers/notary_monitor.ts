/**
 * Notary inbox watcher (drupenterprise1@gmail.com).
 *
 * Polls the notary Gmail every 60s and fires ntfy alerts on the same
 * dino-claims-alerts-fpx topic. Selective by design: only two prefixes
 * surface, no general "you got mail" noise.
 *
 *   [NOTARY-AVAIL]  availability/scheduling inquiries from agencies or clients
 *                   ("are you available...", "open for a signing...", etc.)
 *   [NOTARY-DOC]    signing assignments / document deliveries — emails with
 *                   PDF attachments OR signing-related subject keywords
 *
 * Everything else (receipts, payment confirmations, agency newsletters,
 * Hakiel's own self-replies) drops silently.
 *
 * Same Railway process as claim_monitor.ts; uses the notary OAuth client
 * (getNotaryGmailClient) instead of the main hakiel.mcqueen one.
 */

import { google } from "googleapis";
import { getNotaryGmailClient } from "../auth/google-notary.js";

// Config
const POLL_INTERVAL_MS = 60_000;
const NTFY_TOPIC = process.env.NOTARY_MONITOR_NTFY_TOPIC || "dino-claims-alerts-fpx";
const NTFY_SERVER = process.env.NOTARY_MONITOR_NTFY_SERVER || "https://ntfy.sh";
const ALERTED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Tier classification rules
const AVAILABILITY_RE = /(availab|are you (free|open)|when (can|are|would) you|do you have time|interested in (a |the )?(signing|notar)|open for|can you do (a )?(signing|notar))/i;

const DOCUMENT_SUBJECT_RE = /(loan signing|signing assignment|signing request|loan document|signing package|borrower (doc|sign)|appointment (confirm|details)|signing details|new (loan )?signing|signing order|notary (assignment|order|request)|escrow (doc|signing))/i;

// Common signing-service / agency sender patterns. Useful as a hint that
// "we got something from a real agency" even when the subject is generic.
const KNOWN_NOTARY_AGENCY_DOMAINS = [
  "snapdocs.com",
  "signingorder.com",
  "notarycafe.com",
  "signingdirect.com",
  "nationalnotary.org",
  "247sclapp.com",       // 247 Signing Closer
  "signingproservices.com",
  "signnow.com",
];

// Skip rules
const MARKETING_SUBJECT_RE = /(% off|sale ends|ends in|trial ending|newsletter|webinar|don't miss|last chance|early bird|free trial|special offer|limited time)/i;
const NOREPLY_FROM_RE = /<\s*(no[-_]?reply|donotreply|notifications?|do-not-reply)@/i;

// Receipts / payment confirmations to skip — common subject keywords.
const RECEIPT_SUBJECT_RE = /(receipt|payment confirmation|invoice (paid|sent)|thank you for your payment|paid in full)/i;

type NotaryTier = "AVAIL" | "DOC" | null;

function extractEmailAddress(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

function isNoReply(fromHeader: string): boolean {
  const f = fromHeader.toLowerCase();
  if (/^(no[-_]?reply|donotreply|notifications?)@/i.test(f)) return true;
  if (NOREPLY_FROM_RE.test(f)) return true;
  return false;
}

function isMarketing(subject: string): boolean {
  return MARKETING_SUBJECT_RE.test(subject);
}

function isReceipt(subject: string): boolean {
  return RECEIPT_SUBJECT_RE.test(subject);
}

function isFromKnownAgency(fromHeader: string): boolean {
  const addr = extractEmailAddress(fromHeader);
  const at = addr.indexOf("@");
  if (at < 0) return false;
  const domain = addr.substring(at + 1);
  return KNOWN_NOTARY_AGENCY_DOMAINS.some(d => domain === d || domain.endsWith("." + d));
}

function classify(args: {
  fromHeader: string;
  subject: string;
  hasAttachment: boolean;
}): NotaryTier {
  const { fromHeader, subject, hasAttachment } = args;

  if (isMarketing(subject)) return null;
  if (isReceipt(subject)) return null;

  // Document tier: any email with a PDF/doc attachment from a non-noreply
  // sender, OR a subject that strongly signals signing assignment.
  const subjectSignalsDocs = DOCUMENT_SUBJECT_RE.test(subject);
  if (hasAttachment && !isNoReply(fromHeader)) return "DOC";
  if (subjectSignalsDocs) return "DOC";

  // Availability tier: subject/body asks about availability + sender looks
  // like a real human or a known agency mailbox.
  if (AVAILABILITY_RE.test(subject)) {
    if (!isNoReply(fromHeader) || isFromKnownAgency(fromHeader)) return "AVAIL";
  }

  return null;
}

// In-memory state
const alerted: Map<string, number> = new Map();
let started_at = 0;
let pollInFlight = false;

function pruneAlerted() {
  const cutoff = Date.now() - ALERTED_TTL_MS;
  for (const [id, ts] of alerted) {
    if (ts < cutoff) alerted.delete(id);
  }
}

// Body extraction — only used for snippet
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

function hasMeaningfulAttachment(payload: any): boolean {
  if (!payload) return false;
  // Recursive check: any part with a non-empty filename + attachmentId,
  // and the filename has a recognizable doc extension.
  function walk(p: any): boolean {
    if (!p) return false;
    const filename = (p.filename || "").toLowerCase();
    const hasAtt = Boolean(p.body?.attachmentId);
    if (filename && hasAtt && /\.(pdf|doc|docx|tif|tiff|jpg|jpeg|png|zip)$/.test(filename)) {
      return true;
    }
    if (Array.isArray(p.parts)) {
      return p.parts.some(walk);
    }
    return false;
  }
  return walk(payload);
}

function asciiSafe(s: string): string {
  return (s || "").replace(/[^\x00-\x7F]/g, "").trim();
}

async function sendNtfy(args: { title: string; message: string; priority?: number; tags?: string[] }) {
  const url = `${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`;
  const safeTitle = asciiSafe(args.title) || "Notary alert";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Title": safeTitle,
        "Priority": String(args.priority ?? 4),
        "Tags": (args.tags ?? []).map(asciiSafe).filter(Boolean).join(","),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: `${args.title}\n\n${args.message}`,
    });
    if (!res.ok) {
      console.error(`[notary-monitor] ntfy POST failed: HTTP ${res.status}`);
    }
  } catch (e: any) {
    console.error(`[notary-monitor] ntfy POST error: ${e?.message || e}`);
  }
}

async function pollOnce(): Promise<{ scanned: number; alerted: number }> {
  let scanned = 0;
  let alerts = 0;

  const auth = await getNotaryGmailClient();
  const gmail = google.gmail({ version: "v1", auth });

  // Same query shape as claim_monitor — last 24h, cap at 30. Notary inbox
  // volume is far lower so this is generous.
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "newer_than:1d -in:sent",
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

    // Skip pre-startup mail
    if (internalDate < started_at) {
      alerted.set(m.id, Date.now());
      continue;
    }

    // Skip self-sent (Hakiel's own outgoing replies that Gmail puts in All Mail)
    if (extractEmailAddress(fromHeader) === "drupenterprise1@gmail.com") {
      alerted.set(m.id, Date.now());
      continue;
    }

    const hasAttachment = hasMeaningfulAttachment(full.data.payload);
    const tier = classify({ fromHeader, subject, hasAttachment });

    if (!tier) {
      alerted.set(m.id, Date.now());
      continue;
    }

    const body = extractBody(full.data.payload);
    const snippet = snippetFromBody(body);

    const title = tier === "DOC"
      ? `[NOTARY-DOC] ${subject}`
      : `[NOTARY-AVAIL] ${subject}`;
    const message = `From: ${fromHeader}\n${hasAttachment ? "(has attachment)\n" : ""}\n${snippet}\n\n[id: ${m.id}]`;
    const priority = tier === "DOC" ? 5 : 4;
    const tags = tier === "DOC" ? ["page_facing_up"] : ["calendar"];

    console.log(`[notary-monitor] [${tier}] ${fromHeader} - ${subject}`);
    await sendNtfy({ title, message, priority, tags });
    alerted.set(m.id, Date.now());
    alerts++;
  }

  return { scanned, alerted: alerts };
}

export function startNotaryMonitor() {
  if (process.env.NOTARY_MONITOR_DISABLED === "1") {
    console.log("[notary-monitor] disabled via NOTARY_MONITOR_DISABLED=1");
    return;
  }

  started_at = Date.now();
  console.log(`[notary-monitor] starting - polling every ${POLL_INTERVAL_MS / 1000}s, ntfy: ${NTFY_SERVER}/${NTFY_TOPIC}`);

  sendNtfy({
    title: "Notary monitor started",
    message: "Watching drupenterprise1 every 60s. Pings only on availability inquiries and signing-document deliveries.",
    priority: 3,
    tags: ["white_check_mark"],
  }).catch(() => { /* swallow startup ping errors */ });

  setInterval(async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const { scanned, alerted: a } = await pollOnce();
      if (a > 0) console.log(`[notary-monitor] cycle: scanned=${scanned}, alerted=${a}`);
      pruneAlerted();
    } catch (e: any) {
      console.error(`[notary-monitor] poll error: ${e?.message || e}`);
    } finally {
      pollInFlight = false;
    }
  }, POLL_INTERVAL_MS);
}
