// Regression tests for scripts/sms-monitor.mjs — locks the contract for
// outbound check-back + inbound reply detection + auto-calendar on CONFIRM.
//
// What this guards against:
//   - parseWindow regressions (window like "10am-11am" must produce 10:00→11:00)
//   - DST drift in tzOffset() — 6/11/2026 is in DST so PT = -07:00, not -08:00
//   - classify() misfires that would silently drop the FT inspection slot
//     (e.g. "Okay" classified as UNCLEAR would mean no calendar event)
//   - asciiHeader() lapsing — Carol's prod run died on an em-dash in ntfy
//   - processEntry losing idempotence (re-fires ntfy on the same inbound)
//   - 2-hour check-back firing twice on the same entry
//
// Run with: npm test  (or: node --test tests/sms_monitor.test.mjs)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  parseWindow,
  tzOffset,
  buildEventTimes,
  classify,
  asciiHeader,
  loadTracker,
  saveTracker,
  processEntry,
  runMonitorOnce,
  buildEventTitle,
  buildEventDescription,
  findExistingCalendarEvent,
} from "../scripts/sms-monitor.mjs";

// ── parseWindow ─────────────────────────────────────────────────────────────

test("parseWindow: 10am-11am", () => {
  assert.deepEqual(parseWindow("10am-11am"), { startHour: 10, startMin: 0, endHour: 11, endMin: 0 });
});

test("parseWindow: 1pm-2:30pm", () => {
  assert.deepEqual(parseWindow("1pm-2:30pm"), { startHour: 13, startMin: 0, endHour: 14, endMin: 30 });
});

test("parseWindow: 24h form 14:00-15:00", () => {
  assert.deepEqual(parseWindow("14:00-15:00"), { startHour: 14, startMin: 0, endHour: 15, endMin: 0 });
});

test("parseWindow: spaces tolerated", () => {
  assert.deepEqual(parseWindow("10:00am - 11:30am"), { startHour: 10, startMin: 0, endHour: 11, endMin: 30 });
});

test("parseWindow: only end has am/pm — start inherits", () => {
  assert.deepEqual(parseWindow("10-11am"), { startHour: 10, startMin: 0, endHour: 11, endMin: 0 });
});

test("parseWindow: 12am = midnight", () => {
  assert.deepEqual(parseWindow("12am-1am"), { startHour: 0, startMin: 0, endHour: 1, endMin: 0 });
});

test("parseWindow: 12pm = noon", () => {
  assert.deepEqual(parseWindow("12pm-1pm"), { startHour: 12, startMin: 0, endHour: 13, endMin: 0 });
});

test("parseWindow: unparseable → null", () => {
  assert.equal(parseWindow("morning"), null);
  assert.equal(parseWindow(""), null);
  assert.equal(parseWindow(undefined), null);
});

// ── tzOffset / buildEventTimes ──────────────────────────────────────────────

test("tzOffset: PT during DST (June) = -07:00", () => {
  assert.equal(tzOffset("2026-06-11", "America/Los_Angeles"), "-07:00");
});

test("tzOffset: PT outside DST (January) = -08:00", () => {
  assert.equal(tzOffset("2026-01-15", "America/Los_Angeles"), "-08:00");
});

test("buildEventTimes: DST 10am-11am → 10:00→11:00 PT", () => {
  const { start, end } = buildEventTimes("2026-06-11", "10am-11am", "America/Los_Angeles");
  assert.equal(start, "2026-06-11T10:00:00-07:00");
  assert.equal(end, "2026-06-11T11:00:00-07:00");
});

test("buildEventTimes: no window defaults to 9am-10am", () => {
  const { start, end } = buildEventTimes("2026-06-11", null, "America/Los_Angeles");
  assert.equal(start, "2026-06-11T09:00:00-07:00");
  assert.equal(end, "2026-06-11T10:00:00-07:00");
});

test("buildEventTimes: PST winter slot 2pm-3pm = -08:00", () => {
  const { start, end } = buildEventTimes("2026-01-15", "2pm-3pm", "America/Los_Angeles");
  assert.equal(start, "2026-01-15T14:00:00-08:00");
  assert.equal(end, "2026-01-15T15:00:00-08:00");
});

// ── classify ────────────────────────────────────────────────────────────────

