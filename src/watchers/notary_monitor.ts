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
import { createPickfordDraft } from "./pickford_drafter.js";

// Config
const POLL_INTERVAL_MS = 60_000;
const NTFY_TOPIC = process.env.NOTARY_MONITOR_NTFY_TOPIC || "dino-claims-alerts-fpx";
const NTFY_SERVER = process.env.NOTARY_MONITOR_NTFY_SERVER || "https://ntfy.sh";
const ALERTED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Tier classification rules. Tuned against real Pickford Escrow emails:
//   AVAIL example body: "Can you do a loan doc signing tonight around 6:30 pm"
//   DOC example subject: "[Encrypt] 2800 Veteran Ave Loan Doc Signing for Escrow No. 10152-MK"
//   DOC example body:    "Rochelle Singh has sent you a protected message"
const AVAILABILITY_RE = /(availab|are you (free|open|able)|when (can|are|would) you|do you have time|interested in (a |the )?(signing|notar)|open for|can you do .{0,40}?(signing|notar)|are you (taking|booking)|any (chance|interest)|do you cover|able to (do|cover|take))/i;

// Subject-side document signals. Also matches "Loan Doc Signing", "loan doc",
// "Escrow No.", and the [Encrypt] / [Encrypted] prefix that secure-portal
// agencies (Pickford, etc.) tag their document deliveries with.
const DOCUMENT_SUBJECT_RE = /(\[encrypt(ed)?\]|loan (doc[a-z ]* )?signing|signing assignment|signing request|loan document|signing package|borrower (doc|sign)|appointment (confirm|details)|signing details|new (loan )?signing|signing order|notary (assignment|order|request)|escrow (doc|signing|no\.?\s*\d)|doc(s|ument)?\s+(ready|attached|signing))/i;

// Body-side document signals. Microsoft Purview / Office 365 encrypted-email
// delivery (Pickford uses this) produces a body with "protected message" — no
// Gmail attachment but still a document delivery. Also catches generic
// attachment-language for agencies that just paste docs inline.
const DOCUMENT_BODY_RE = /(protected message|sent you a (protected|secure|encrypted) message|please find (attached|the attached)|attached (are|please find|is) the (loan|signing|borrower|closing) (doc|package)|here are the (signing |loan )?documents|signing instructions|borrower(s)? are)/i;

// Common signing-service / agency sender patterns. Useful as a hint that
// "we got something from a real agency" even when the subject is generic.
// Primary agencies — get a distinctive prefix + tag so Hakiel can ID them
// from the lock screen without opening the ntfy. Pickford = #1 today; add
// others here if priority shifts. Map value is the short slug used in the
// ntfy prefix (kept compact for phone-screen readability).
const PRIMARY_AGENCY_SLUGS: Record<string, string> = {
  "pickfordescrow.com": "PICKFORD",
};

function primaryAgencyName(fromHeader: string): string | null {
  const addr = extractEmailAddress(fromHeader);
  const at = addr.indexOf("@");
  if (at < 0) return null;
  const domain = addr.substring(at + 1);
  for (const [d, slug] of Object.entries(PRIMARY_AGENCY_SLUGS)) {
    if (domain === d || domain.endsWith("." + d)) return slug;
  }
  return null;
}

const KNOWN_NOTARY_AGENCY_DOMAINS = [
  "pickfordescrow.com",  // Hakiel's primary escrow agency
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
  body: string;
  hasAttachment: boolean;
}): NotaryTier {
  const { fromHeader, subject, body, hasAttachment } = args;

  if (isMarketing(subject)) return null;
  if (isReceipt(subject)) return null;

  const noReply = isNoReply(fromHeader);
  const fromAgency = isFromKnownAgency(fromHeader);

  // Strong DOC signals: explicit attachment, encrypted-portal delivery, or
  // body language that reads "here are the docs". These win over availability
  // language because by the time docs arrive the availability question is
  // already settled.
  if (hasAttachment && !noReply) return "DOC";
  if (/\[encrypt(ed)?\]/i.test(subject)) return "DOC";
  if (DOCUMENT_BODY_RE.test(body) && (!noReply || fromAgency)) return "DOC";

  // Availability tier: question phrasing in EITHER subject or body. Sender
  // must be a real human or a known agency mailbox (skip generic noreply
  // newsletters that happen to contain the word "available").
  const asksAvailability = AVAILABILITY_RE.test(subject) || AVAILABILITY_RE.test(body);
  if (asksAvailability && (!noReply || fromAgency)) return "AVAIL";

  // Weaker DOC signal: subject mentions signing-related keywords but body
  // doesn't ask for availability. Common when an agency replies with the
  // documents in the same thread as the original "are you available" subject
  // and the encrypted-portal marker isn't present (rare but possible).
  if (DOCUMENT_SUBJECT_RE.test(subject) && (!noReply || fromAgency)) return "DOC";

  return null;
}

// In-memory state
const alerted: Map<string, number> = new Map();        // msg ID -> ts
const alertedThreadTier: Map<string, number> = new Map(); // `${threadId}:${tier}` -> ts
let started_at = 0;
let pollInFlight = false;

