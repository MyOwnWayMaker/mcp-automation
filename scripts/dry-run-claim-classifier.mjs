// Dry-run the claim_monitor classifier against synthetic test cases that
// exercise the body-scanning matchers added in this build. Run after
// `npm run build` with: node scripts/dry-run-claim-classifier.mjs
//
// Each case feeds (subject, body) into getMatchableText then into
// classify() and asserts the resulting tier matches `expected`.

import { getMatchableText } from "../dist/util/email_text.js";
import { classify } from "../dist/watchers/claim_monitor.js";

const FROM_GENERIC = '"Examiner Name" <examiner@ccmsi.com>';

const cases = [
  {
    name: "Body-only SUPP (subject is generic)",
    from: FROM_GENERIC,
    subject: "Quick question on claim 1234",
    body: "Hi Hakiel, can you supplement this one for the new damage they pointed out? The carrier wants the additional roof line items added by Friday.",
    expected: "SUPP",
  },
  {
    name: "Body-only CORRECTION (subject is generic)",
    from: FROM_GENERIC,
    subject: "Re: 1234 follow-up",
    body: "Carrier just asked us to revise the photos on the back patio. Can you redo and resubmit? File number is 81030440.",
    expected: "CORRECTION",
  },
  {
    name: "Body-only REINSP (advisory variant)",
    from: FROM_GENERIC,
    subject: "Re: claim 1234",
    body: "Wanted to ask if a re-inspection is necessary here before we close out. Insured says they noticed cracking after the rain last week.",
    expected: "REINSP",
  },
  {
    name: "Body-only NEW (cold-ask availability inquiry)",
    from: FROM_GENERIC,
    subject: "Hi Hakiel - capacity question",
    body: "Are you available to handle a new claim at 92501? Wind loss, mobile home, 24hr first contact required.",
    expected: "HIGH",
  },
  {
    name: "Quoted-text false positive (trigger is in quoted block)",
    from: FROM_GENERIC,
    subject: "Re: 1234 just checking in",
    body: "Just following up on this, no update needed for now.\n\n-----Original Message-----\nFrom: Hakiel\nWe need a supplement for the additional damage on claim 1234.",
    expected: null,
  },
  {
    name: "Subject-only SUPP (regression check)",
    from: FROM_GENERIC,
    subject: "Supplement request for claim 5678",
    body: "Please see attached.",
    expected: "SUPP",
  },
];

let pass = 0;
let fail = 0;
console.log(`\nRunning ${cases.length} test cases against the body-aware classifier:\n`);
for (const c of cases) {
  const matchable = getMatchableText({ subject: c.subject, plainBody: c.body });
  const tier = classify({ fromHeader: c.from, subject: c.subject, matchableText: matchable });
  const ok = tier === c.expected;
  const symbol = ok ? "OK  " : "FAIL";
  console.log(`  ${symbol} ${c.name}`);
  console.log(`        subject: ${c.subject}`);
  console.log(`        expected: ${c.expected}, got: ${tier}`);
  if (!ok) {
    console.log(`        matchable text: ${matchable.replace(/\n/g, " | ").substring(0, 200)}`);
  }
  console.log();
  if (ok) pass++; else fail++;
}

console.log(`Results: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