test("classify: Carol's actual reply 'Okay' → CONFIRM", () => {
  // The exact prod input that motivated the monitor.
  assert.equal(classify("Okay"), "CONFIRM");
});

test("classify: common confirms", () => {
  for (const s of ["Yes", "yeah", "ok", "okay", "sure", "Sounds good", "Perfect", "Great", "see you then", "I'll be there", "That works"]) {
    assert.equal(classify(s), "CONFIRM", `expected CONFIRM for "${s}"`);
  }
});

test("classify: common declines", () => {
  for (const s of ["No", "can't", "I cant make it", "Reschedule please", "Busy that day", "Doesn't work"]) {
    assert.equal(classify(s), "DECLINE", `expected DECLINE for "${s}"`);
  }
});

test("classify: any '?' → UNCLEAR (don't auto-confirm 'okay what time?')", () => {
  assert.equal(classify("Okay what time?"), "UNCLEAR");
  assert.equal(classify("What time?"), "UNCLEAR");
  assert.equal(classify("Sure, will you be there?"), "UNCLEAR");
});

test("classify: empty / whitespace → UNCLEAR", () => {
  assert.equal(classify(""), "UNCLEAR");
  assert.equal(classify("   "), "UNCLEAR");
  assert.equal(classify(undefined), "UNCLEAR");
});

test("classify: random non-committal text → UNCLEAR", () => {
  assert.equal(classify("Hmm"), "UNCLEAR");
  assert.equal(classify("Let me check"), "UNCLEAR");
  assert.equal(classify("I have something then"), "UNCLEAR");
});

// ── asciiHeader ─────────────────────────────────────────────────────────────

test("asciiHeader: em-dash replaced with hyphen (Carol crash repro)", () => {
  // Exact title format that crashed: "SMS reply from Carol Gross — CONFIRM"
  const safe = asciiHeader("SMS reply from Carol Gross — CONFIRM");
  assert.equal(safe, "SMS reply from Carol Gross - CONFIRM");
  // The crash was: "character at index 27 has a value of 8212". Make sure
  // every byte is now in Latin-1.
  for (const ch of safe) assert.ok(ch.charCodeAt(0) < 256, `non-latin-1 char ${ch}`);
});

test("asciiHeader: fancy quotes flattened", () => {
  assert.equal(asciiHeader("‘smart’ “quotes”"), "'smart' \"quotes\"");
});

test("asciiHeader: emoji becomes '?' (surrogate pairs replaced char-by-char)", () => {
  // 🚀 is a UTF-16 surrogate pair, so each unit becomes '?' — still Latin-1 safe.
  const out = asciiHeader("hi 🚀 there");
  assert.equal(out, "hi ?? there");
  for (const ch of out) assert.ok(ch.charCodeAt(0) < 256, `non-latin-1 char ${ch}`);
});

// ── loadTracker / saveTracker ───────────────────────────────────────────────

test("loadTracker: missing file → { pending: [] }", () => {
  const tmp = path.join(os.tmpdir(), `sms_tracker_missing_${Date.now()}.json`);
  assert.deepEqual(loadTracker(tmp), { pending: [] });
});

test("saveTracker / loadTracker round-trip", () => {
  const tmp = path.join(os.tmpdir(), `sms_tracker_rt_${Date.now()}.json`);
  const obj = { pending: [{ id: "x", thread_id: "t.+1" }] };
  saveTracker(obj, tmp);
  assert.deepEqual(loadTracker(tmp), obj);
  fs.unlinkSync(tmp);
});

// ── processEntry — inbound branches ────────────────────────────────────────

function mkThread(messages) {
  return { message_count: messages.length, messages };
}
function mkEntry(overrides = {}) {
  return {
    id: "carol-gross-2026-06-10",
    thread_id: "t.+13104861443",
    contact_name: "Carol Gross",
    contact_phone: "+13104861443",
    claim_id: "3708717",
    company_index: 1,
    ia_firm: "PCAS",
    send_iso: "2026-06-10T02:15:00.000Z",
    proposed_date_iso: "2026-06-11",
    proposed_time_window: "10am-11am",
    two_hour_warned: false,
    last_processed_inbound_iso: null,
    resolved: false,
    ...overrides,
  };
}

