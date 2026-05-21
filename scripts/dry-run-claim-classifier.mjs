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
  {
    // Real regression: Sean Thomas 2026-05-20, claim 12-1226000034. XA note
    // with natural-language supplement phrasing (insured-submitted estimates,
    // "in addition to the supplement you wrote"). Pre-fix this fell to
    // [STATUS] because the subject hits MEDIUM_XACTWARE_RE and the body matched
    // no SUPP keyword. xactware opts (no quote-strip, 4000-char window) mirror
    // the live claim_monitor path.
    name: "XA note SUPP — insured estimates / in-addition-to-supplement (Sean Thomas)",
    from: "donotreply@xactware.com",
    subject: "An Assignment Note Has Been Added in XactAnalysis",
    body:
      "An assignment note was added\nClaim #: 12-1226000034\nNote:\n" +
      "I have received 2 estimates from insured stating this work is completed " +
      "and is in addition to the supplement you wrote for us.  Can you please " +
      "review and advise.  I uploaded their email and both estimates submitted.\n" +
      "Thank you,\nDiana\nDiana Vinson|Claims Analyst\nHarbor Claims, LLC",
    opts: { stripQuotes: false, charLimit: 4000 },
    expected: "SUPP",
  },
  {
    // Real regression: Cheryl Groves 2026-05-15, claim KWSKWS26030053. XA note
    // is a forwarded examiner thread; supplement signal ("notes from the
    // contractor", "reconstruction estimate", curly-apostrophe "contractor’s
    // estimate") sits deep in the body. Verifies both the no-quote-strip path
    // and the curly-apostrophe fix.
    name: "XA note SUPP — contractor/reconstruction estimate in forwarded thread (Groves)",
    from: "donotreply@xactware.com",
    subject: "An Assignment Note Has Been Added in XactAnalysis",
    body:
      "An assignment note was added\nClaim #: KWSKWS26030053\nNote:\n" +
      "From: Claims <claims@straightlineglobal.com>\nDate: Friday, May 15, 2026 at 4:40 PM\n" +
      "To: Nicholas Anderson <NAnderson@narisk.com>\nSubject: Re: KWSKWS26030053\n" +
      "Good Afternoon Nicholas, Thank you for your email. We will be happy to review " +
      "and revise accordingly. If possible, could you provide a copy of the contractor’s " +
      "estimate for us to review?\n" +
      "From: Nicholas Anderson <NAnderson@narisk.com>\nSubject: KWSKWS26030053\n" +
      "Please see below notes from the contractor and revise estimate, if appliable. " +
      "I would like to request approval of the attached reconstruction estimate totaling $7,823.98.",
    opts: { stripQuotes: false, charLimit: 4000 },
    expected: "SUPP",
  },
];

let pass = 0;
let fail = 0;
console.log(`\nRunning ${cases.length} test cases against the body-aware classifier:\n`);
for (const c of cases) {
  const matchable = getMatchableText({ subject: c.subject, plainBody: c.body }, c.opts);
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
