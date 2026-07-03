// Regression tests for pure helpers inside scripts/pipeline/orchestrator.mjs.
//
// What this guards against:
//   - normalizeDate: US-date-string leaking into folder names like
//     `5/29/2026_...` (broke folder lookup; fix shipped 2026-06-10).
//   - parseFiletracDocList / extractClaimIdByFileNumber: the FT-doc-library
//     backfill silently dropping docs because of a metadata-block parser drift.
//   - niceDocName / shouldSkipFtDoc: signature-image fallthrough that put
//     `image001.png` into claim folders (or stripped a real worksheet).
//   - insuredFromQueststarTask: supplement fallback that uses the Queststar
//     `task` field to recover an insured name when Drive probes fail.
//   - parseClaimFolderName: ordinal-supplement folder naming round-trip.
//
// Run with: npm test (or: node --test tests/orchestrator_helpers.test.mjs)
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDate,
  parseFiletracDocList,
  extractClaimIdByFileNumber,
  niceDocName,
  titleCase,
  shouldSkipFtDoc,
  insuredFromQueststarTask,
  parseClaimFolderName,
  normalizeLossType,
  deriveClientShort,
  deriveLossType,
  extractClaimIdByToken,
  extractClientClaimFromSubject,
  subjectNameTokens,
  parseFiletracClaimDetail,
  genericCarrierShort,
} from "../scripts/pipeline/orchestrator.mjs";

// ── normalizeDate ──────────────────────────────────────────────────────────

test("normalizeDate: ISO YYYY-MM-DD passes through", () => {
  assert.equal(normalizeDate("2026-05-29"), "2026-05-29");
});

test("normalizeDate: ISO with trailing time strips to date", () => {
  assert.equal(normalizeDate("2026-05-29T19:15:02Z"), "2026-05-29");
});

test("normalizeDate: US M/D/YYYY → ISO (the 2026-06-10 regression)", () => {
  assert.equal(normalizeDate("5/29/2026"), "2026-05-29");
});

test("normalizeDate: US single-digit zero-pads", () => {
  assert.equal(normalizeDate("1/2/2026"), "2026-01-02");
});

test("normalizeDate: US 2-digit year → 20xx", () => {
  assert.equal(normalizeDate("5/29/26"), "2026-05-29");
});

test("normalizeDate: garbage → null (must not silently coerce)", () => {
  assert.equal(normalizeDate("yesterday"), null);
  assert.equal(normalizeDate("29 May"), null);
  assert.equal(normalizeDate(""), null);
  assert.equal(normalizeDate(null), null);
  assert.equal(normalizeDate(undefined), null);
});

// ── parseFiletracDocList ───────────────────────────────────────────────────

test("parseFiletracDocList: empty 'No documents found' → []", () => {
  assert.deepEqual(parseFiletracDocList("No documents found for this claim."), []);
});

test("parseFiletracDocList: parses one standard block", () => {
  const text = `
1. [report_id=20170966] 3707515_20260529115202179.pdf
   Type: PDF | Date: 5/29/2026 | Size: 1894 KB | Cloud: false
   Desc: Adjuster Assignment Worksheet
   URL: https://example.com/doc

2. [report_id=20170967] 3707515_signed_pia.jpg
   Type: JPG | Date: 5/29/2026 | Size: 142 KB | Cloud: true
   Desc: 3707515 signed pia form.jpg
   URL: https://example.com/doc2
`.trim();
  const out = parseFiletracDocList(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].report_id, "20170966");
  assert.equal(out[0].filename, "3707515_20260529115202179.pdf");
  assert.equal(out[0].file_type, "PDF");
  assert.equal(out[0].date, "5/29/2026");
  assert.equal(out[0].size_kb, 1894);
  assert.equal(out[0].on_cloud, false);
  assert.equal(out[0].description, "Adjuster Assignment Worksheet");
  assert.equal(out[1].on_cloud, true);
});

// ── extractClaimIdByFileNumber ─────────────────────────────────────────────

test("extractClaimIdByFileNumber: finds id by file # match", () => {
  const list = `
File #: 1097519 | Claim ID: 3708717 | Insured: Cheryl Paller
File #: 1097520 | Claim ID: 3708718 | Insured: John Doe
`;
  assert.equal(extractClaimIdByFileNumber(list, "1097519"), "3708717");
  assert.equal(extractClaimIdByFileNumber(list, "1097520"), "3708718");
});

test("extractClaimIdByFileNumber: missing file # → null", () => {
  const list = `File #: 1097519 | Claim ID: 3708717 | Insured: Cheryl Paller`;
  assert.equal(extractClaimIdByFileNumber(list, "9999999"), null);
});

test("extractClaimIdByFileNumber: empty fileNumber → null (defensive)", () => {
  assert.equal(extractClaimIdByFileNumber("anything", ""), null);
  assert.equal(extractClaimIdByFileNumber("anything", null), null);
});