test("processEntry: skip when resolved=true", async () => {
  const ntfyCalls = [];
  const calCalls = [];
  const { action } = await processEntry(mkEntry({ resolved: true }), Date.parse("2026-06-10T15:00:00Z"), {
    fetchThread: async () => mkThread([]),
    ntfy: async (a) => ntfyCalls.push(a),
    createInspectionCalendarEvent: async (e) => { calCalls.push(e); return { ok: true, event_id: "x" }; },
  });
  assert.equal(action, "skip:resolved");
  assert.equal(ntfyCalls.length, 0);
  assert.equal(calCalls.length, 0);
});

test("processEntry: inbound CONFIRM ('Okay') creates calendar + ntfy + resolves", async () => {
  const ntfyCalls = [];
  const calCalls = [];
  const { entry, action } = await processEntry(mkEntry(), Date.parse("2026-06-10T16:00:00Z"), {
    fetchThread: async () => mkThread([
      { direction: "outbound", body: "Hello Carol...", timestamp_iso: "2026-06-10T02:15:00.000Z" },
      { direction: "inbound", body: "Okay", timestamp_iso: "2026-06-10T15:12:00.000Z" },
    ]),
    ntfy: async (a) => ntfyCalls.push(a),
    createInspectionCalendarEvent: async (e) => { calCalls.push(e); return { ok: true, event_id: "cal-123" }; },
  });
  assert.equal(action, "inbound:CONFIRM");
  assert.equal(entry.resolved, true);
  assert.equal(entry.calendar_event_id, "cal-123");
  assert.equal(entry.last_processed_inbound_iso, "2026-06-10T15:12:00.000Z");
  assert.equal(calCalls.length, 1);
  assert.equal(ntfyCalls.length, 1);
  assert.match(ntfyCalls[0].title, /Carol Gross/);
  assert.match(ntfyCalls[0].title, /CONFIRM/);
});

test("processEntry: inbound DECLINE does NOT create calendar, ntfy fires, NOT resolved", async () => {
  const ntfyCalls = [];
  const calCalls = [];
  const { entry, action } = await processEntry(mkEntry(), Date.parse("2026-06-10T16:00:00Z"), {
    fetchThread: async () => mkThread([
      { direction: "outbound", body: "...", timestamp_iso: "2026-06-10T02:15:00.000Z" },
      { direction: "inbound", body: "Cant make that day, reschedule please", timestamp_iso: "2026-06-10T15:12:00.000Z" },
    ]),
    ntfy: async (a) => ntfyCalls.push(a),
    createInspectionCalendarEvent: async (e) => { calCalls.push(e); return { ok: true, event_id: "x" }; },
  });
  assert.equal(action, "inbound:DECLINE");
  assert.equal(entry.resolved, false, "decline must not resolve — Hakiel still needs to act");
  assert.equal(calCalls.length, 0, "decline must NOT create a calendar event");
  assert.equal(ntfyCalls.length, 1);
  assert.match(ntfyCalls[0].title, /DECLINE/);
});

test("processEntry: inbound UNCLEAR ntfy's but does not resolve or create event", async () => {
  const ntfyCalls = [];
  const calCalls = [];
  const { entry } = await processEntry(mkEntry(), Date.parse("2026-06-10T16:00:00Z"), {
    fetchThread: async () => mkThread([
      { direction: "outbound", body: "...", timestamp_iso: "2026-06-10T02:15:00.000Z" },
      { direction: "inbound", body: "What time again?", timestamp_iso: "2026-06-10T15:12:00.000Z" },
    ]),
    ntfy: async (a) => ntfyCalls.push(a),
    createInspectionCalendarEvent: async (e) => { calCalls.push(e); return { ok: true, event_id: "x" }; },
  });
  assert.equal(entry.resolved, false);
  assert.equal(calCalls.length, 0);
  assert.equal(ntfyCalls.length, 1);
  assert.match(ntfyCalls[0].title, /UNCLEAR/);
});

test("processEntry: same inbound on next poll → no duplicate ntfy", async () => {
  const ntfyCalls = [];
  const e = mkEntry({ last_processed_inbound_iso: "2026-06-10T15:12:00.000Z" });
  const { action } = await processEntry(e, Date.parse("2026-06-10T16:00:00Z"), {
    fetchThread: async () => mkThread([
      { direction: "inbound", body: "Okay", timestamp_iso: "2026-06-10T15:12:00.000Z" },
    ]),
    ntfy: async (a) => ntfyCalls.push(a),
    createInspectionCalendarEvent: async () => ({ ok: true, event_id: "x" }),
  });
  // No NEW inbound after last_processed_inbound_iso → fall through to 2h check.
  assert.notEqual(action, "inbound:CONFIRM");
  assert.equal(ntfyCalls.length === 0 || /No SMS reply yet/.test(ntfyCalls[0].title), true);
});

