// Dry-run the notary classifier against Rochelle's recent emails to verify
// the AVAIL / DOC tiers fire correctly. Read-only - no ntfy sent.

import { google } from "googleapis";
import { getNotaryGmailClient } from "../dist/auth/google-notary.js";

// Mirror the regex + helpers from notary_monitor.ts. Kept inline so we don't
// have to export them; this is a dev-only sanity script.
const AVAILABILITY_RE = /(availab|are you (free|open|able)|when (can|are|would) you|do you have time|interested in (a |the )?(signing|notar)|open for|can you do .{0,40}?(signing|notar)|are you (taking|booking)|any (chance|interest)|do you cover|able to (do|cover|take))/i;
const DOCUMENT_SUBJECT_RE = /(\[encrypt(ed)?\]|loan (doc[a-z ]* )?signing|signing assignment|signing request|loan document|signing package|borrower (doc|sign)|appointment (confirm|details)|signing details|new (loan )?signing|signing order|notary (assignment|order|request)|escrow (doc|signing|no\.?\s*\d)|doc(s|ument)?\s+(ready|attached|signing))/i;
const DOCUMENT_BODY_RE = /(protected message|sent you a (protected|secure|encrypted) message|please find (attached|the attached)|attached (are|please find|is) the (loan|signing|borrower|closing) (doc|package)|here are the (signing |loan )?documents|signing instructions|borrower(s)? are)/i;
const MARKETING_SUBJECT_RE = /(% off|sale ends|ends in|trial ending|newsletter|webinar|don't miss|last chance|early bird|free trial|special offer|limited time)/i;
const RECEIPT_SUBJECT_RE = /(receipt|payment confirmation|invoice (paid|sent)|thank you for your payment|paid in full)/i;

function extractAddr(s) {
  const m = (s || "").match(/<([^>]+)>/);
  return (m ? m[1] : (s || "")).trim().toLowerCase();
}
function isNoReply(s) {
  return /(^|<)\s*(no[-_]?reply|donotreply|notifications?|do-not-reply)@/i.test(s || "");
}
const AGENCY_DOMAINS = ["pickfordescrow.com", "snapdocs.com", "signingorder.com", "notarycafe.com", "signingdirect.com"];
function fromAgency(s) {
  const d = extractAddr(s).split("@")[1] || "";
  return AGENCY_DOMAINS.some(a => d === a || d.endsWith("." + a));
}
function extractBody(p) {
  if (!p) return "";
  if (p.body?.data) return Buffer.from(p.body.data, "base64").toString("utf-8");
  if (Array.isArray(p.parts)) return p.parts.map(extractBody).join("\n");
  return "";
}
function hasMeaningfulAttachment(p) {
  if (!p) return false;
  const filename = (p.filename || "").toLowerCase();
  const hasAtt = Boolean(p.body?.attachmentId);
  if (filename && hasAtt && /\.(pdf|doc|docx|zip)$/.test(filename)) {
    const headers = p.headers || [];
    const disp = headers.find(h => h.name?.toLowerCase() === "content-disposition")?.value || "";
    if (disp && /inline/i.test(disp)) return false;
    return true;
  }
  if (Array.isArray(p.parts)) return p.parts.some(hasMeaningfulAttachment);
  return false;
}

function classify({ fromHeader, subject, body, hasAttachment }) {
  if (MARKETING_SUBJECT_RE.test(subject)) return null;
  if (RECEIPT_SUBJECT_RE.test(subject)) return null;
  const noReply = isNoReply(fromHeader);
  const agency = fromAgency(fromHeader);
  if (hasAttachment && !noReply) return "DOC";
  if (/\[encrypt(ed)?\]/i.test(subject)) return "DOC";
  if (DOCUMENT_BODY_RE.test(body) && (!noReply || agency)) return "DOC";
  if ((AVAILABILITY_RE.test(subject) || AVAILABILITY_RE.test(body)) && (!noReply || agency)) return "AVAIL";
  if (DOCUMENT_SUBJECT_RE.test(subject) && (!noReply || agency)) return "DOC";
  return null;
}

const auth = await getNotaryGmailClient();
const gmail = google.gmail({ version: "v1", auth });
const list = await gmail.users.messages.list({
  userId: "me",
  q: "from:rochelle newer_than:3d",
  maxResults: 10,
});
const msgs = list.data.messages || [];
console.log(`Testing classifier against ${msgs.length} Rochelle emails (chronological order, with thread-dedup):\n`);
const alertedThreadTier = new Map();
for (const m of msgs.reverse()) {
  const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
  const h = full.data.payload?.headers || [];
  const get = (n) => h.find(x => x.name === n)?.value || "";
  const fromHeader = get("From");
  const subject = get("Subject");
  const body = extractBody(full.data.payload).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const hasAttachment = hasMeaningfulAttachment(full.data.payload);
  const tier = classify({ fromHeader, subject, body, hasAttachment });
  let outcome = tier ? `[${tier}]` : "(none - silent)";
  if (tier) {
    const key = `${full.data.threadId}:${tier}`;
    if (alertedThreadTier.has(key)) {
      outcome = `[${tier}] DEDUP (thread already alerted at this tier)`;
    } else {
      alertedThreadTier.set(key, Date.now());
      outcome = `[${tier}] FIRES`;
    }
  }
  console.log(`  Subject: ${subject}`);
  console.log(`  Outcome: ${outcome}`);
  console.log(`  Reason:  hasAttachment=${hasAttachment}, encrypted=${/\[encrypt/i.test(subject)}, asksAvailability=${AVAILABILITY_RE.test(subject) || AVAILABILITY_RE.test(body)}`);
  console.log();
}