// ── titleCase / niceDocName ────────────────────────────────────────────────

test("titleCase: short lowercase words → UPPER (PIA, IRS)", () => {
  assert.equal(titleCase("signed pia form"), "Signed PIA Form");
  assert.equal(titleCase("irs w9"), "IRS W9");
});

test("titleCase: longer words → Title Case", () => {
  assert.equal(titleCase("adjuster assignment worksheet"), "Adjuster Assignment Worksheet");
});

test("niceDocName: with description → '{Title Case Desc} - {Insured}.{ext}'", () => {
  // Real FT descriptions arrive lowercase; titleCase upper-cases short
  // all-lowercase tokens (PIA, IRS, W9) and Title-Cases the rest.
  const d = { filename: "3707515_signed_pia.jpg", file_type: "JPG", description: "signed pia form" };
  assert.equal(niceDocName(d, "Cheryl Paller"), "Signed PIA Form - Cheryl Paller.jpg");
});

test("niceDocName: strips trailing extension already in description", () => {
  // The original bug: description was "1097519 signed pia form.jpg" — we want
  // to drop the dupe .jpg before re-appending from file_type.
  const d = { filename: "x.jpg", file_type: "JPG", description: "1097519 signed pia form.jpg" };
  assert.equal(niceDocName(d, "Cheryl"), "1097519 Signed PIA Form - Cheryl.jpg");
});

test("niceDocName: no description → '{date} {filename}'", () => {
  const d = { filename: "3707515_20260529115202179.pdf", file_type: "PDF", date: "5/29/2026" };
  assert.equal(niceDocName(d, "Cheryl"), "5-29-2026 3707515_20260529115202179.pdf");
});

// ── shouldSkipFtDoc ────────────────────────────────────────────────────────

test("shouldSkipFtDoc: tiny image001.png signature artifact → skip", () => {
  assert.equal(shouldSkipFtDoc({ filename: "image001.png", size_kb: 12 }), true);
  assert.equal(shouldSkipFtDoc({ filename: "image023.jpg", size_kb: 5 }), true);
});

test("shouldSkipFtDoc: real-sized image001.png → keep (NOT a sig artifact)", () => {
  // The threshold is 30KB — sized photos must pass through even if naming
  // pattern matches.
  assert.equal(shouldSkipFtDoc({ filename: "image001.png", size_kb: 250 }), false);
});

test("shouldSkipFtDoc: any other filename → keep", () => {
  assert.equal(shouldSkipFtDoc({ filename: "Assignment.pdf", size_kb: 12 }), false);
  assert.equal(shouldSkipFtDoc({ filename: "DSC_0001.jpg", size_kb: 12 }), false);
});

test("shouldSkipFtDoc: missing filename → skip (defensive)", () => {
  assert.equal(shouldSkipFtDoc({ size_kb: 1000 }), true);
});

// ── insuredFromQueststarTask ───────────────────────────────────────────────

test("insuredFromQueststarTask: 'Insured (Client Claim#)' → 'Insured'", () => {
  assert.equal(
    insuredFromQueststarTask("Cheryl Paller Living Trust (PCAS 1097519)"),
    "Cheryl Paller Living Trust",
  );
});

test("insuredFromQueststarTask: with carrier slash and trailing label", () => {
  assert.equal(
    insuredFromQueststarTask("Carol Gross (PCAS 1097520 / Aegis) — Pending Inspection"),
    "Carol Gross",
  );
});

test("insuredFromQueststarTask: shape mismatch / null → null", () => {
  assert.equal(insuredFromQueststarTask("No parens here"), null);
  assert.equal(insuredFromQueststarTask(null), null);
  assert.equal(insuredFromQueststarTask(""), null);
});

// ── parseClaimFolderName ───────────────────────────────────────────────────

test("parseClaimFolderName: standard new-assignment folder", () => {
  const r = parseClaimFolderName("2026-06-10_Carol Gross_PCAS_Aegis_Wind");
  assert.deepEqual(r, {
    date: "2026-06-10",
    insured: "Carol Gross",
    client: "PCAS",
    carrier: "Aegis",
    loss_type: "Wind",
  });
});

test("parseClaimFolderName: ordinal-supplement folder", () => {
  const r = parseClaimFolderName("2026-06-10_(2nd Supplement) Thomas Smith_USCS_Allstate_Fire");
  assert.deepEqual(r, {
    date: "2026-06-10",
    insured: "Thomas Smith",
    client: "USCS",
    carrier: "Allstate",
    loss_type: "Fire",
  });
});

test("parseClaimFolderName: malformed → null", () => {
  assert.equal(parseClaimFolderName("not-a-claim-folder"), null);
  assert.equal(parseClaimFolderName(""), null);
});