// ── processEntry — 2-hour check-back ───────────────────────────────────────

test("processEntry: <2h elapsed + no inbound → skip:no-change", async () => {
  const ntfyCalls = [];
  const sendIso = "2026-06-10T02:15:00.000Z";
  const oneHourLater = Date.parse(sendIso) + 60 * 60 * 1000;
  const { entry, action } = await processEntry(mkEntry({ send_iso: sendIso }), oneHourLater, {
    fetchThread: async () => mkThread([]),
    ntfy: async (a) => ntfyCalls.push(a),
    createInspectionCalendarEvent: async () => ({ ok: true }),
  });
  assert.equal(action, "skip:no-change");
  assert.equal(entry.two_hour_warned, false);
  assert.equal(ntfyCalls.length, 0);
});

test("processEntry: ≥2h elapsed + no inbound → two_hour_warned ntfy fires once", async () => {
  const ntfyCalls = [];
  const sendIso = "2026-06-10T02:15:00.000Z";
  const threeHoursLater = Date.parse(sendIso) + 3 * 60 * 60 * 1000;
  const { entry, action } = await processEntry(mkEntry({ send_iso: sendIso }), threeHoursLater, {
    fetchThread: async () => mkThread([]),
    ntfy: async (a) => ntfyCalls.push(a),
    createInspectionCalendarEvent: async () => ({ ok: true }),
  });
  assert.equal(action, "two_hour_warned");
  assert.equal(entry.two_hour_warned, true);
  assert.equal(ntfyCalls.length, 1);
  assert.match(ntfyCalls[0].title, /No SMS reply yet/);
});

test("processEntry: two_hour_warned idempotent (no double-ping on next poll)", async () => {
  const ntfyCalls = [];
  const sendIso = "2026-06-10T02:15:00.000Z";
  const fourHoursLater = Date.parse(sendIso) + 4 * 60 * 60 * 1000;
  const { action } = await processEntry(mkEntry({ send_iso: sendIso, two_hour_warned: true }), fourHoursLater, {
    fetchThread: async () => mkThread([]),
    ntfy: async (a) => ntfyCalls.push(a),
    createInspectionCalendarEvent: async () => ({ ok: true }),
  });
  assert.equal(action, "skip:no-change");
  assert.equal(ntfyCalls.length, 0);
});

test("processEntry: fetchThread throws → skip:fetch-failed (no crash)", async () => {
  const { action } = await processEntry(mkEntry(), Date.now(), {
    fetchThread: async () => { throw new Error("Voice logged out"); },
    ntfy: async () => {},
    createInspectionCalendarEvent: async () => ({ ok: true }),
  });
  assert.equal(action, "skip:fetch-failed");
});

// ── runMonitorOnce (integration) ────────────────────────────────────────────