function pruneAlerted() {
  const cutoff = Date.now() - ALERTED_TTL_MS;
  for (const [id, ts] of alerted) {
    if (ts < cutoff) alerted.delete(id);
  }
  for (const [key, ts] of alertedThreadTier) {
    if (ts < cutoff) alertedThreadTier.delete(key);
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
  // Doc-like extensions only. Image extensions (.png/.jpg/.tif) are excluded
  // intentionally - they're almost always inline signature graphics
  // (cid:image001.png@... etc), not signing documents. Real signing packets
  // are PDFs ~95% of the time, occasionally .doc/.docx/.zip.
  function walk(p: any): boolean {
    if (!p) return false;
    const filename = (p.filename || "").toLowerCase();
    const hasAtt = Boolean(p.body?.attachmentId);
    if (filename && hasAtt && /\.(pdf|doc|docx|zip)$/.test(filename)) {
      // Also require Content-Disposition: attachment when present, to skip
      // PDFs that are linked inline in HTML (rare but possible).
      const headers = p.headers || [];
      const disposition = headers.find((h: any) => h.name?.toLowerCase() === "content-disposition")?.value || "";
      if (disposition && /inline/i.test(disposition)) return false;
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
    const body = extractBody(full.data.payload);
    const tier = classify({ fromHeader, subject, body, hasAttachment });

    // Primary agencies (Pickford today) get a distinctive prefix + star tag
    // so they stand out in the lock-screen list. Other agencies use the
    // generic [NOTARY-*] prefix.
    const primary = primaryAgencyName(fromHeader);

    // Primary-agency catch-all: Hakiel never wants to miss ANYTHING from his
    // #1 client. If the email didn't classify as AVAIL/DOC but it's from a
    // primary-agency domain (pickfordescrow.com), still alert under a generic
    // "MSG" tier instead of silently dropping it. (This is why the 2026-05-15
    // "Same Team, New Location" Pickford email was missed — it was neither an
    // availability inquiry nor a doc delivery, so classify() returned null.)
    // Non-primary senders keep the original selective behavior.
    const effTier: string | null = tier ?? (primary ? "MSG" : null);
    if (!effTier) {
      alerted.set(m.id, Date.now());
      continue;
    }

    // Per-thread per-tier dedup: don't re-ping the same tier within an
    // already-active thread. New tier on existing thread (e.g. AVAIL fired
    // earlier, now DOC arrives) DOES ping - that's a real state change.
    const threadId = full.data.threadId || m.id;
    const threadTierKey = `${threadId}:${effTier}`;
    if (alertedThreadTier.has(threadTierKey)) {
      console.log(`[notary-monitor] [${effTier}] skip (thread already alerted at this tier) - ${subject}`);
      alerted.set(m.id, Date.now());
      continue;
    }

    const snippet = snippetFromBody(body);

    const tierPart = primary ? `${primary}-${effTier}` : effTier;
    const title = `[NOTARY-${tierPart}] ${subject}`;
    const message = `From: ${fromHeader}\n${hasAttachment ? "(has attachment)\n" : ""}\n${snippet}\n\n[id: ${m.id}]`;
    // Primary-agency AVAIL/DOC stay max priority (time-sensitive — "can you
    // do it tonight" loses value by morning). The MSG catch-all is priority 4
    // (visible, not alarm) since it's general correspondence, not a job.
    const priority = effTier === "MSG" ? 4 : (primary ? 5 : (effTier === "DOC" ? 5 : 4));
    const baseTag = effTier === "DOC" ? "page_facing_up" : effTier === "MSG" ? "incoming_envelope" : "calendar";
    const tags = primary ? ["star", baseTag] : [baseTag];

    // For Pickford, fire the auto-drafter alongside the alert. The drafter
    // creates a Gmail draft on this thread that Hakiel reviews + sends
    // manually. Ntfy gets a draft-status line so he knows what landed.
    // Auto-drafter only runs for real AVAIL/DOC jobs — never for the MSG
    // catch-all (it can't extract a date/time from a relocation notice, and
    // createPickfordDraft's tier param is "AVAIL"|"DOC" only).
    let draftLine = "";
    if (primary === "PICKFORD" && (tier === "AVAIL" || tier === "DOC")) {
      const messageIdHeader = get("Message-ID") || get("Message-Id") || get("message-id");
      const ccHeader = get("Cc");
      const receivedIso = new Date(internalDate).toISOString();
      try {
        const draftResult = await createPickfordDraft({
          tier,
          thread_id: full.data.threadId || m.id,
          in_reply_to_message_id: messageIdHeader,
          reply_to_address: fromHeader,
          cc_addresses: ccHeader || undefined,
          original_subject: subject,
          inquiry_body: body,
          email_received_iso: receivedIso,
          source_email_id: m.id,
        });
        if (draftResult.status === "drafted") {
          const verdictTag = draftResult.verdict ? ` [${draftResult.verdict}/${draftResult.confidence}]` : "";
          draftLine = `\nDraft ready in Gmail${verdictTag} - review + send.`;
        } else if (draftResult.status === "skipped_active_thread") {
          draftLine = "\n(no draft - you replied in this thread recently)";
        } else if (draftResult.status === "skipped_no_extraction") {
          draftLine = "\n(no draft - could not parse date/time, draft manually)";
        } else {
          draftLine = `\n(draft failed: ${draftResult.reason || "unknown"})`;
        }
      } catch (e: any) {
        draftLine = `\n(draft threw: ${String(e?.message || e).substring(0, 100)})`;
        console.error(`[notary-monitor] pickford drafter threw: ${e?.message || e}`);
      }
    }

    const messageWithDraft = `${message}${draftLine}`;

    console.log(`[notary-monitor] [${tierPart}] ${fromHeader} - ${subject}${draftLine ? " (drafter ran)" : ""}`);
    await sendNtfy({ title, message: messageWithDraft, priority, tags });
    alerted.set(m.id, Date.now());
    alertedThreadTier.set(threadTierKey, Date.now());
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