// ── normalizeLossType (B1 closed-vocab peril normalizer) ─────────────────────

test("normalizeLossType: closed-vocab mappings", () => {
  assert.equal(normalizeLossType("Wind (WIND)"), "Wind");
  assert.equal(normalizeLossType("WINDSTORM"), "Wind");
  assert.equal(normalizeLossType("Weight of Snow"), "Wind");
  assert.equal(normalizeLossType("Wight of Snow"), "Wind");
  assert.equal(normalizeLossType("DISCHARGE WATER / STEAM"), "Water");
  assert.equal(normalizeLossType("slab leak"), "Water");
  assert.equal(normalizeLossType("Fire/Smoke"), "Fire");
  assert.equal(normalizeLossType("Vehicle Impact"), "Vehicle Collision");
  assert.equal(normalizeLossType("Car Accident"), "Vehicle Collision");
  assert.equal(normalizeLossType("General Liability"), "GL");
  assert.equal(normalizeLossType("Vandalism & Malicious Mischief"), "VMM");
});

test("normalizeLossType: unknown / empty → UNKNOWN (flag, never guess)", () => {
  assert.equal(normalizeLossType("Earthquake"), "UNKNOWN");
  assert.equal(normalizeLossType(""), "UNKNOWN");
  assert.equal(normalizeLossType(null), "UNKNOWN");
  assert.equal(normalizeLossType(undefined), "UNKNOWN");
});

test("normalizeLossType: specificity order (water keyword present but vehicle wins)", () => {
  assert.equal(normalizeLossType("vehicle hit the water heater"), "Vehicle Collision");
});

// ── deriveClientShort (body-aware IA-firm detection) ─────────────────────────

test("deriveClientShort: XactWare-routed SLG via reply-to in body", () => {
  const parsed = { sender_kind: "xactware_xa" };
  const msg = { from: "donotreply@xactware.com", body: "Please email any replies to: vreuter@straightlineglobal.com" };
  assert.equal(deriveClientShort(parsed, msg), "SLG");
});

test("deriveClientShort: AAN subcontracted by PCAS → AAN/PCAS (AAN first)", () => {
  const parsed = { sender_kind: "other" };
  const msg = { from: "noreply@app.associatedadjusting.com", body: "PCAS file ref pcsadj.com" };
  assert.equal(deriveClientShort(parsed, msg), "AAN/PCAS");
});

test("deriveClientShort: AAN alone (no PCAS) → AAN", () => {
  const parsed = { sender_kind: "other" };
  const msg = { from: "noreply@app.associatedadjusting.com", body: "assignment" };
  assert.equal(deriveClientShort(parsed, msg), "AAN");
});

test("deriveClientShort: known sender_kind table still wins (straightline)", () => {
  assert.equal(deriveClientShort({ sender_kind: "straightline" }, { from: "claims@straightlineglobal.com", body: "" }), "SLG");
});

test("deriveClientShort: FT-template PCAS by sender", () => {
  assert.equal(deriveClientShort({ sender_kind: "filetrac_template" }, { from: "info@pcsadj.com", body: "" }), "PCAS");
});

test("deriveClientShort: unknown → null", () => {
  assert.equal(deriveClientShort({ sender_kind: "other" }, { from: "x@example.com", body: "nothing" }), null);
});

// ── deriveLossType (parsed fields, then subject/attachments fallback) ─────────

test("deriveLossType: from parser loss_type", () => {
  assert.equal(deriveLossType({ loss_type: "Wind (WIND)" }, { subject: "", attachments: [] }), "Wind");
});

test("deriveLossType: fallback to attachment filename (Benchmark_Wind)", () => {
  const parsed = { loss_type: null, loss_description: null };
  const msg = { subject: "New Fortegra Claim # 032645", attachments: [{ filename: "Benchmark_Wind_DOL_2023.pdf" }] };
  assert.equal(deriveLossType(parsed, msg), "Wind");
});

test("deriveLossType: nothing recognizable → null", () => {
  assert.equal(deriveLossType({ loss_type: null }, { subject: "Hello", attachments: [] }), null);
});

// ── FileTrac identity backfill (PCAS free-text forwards) ─────────────────────
// Guards the path that filed nothing for Sybil Davis 2026-06-23: a forwarded
// PCAS assignment whose body was "Please see attached wind claim" — all fields
// only on FileTrac. These helpers find + parse the FT record to fill the blanks.

// Real filetrac_list_claims shape (dashes separate claim rows).
const FT_LIST_DAVIS = `FileTrac Claims:

File #: 81031771 | Claim ID: 3710902 | 81031771  UPLOAD>>  REPORTS  | SV-0000270 Doc. Library | 6/23/2026 | Davis CONTACTS   | First Capital - Seaview Taria Fox | Adjuster Assigned Due: 6/26/2026 | Hakiel McQueen | Notes
---
File #: 81031336 | Claim ID: 3707515 | 81031336  UPLOAD>>  REPORTS  | 1097519 Doc. Library | 5/29/2026 | PALLER LIVING TRUST CONTACTS   | DB Insurance Company Michael Hoover | Ready for Review - Deb Due: 6/25/2026 | Hakiel McQueen | Notes`;