test("runMonitorOnce: empty tracker → no actions, no mutation", async () => {
  const tmp = path.join(os.tmpdir(), `sms_tracker_runonce_empty_${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ pending: [] }));
  const res = await runMonitorOnce({ trackerPath: tmp, deps: {} });
  assert.equal(res.mutated, false);
  assert.deepEqual(res.actions, []);
  fs.unlinkSync(tmp);
});

test("runMonitorOnce: persists tracker mutations on inbound CONFIRM", async () => {
  const tmp = path.join(os.tmpdir(), `sms_tracker_runonce_confirm_${Date.now()}.json`);
  const entry = mkEntry();
  fs.writeFileSync(tmp, JSON.stringify({ pending: [entry] }, null, 2));
  const ntfyCalls = [];
  const calCalls = [];
  const res = await runMonitorOnce({
    trackerPath: tmp,
    now: Date.parse("2026-06-10T16:00:00Z"),
    deps: {
      fetchThread: async () => mkThread([
        { direction: "inbound", body: "Okay", timestamp_iso: "2026-06-10T15:12:00.000Z" },
      ]),
      ntfy: async (a) => ntfyCalls.push(a),
      createInspectionCalendarEvent: async () => { calCalls.push(1); return { ok: true, event_id: "ev-1" }; },
    },
  });
  assert.equal(res.mutated, true);
  assert.equal(res.actions[0].action, "inbound:CONFIRM");
  const persisted = JSON.parse(fs.readFileSync(tmp, "utf8"));
  assert.equal(persisted.pending[0].resolved, true);
  assert.equal(persisted.pending[0].calendar_event_id, "ev-1");
  fs.unlinkSync(tmp);
});

// ── buildEventTitle / buildEventDescription ───────────────────────────────
//
// What this guards against:
//   - Future edits silently dropping a section the user explicitly asked for
//     (DA name/contact/company, IA firm, claim brief, instructions).
//   - The Carol Gross "Inspection — <name> (<ia> <ft>)" title format drifting.
//   - claim_context being undefined blowing up the helper (must degrade
//     gracefully — only the minimum sections render).

const CAROL = {
  contact_name: "Carol Gross",
  contact_phone: "+13104861443",
  claim_id: "3708717",
  ia_firm: "PCAS",
  send_iso: "2026-06-10T02:15:00.000Z",
  last_processed_inbound_iso: "2026-06-10T15:12:00.000Z",
  proposed_date_iso: "2026-06-11",
  proposed_time_window: "10am-11am",
  claim_context: {
    claim_number: "AG-0000961",
    file_number: "81031513",
    date_of_loss: "2026-06-05",
    loss_type: "Water Damage",
    loss_description: "Cold water supply line leak in the kitchen.",
    coverage_limit: "Limited Water Coverage: $100,000",
    deductible: "$1,000",
    loss_address: "6605 Green Valley Circle #117, Culver City, CA 90230",
    insured_email: "Carolgross2002@yahoo.com",
    da_name: "Taria Fox",
    da_title: "Property Claims Examiner",
    da_company: "First Capital - Aegis",
    da_email: "tfox@aegisinsco.com",
    da_alt_email: "aegishomeowners@aegisinsco.com",
    da_phone: "623-444-5152",
    ia_firm_name: "Premier Claims & Adjusting Services (PCAS)",
    ia_firm_license: "CA #6009525",
    ia_firm_email: "info@pcsadj.com",
    ia_firm_phone: "888-755-9994",
    ia_firm_contact: "Britny Wilhoite",
    drive_folder_id: "1UPWcHJYHso1s4BQ0mTQAmMZ7Zb1RkOpY",
    drive_folder_url: "https://drive.google.com/drive/folders/1UPWcHJYHso1s4BQ0mTQAmMZ7Zb1RkOpY",
    da_instructions: ["Lots of photos", "Moisture reading photos legible"],
  },
};

test("buildEventTitle: standard 'Inspection — <name> (<ia> <ft>)' format", () => {
  assert.equal(buildEventTitle(CAROL), "Inspection — Carol Gross (PCAS 3708717)");
});

test("buildEventTitle: no claim_id → just 'Inspection — <name>'", () => {
  assert.equal(
    buildEventTitle({ contact_name: "Jane Doe" }),
    "Inspection — Jane Doe",
  );
});

test("buildEventTitle: claim_id but missing ia_firm → '? <id>' placeholder", () => {
  assert.equal(
    buildEventTitle({ contact_name: "Jane", claim_id: "X" }),
    "Inspection — Jane (? X)",
  );
});

test("buildEventDescription: includes every claim-context section Hakiel asked for", () => {
  const d = buildEventDescription(CAROL);
  // Header
  assert.match(d, /Carol Gross — Water Damage/);
  assert.match(d, /Claim: AG-0000961 \| File #: 81031513 \| FT: 3708717/);
  assert.match(d, /Loss Date: 2026-06-05/);
  // Loss
  assert.match(d, /^LOSS$/m);
  assert.match(d, /Cold water supply line leak/);
  assert.match(d, /Coverage: Limited Water Coverage: \$100,000 \| Deductible: \$1,000/);
  // Location
  assert.match(d, /^LOCATION$/m);
  assert.match(d, /6605 Green Valley Circle #117/);
  // Insured
  assert.match(d, /^INSURED CONTACT$/m);
  assert.match(d, /Carol Gross — \+13104861443 — Carolgross2002@yahoo\.com/);
  // DA — the explicit ask: name, contact, company
  assert.match(d, /^DESK ADJUSTER \(Carrier\)$/m);
  assert.match(d, /Taria Fox — Property Claims Examiner/);
  assert.match(d, /First Capital - Aegis/);
  assert.match(d, /tfox@aegisinsco\.com \| aegishomeowners@aegisinsco\.com/);
  assert.match(d, /Direct: 623-444-5152/);
  // IA firm
  assert.match(d, /^IA FIRM$/m);
  assert.match(d, /Premier Claims & Adjusting Services \(PCAS\) \(Lic CA #6009525\)/);
  assert.match(d, /Routed by: Britny Wilhoite/);
  // Instructions
  assert.match(d, /^DA INSTRUCTIONS \/ NOTES$/m);
  assert.match(d, /• Lots of photos/);
  assert.match(d, /• Moisture reading photos legible/);
  // Files — the claim's Drive folder so Hakiel can jump straight to it
  assert.match(d, /^FILES$/m);
  assert.match(d, /drive\.google\.com\/drive\/folders\/1UPWcHJYHso1s4BQ0mTQAmMZ7Zb1RkOpY/);
  // SMS audit
  assert.match(d, /^SMS$/m);
  assert.match(d, /Sent: 2026-06-10T02:15:00\.000Z/);
  assert.match(d, /Confirmed: 2026-06-10T15:12:00\.000Z/);
  assert.match(d, /Window: 10am-11am/);
  // Footer
  assert.match(d, /\(Auto-created from SMS confirmation by sms-monitor\.\)/);
});

test("buildEventDescription: degrades gracefully when claim_context is missing", () => {
  const minimal = {
    contact_name: "Jane Doe",
    contact_phone: "+15551234567",
    send_iso: "2026-06-10T00:00:00.000Z",
    ia_firm: "USCS",
  };
  const d = buildEventDescription(minimal);
  // Header still renders with fallback loss_type
  assert.match(d, /Jane Doe — Inspection/);
  // Insured + IA firm sections still present (minimum context)
  assert.match(d, /^INSURED CONTACT$/m);
  assert.match(d, /Jane Doe — \+15551234567/);
  assert.match(d, /^IA FIRM$/m);
  assert.match(d, /^USCS$/m);
  // No LOSS / LOCATION / DA sections (because no data)
  assert.equal(/^LOSS$/m.test(d), false);
  assert.equal(/^LOCATION$/m.test(d), false);
  assert.equal(/^DESK ADJUSTER/m.test(d), false);
  assert.equal(/^DA INSTRUCTIONS/m.test(d), false);
});

test("buildEventDescription: claim_context fields appear in stable order", () => {
  const d = buildEventDescription(CAROL);
  // Section order matters for human scannability — assert each precedes the next.
  const order = [
    "Carol Gross — Water Damage",
    "LOSS",
    "LOCATION",
    "INSURED CONTACT",
    "DESK ADJUSTER (Carrier)",
    "IA FIRM",
    "DA INSTRUCTIONS / NOTES",
    "FILES",
    "SMS",
  ];
  let lastIdx = -1;
  for (const s of order) {
    const idx = d.indexOf(s);
    assert.ok(idx >= 0, `missing section: ${s}`);
    assert.ok(idx > lastIdx, `section out of order: ${s} (at ${idx}, last was ${lastIdx})`);
    lastIdx = idx;
  }
});

test("buildEventDescription: FILES falls back to a constructed URL from drive_folder_id", () => {
  const idOnly = {
    ...CAROL,
    claim_context: { ...CAROL.claim_context, drive_folder_url: undefined },
  };
  const d = buildEventDescription(idOnly);
  assert.match(d, /^FILES$/m);
  assert.match(d, /^https:\/\/drive\.google\.com\/drive\/folders\/1UPWcHJYHso1s4BQ0mTQAmMZ7Zb1RkOpY$/m);
});

test("buildEventDescription: no FILES section when claim has no Drive folder", () => {
  const noFolder = {
    ...CAROL,
    claim_context: { ...CAROL.claim_context, drive_folder_id: undefined, drive_folder_url: undefined },
  };
  assert.equal(/^FILES$/m.test(buildEventDescription(noFolder)), false);
});

// ── findExistingCalendarEvent ─────────────────────────────────────────────
//
// What this guards against:
//   - Tracker reset leading to a second calendar event at the same slot
//     (Hakiel's 2026-06-11 duplicate Carol Gross incident).
//   - List-output parser drift: the tool returns
//     "ID: <id>\n<title>\nStart: <iso>\nEnd: <iso>\n\n---\n\n..." blocks; if
//     the separator changes upstream, this test is the canary.

function mkListResp(events) {
  const blocks = events.map(
    (e) => `ID: ${e.id}\n${e.title}\nStart: ${e.start}\nEnd: ${e.end}`,
  );
  return { content: [{ text: blocks.join("\n\n---\n\n") }] };
}

test("findExistingCalendarEvent: hit when title + start match", async () => {
  const start = "2026-06-11T10:00:00-07:00";
  const res = await findExistingCalendarEvent(CAROL, {
    calendarListEvents: async () => mkListResp([
      { id: "ev-existing", title: "Inspection — Carol Gross (PCAS 3708717)", start, end: "2026-06-11T11:00:00-07:00" },
    ]),
  });
  assert.deepEqual(res, { event_id: "ev-existing" });
});

test("findExistingCalendarEvent: miss when start differs (different time)", async () => {
  const res = await findExistingCalendarEvent(CAROL, {
    calendarListEvents: async () => mkListResp([
      { id: "ev-other", title: "Inspection — Carol Gross (PCAS 3708717)", start: "2026-06-11T14:00:00-07:00", end: "2026-06-11T15:00:00-07:00" },
    ]),
  });
  assert.equal(res, null);
});

test("findExistingCalendarEvent: miss when title differs (different contact)", async () => {
  const res = await findExistingCalendarEvent(CAROL, {
    calendarListEvents: async () => mkListResp([
      { id: "ev-other", title: "Inspection — Other Person (PCAS 9999999)", start: "2026-06-11T10:00:00-07:00", end: "2026-06-11T11:00:00-07:00" },
    ]),
  });
  assert.equal(res, null);
});

test("findExistingCalendarEvent: list error → null (don't block create)", async () => {
  const res = await findExistingCalendarEvent(CAROL, {
    calendarListEvents: async () => { throw new Error("API down"); },
  });
  assert.equal(res, null);
});

test("findExistingCalendarEvent: empty calendar → null", async () => {
  const res = await findExistingCalendarEvent(CAROL, {
    calendarListEvents: async () => mkListResp([]),
  });
  assert.equal(res, null);
});

test("findExistingCalendarEvent: no proposed_date_iso → null (defensive)", async () => {
  let called = false;
  const res = await findExistingCalendarEvent(
    { contact_name: "X" },
    { calendarListEvents: async () => { called = true; return mkListResp([]); } },
  );
  assert.equal(res, null);
  assert.equal(called, false, "must short-circuit before hitting the API");
});

// ── processEntry: dedup adoption ──────────────────────────────────────────

test("processEntry: dedup hit adopts existing event_id into tracker", async () => {
  // Build an unresolved Carol-shape entry with no calendar_event_id yet.
  const entry = JSON.parse(JSON.stringify(CAROL));
  delete entry.calendar_event_id;
  entry.id = "x";
  entry.thread_id = "t.+13104861443";
  entry.resolved = false;
  entry.two_hour_warned = false;
  // Simulate: the calendar create step returns a dedup hit (no fresh create).
  const calCalls = [];
  const ntfyCalls = [];
  const { entry: out, action } = await processEntry(
    entry,
    Date.parse("2026-06-10T16:00:00Z"),
    {
      fetchThread: async () => ({
        messages: [{ direction: "inbound", body: "Okay", timestamp_iso: "2026-06-10T15:13:00.000Z" }],
      }),
      ntfy: async (a) => ntfyCalls.push(a),
      createInspectionCalendarEvent: async () => {
        calCalls.push(1);
        return { ok: false, reason: "already exists upstream", event_id: "ev-dedup" };
      },
    },
  );
  assert.equal(action, "inbound:CONFIRM");
  assert.equal(out.calendar_event_id, "ev-dedup", "dedup id must land in tracker");
  assert.equal(out.resolved, true);
  assert.equal(ntfyCalls.length, 1);
  assert.match(ntfyCalls[0].body, /adopted existing ev-dedup/);
});
