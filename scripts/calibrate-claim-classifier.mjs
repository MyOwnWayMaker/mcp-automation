// Real-world calibration of the claim_monitor classifier. Pulls recent
// emails from IA-firm domains and runs the body-aware matchers, reporting
// where each tier was triggered (subject only, body only, both, or neither).
// Read-only - no ntfy sent. Run via:
//   railway run node scripts/calibrate-claim-classifier.mjs

import { google } from "googleapis";
import { getGoogleAuthClient } from "../dist/auth/google.js";
import { getMatchableText } from "../dist/util/email_text.js";
import { classify } from "../dist/watchers/claim_monitor.js";

// IA-firm sender domains to scope the calibration. Cast a wide net.
const IA_DOMAINS = [
  "ccmsi.com", "k2claims.com", "sedgwick.com", "aanationwide.com",
  "fortegra.com", "straightlineglobal.com", "usclaimsolutions.co",
  "pcsadj.com", "xactware.com", "filetrac.net", "premierclaims.com",
];

const auth = await getGoogleAuthClient();
const gmail = google.gmail({ version: "v1", auth });

const fromQuery = IA_DOMAINS.map(d => `from:${d}`).join(" OR ");
const q = `(${fromQuery}) newer_than:60d`;
const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 30 });
const messages = list.data.messages || [];
console.log(`Found ${messages.length} messages from IA-firm domains in last 60 days.\n`);

function extractBody(p) {
  if (!p) return "";
  if (p.body?.data) return Buffer.from(p.body.data, "base64").toString("utf-8");
  if (Array.isArray(p.parts)) return p.parts.map(extractBody).join("\n");
  return "";
}

const tally = { HIGH: 0, CORRECTION: 0, SUPP: 0, REINSP: 0, MEDIUM: 0, null: 0 };
const triggerSource = { subject_only: 0, body_only: 0, both: 0, neither: 0 };
const detailedRows = [];

for (const m of messages) {
  if (!m.id) continue;
  const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
  const headers = full.data.payload?.headers || [];
  const get = (n) => headers.find(h => h.name === n)?.value || "";
  const fromHeader = get("From");
  const subject = get("Subject");

  const matchableText = getMatchableText({ subject, payload: full.data.payload });
  const subjectOnlyText = subject;
  const bodyOnlyText = matchableText.substring(subject.length).trim();

  const tier = classify({ fromHeader, subject, matchableText });
  const tierFromSubject = classify({ fromHeader, subject, matchableText: subjectOnlyText });
  const tierFromBody = classify({ fromHeader, subject, matchableText: bodyOnlyText });

  tally[String(tier)] = (tally[String(tier)] ?? 0) + 1;

  let source;
  if (tier === null) source = "neither";
  else if (tierFromSubject === tier && tierFromBody === tier) source = "both";
  else if (tierFromSubject === tier) source = "subject_only";
  else if (tierFromBody === tier) source = "body_only";
  else source = "neither"; // shouldn't happen if combined matched
  triggerSource[source]++;

  detailedRows.push({ tier: String(tier), source, fromHeader, subject });
}

console.log("Tier distribution:");
for (const [t, n] of Object.entries(tally)) console.log(`  ${t.padEnd(12)} ${n}`);
console.log("\nMatch source (where classifier saw the trigger):");
for (const [s, n] of Object.entries(triggerSource)) console.log(`  ${s.padEnd(14)} ${n}`);

console.log("\nDetail rows:");
for (const r of detailedRows) {
  console.log(`  ${r.tier.padEnd(12)} ${r.source.padEnd(14)} ${r.fromHeader.substring(0, 40).padEnd(42)} ${r.subject.substring(0, 60)}`);
}