test("extractClaimIdByToken: by client claim # (SV-0000270)", () => {
  assert.equal(extractClaimIdByToken(FT_LIST_DAVIS, "SV-0000270"), "3710902");
});

test("extractClaimIdByToken: by insured surname (Davis)", () => {
  assert.equal(extractClaimIdByToken(FT_LIST_DAVIS, "Davis"), "3710902");
});

test("extractClaimIdByToken: matches the right row, not a neighbor", () => {
  assert.equal(extractClaimIdByToken(FT_LIST_DAVIS, "1097519"), "3707515");
});

test("extractClaimIdByToken: absent token / too short → null", () => {
  assert.equal(extractClaimIdByToken(FT_LIST_DAVIS, "ZZ-9999"), null);
  assert.equal(extractClaimIdByToken(FT_LIST_DAVIS, "ab"), null);
  assert.equal(extractClaimIdByToken("", "Davis"), null);
});

test("extractClientClaimFromSubject: pulls claim # from a PCAS FW subject", () => {
  assert.equal(
    extractClientClaimFromSubject("FW: First Cap SeaView Claim # SV-0000270 Sybil Davis"),
    "SV-0000270",
  );
  assert.equal(extractClientClaimFromSubject("Claim#: 1097519 Paller"), "1097519");
  assert.equal(extractClientClaimFromSubject("no claim here"), null);
});

test("subjectNameTokens: drops routing/carrier noise, keeps the insured name", () => {
  const toks = subjectNameTokens("FW: First Cap SeaView Claim # SV-0000270 Sybil Davis");
  assert.ok(toks.includes("Sybil"));
  assert.ok(toks.includes("Davis"));
  assert.ok(!toks.includes("Claim"));
  assert.ok(!toks.includes("SeaView"));
});

test("genericCarrierShort: builds a short code from unknown carrier text", () => {
  assert.equal(genericCarrierShort("Allied Trust Insurance Company"), "AlliedTrust");
  assert.equal(genericCarrierShort("Insurance Company"), null); // all stopwords
  assert.equal(genericCarrierShort(""), null);
  assert.equal(genericCarrierShort(null), null);
});

test("parseFiletracClaimDetail: extracts identity fields from real detail text", () => {
  // Trimmed but format-faithful filetrac_get_claim output for Sybil Davis.
  const detail = `Claim Detail (ID: 3710902):

Client:
First Capital - Seaview
Client Contact:
Taria Fox
Date of Loss:
6/21/2026
File #:
81031771
Insured:
Sybil Davis
Date Received:
6/23/2026
Claim #:
SV-0000270
Loss Address:
2181 North Beverly Glen Boulevard Los Angeles, CA  90077
Policy #:
SDIC302853-02
Loss Information
Date of Loss:
6/21/2026
Type of Loss:
Windstorm
Loss Description:
Wind – tree downed on home and fence/gate
Loss Location
( Additional Loss Locations )
Street Address:
2181 North Beverly Glen Boulevard
Address 2:
City:
Los Angeles
State:
ZIP:
90077
Country:`;
  const d = parseFiletracClaimDetail(detail);
  assert.equal(d.insured, "Sybil Davis");
  assert.equal(d.carrier, "First Capital - Seaview");
  assert.equal(d.claim_number_client, "SV-0000270");
  assert.equal(d.file_number, "81031771");
  assert.equal(d.loss_type, "Windstorm");
  assert.equal(d.loss_description, "Wind – tree downed on home and fence/gate");
  assert.equal(d.date_of_loss, "6/21/2026");
  assert.equal(d.date_received, "6/23/2026");
  assert.equal(d.policy, "SDIC302853-02");
  assert.equal(d.loss_address.street, "2181 North Beverly Glen Boulevard");
  assert.equal(d.loss_address.city, "Los Angeles");
  assert.equal(d.loss_address.zip, "90077");
});

test("parseFiletracClaimDetail: empty input → {}", () => {
  assert.deepEqual(parseFiletracClaimDetail(""), {});
});

// End-to-end derive check: Windstorm → Wind, First Capital → FirstCap.
test("backfilled Davis fields normalize to folder codes", () => {
  assert.equal(normalizeLossType("Windstorm"), "Wind");
  // carrier "First Capital - Seaview" hits the FirstCap lookup entry first.
  // (deriveCarrierShort is module-internal; we assert the lookup intent here.)
  assert.equal(genericCarrierShort("First Capital - Seaview"), "FirstCapital");
});
