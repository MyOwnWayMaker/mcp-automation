// Tests for draftInspectionSms (dist/tools/sms_drafter.js) — the verbatim
// first-contact SMS template plus the "tomorrow," wording rule.
//
// Rule (Hakiel, 2026-06-29): when the proposed slot is the LA-local day after
// "now", the date reads "tomorrow, Tuesday June 30th" — the bare weekday form
// caused a correction on the Tracey/Avicasis batch.
//
// Run with: node --test tests/sms_drafter.test.mjs   (needs dist/ built)

import test from "node:test";
import assert from "node:assert/strict";

const { draftInspectionSms } = await import("../dist/tools/sms_drafter.js");

const BASE = {
  insured_name: "Jennifer Tracey",
  slot_start: "2026-06-30T09:00:00-07:00",
  slot_end: "2026-06-30T10:00:00-07:00",
};

test("tomorrow rule: slot on the LA-local next day gets the 'tomorrow, ' prefix", () => {
  const r = draftInspectionSms({ ...BASE, now_iso: "2026-06-29T18:30:00-07:00" });
  assert.equal(r.ok, true);
  assert.equal(r.proposed_date, "tomorrow, Tuesday June 30th");
  assert.match(r.sms_text, /is tomorrow, Tuesday June 30th between 9am-10am/);
});

test("tomorrow rule: slot two days out stays bare", () => {
  const r = draftInspectionSms({ ...BASE, now_iso: "2026-06-28T18:30:00-07:00" });
  assert.equal(r.ok, true);
  assert.equal(r.proposed_date, "Tuesday June 30th");
  assert.doesNotMatch(r.sms_text, /tomorrow/);
});

test("tomorrow rule: same-day slot stays bare (no 'tomorrow')", () => {
  const r = draftInspectionSms({ ...BASE, now_iso: "2026-06-30T06:00:00-07:00" });
  assert.equal(r.ok, true);
  assert.equal(r.proposed_date, "Tuesday June 30th");
});

test("tomorrow rule: LA-local day boundary — 11pm PT tonight vs a 9am slot", () => {
  // 2026-06-29 23:00 PT = 2026-06-30 06:00 UTC. The UTC date already reads the
  // 30th; the LA-local comparison must still call the 6/30 slot "tomorrow".
  const r = draftInspectionSms({ ...BASE, now_iso: "2026-06-30T06:00:00Z" });
  assert.equal(r.ok, true);
  assert.equal(r.proposed_date, "tomorrow, Tuesday June 30th");
});

test("template shape: three paragraphs, greeting, no signature", () => {
  const r = draftInspectionSms({ ...BASE, now_iso: "2026-06-28T12:00:00-07:00" });
  assert.equal(r.ok, true);
  const paras = r.sms_text.split("\n\n");
  assert.equal(paras.length, 3);
  assert.match(paras[0], /^Hello Jennifer\. This is a courtesy text from your field adjuster, Hakiel McQueen\.$/);
  assert.match(paras[2], /Can you be available at this time\?$/);
});

test("two insureds → 'A and B'", () => {
  const r = draftInspectionSms({
    ...BASE,
    insured_name: "Kathleen Lowe & Margarita Patino",
    now_iso: "2026-06-28T12:00:00-07:00",
  });
  assert.equal(r.first_name_or_names, "Kathleen and Margarita");
});

test("half-hour slot renders 10:30am-11:30am", () => {
  const r = draftInspectionSms({
    ...BASE,
    slot_start: "2026-06-30T10:30:00-07:00",
    slot_end: "2026-06-30T11:30:00-07:00",
    now_iso: "2026-06-28T12:00:00-07:00",
  });
  assert.equal(r.proposed_time_frame, "10:30am-11:30am");
});

test("bad now_iso → error, not a crash", () => {
  const r = draftInspectionSms({ ...BASE, now_iso: "not-a-date" });
  assert.equal(r.ok, false);
});
