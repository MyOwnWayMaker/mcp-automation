// Tests for the approval-gated outbound-SMS loop:
//   scripts/pipeline/outbox.mjs        — queue, grammar, staleness, ntfy poll parse
//   scripts/sms-outbox-runner.mjs      — pure helpers (first-contact read, window fmt)
//   scripts/sms-monitor.mjs            — C3 date-write guards, C4 counter extraction
//
// Run with: node --test tests/sms_outbox.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate every state file BEFORE the modules read their env-derived paths.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sms-outbox-test-"));
process.env.SMS_OUTBOX_PATH = path.join(TMP, "sms_outbox.json");
process.env.SMS_MONITOR_DRY_RUN = "0";

const {
  loadOutbox, saveOutbox, addProposal, findOpenProposal, proposalClaimKey,
  parseApprovalCommand, isProposalStale, asciiHeader,
} = await import("../scripts/pipeline/outbox.mjs");
const { todayLA, windowFromSlot, parseFirstContact } = await import("../scripts/sms-outbox-runner.mjs");
const {
  parseInspectionDate, writeInspectionDate, updateQueststarOnConfirm,
  extractTimeFromReply, extractDayFromReply, windowLabel, replyTimeMatchesProposal,
} = await import("../scripts/sms-monitor.mjs");

// ── approval-command grammar ────────────────────────────────────────────────

test("grammar: send N", () => {
  assert.deepEqual(parseApprovalCommand("send 3"), { verb: "send", id: 3, slot_index: 0 });
  assert.deepEqual(parseApprovalCommand("SEND #12"), { verb: "send", id: 12, slot_index: 0 });
});

test("grammar: send N slot M (1-based → 0-based)", () => {
  assert.deepEqual(parseApprovalCommand("send 3 slot 2"), { verb: "send", id: 3, slot_index: 1 });
});

test("grammar: edit N: full text (multi-line preserved)", () => {
  const c = parseApprovalCommand("edit 5: Hello Jennifer.\n\nNew text here.");
  assert.equal(c.verb, "edit");
  assert.equal(c.id, 5);
  assert.match(c.text, /^Hello Jennifer\./);
  assert.match(c.text, /New text here\.$/);
});

test("grammar: skip N", () => {
  assert.deepEqual(parseApprovalCommand("skip 7"), { verb: "skip", id: 7 });
});

test("grammar: our own prompts and chatter do not parse", () => {
  assert.equal(parseApprovalCommand("Approval needed - SMS to X"), null);
  assert.equal(parseApprovalCommand("send it"), null);
  assert.equal(parseApprovalCommand(""), null);
  assert.equal(parseApprovalCommand("sending 3"), null);
});

// ── staleness ───────────────────────────────────────────────────────────────

const mkSlot = (iso) => ({ slots: [{ start: iso, end: iso }] });

test("stale: slot starting in 1h (< 2h lead) is stale", () => {
  const now = new Date("2026-07-02T10:00:00-07:00");
  assert.equal(isProposalStale(mkSlot("2026-07-02T11:00:00-07:00"), 0, now), true);
});

test("stale: slot starting in 3h is fresh", () => {
  const now = new Date("2026-07-02T10:00:00-07:00");
  assert.equal(isProposalStale(mkSlot("2026-07-02T13:00:00-07:00"), 0, now), false);
});

test("stale: text-only proposals (no slots) never stale", () => {
  assert.equal(isProposalStale({ slots: [] }, 0, new Date()), false);
  assert.equal(isProposalStale({ draft_text: "note" }, 0, new Date()), false);
});

// ── outbox queue + idempotency ──────────────────────────────────────────────

test("outbox: addProposal assigns sequential ids; one open proposal per claim", () => {
  const outbox = loadOutbox();
  const p1 = addProposal(outbox, {
    kind: "new_assignment", insured_name: "A", to_phone: "+15551234567",
    draft_text: "x", slots: [], claim: { file_number: "81031111" },
  });
  assert.equal(p1.id, 1);
  assert.equal(p1.status, "awaiting_approval");
  assert.equal(proposalClaimKey(p1), "81031111");
  assert.ok(findOpenProposal(outbox, "81031111"));
  // kind-scoped lookup
  assert.equal(findOpenProposal(outbox, "81031111", "counter_reply"), null);
  const p2 = addProposal(outbox, { kind: "counter_reply", to_phone: "+15551234567", draft_text: "y", slots: [], claim: { file_number: "81031111" } });
  assert.equal(p2.id, 2);
  assert.ok(findOpenProposal(outbox, "81031111", "counter_reply"));
  // closed statuses drop out
  p1.status = "sent";
  p2.status = "skipped";
  assert.equal(findOpenProposal(outbox, "81031111"), null);
  saveOutbox(outbox);
  const reread = loadOutbox();
  assert.equal(reread.next_id, 3);
  assert.equal(reread.proposals.length, 2);
});

test("asciiHeader strips em-dashes and non-ascii for ntfy headers", () => {
  assert.equal(asciiHeader("Tracey — PCAS “water”"), 'Tracey - PCAS "water"');
});

// ── runner pure helpers ─────────────────────────────────────────────────────

test("windowFromSlot: on-the-hour and half-hour LA rendering", () => {
  assert.equal(windowFromSlot({ start: "2026-06-30T09:00:00-07:00", end: "2026-06-30T10:00:00-07:00" }), "9am-10am");
  assert.equal(windowFromSlot({ start: "2026-06-30T10:30:00-07:00", end: "2026-06-30T11:30:00-07:00" }), "10:30am-11:30am");
});

test("todayLA formats YYYY-MM-DD in LA", () => {
  // 2026-06-30 06:00Z is 2026-06-29 23:00 PT.
  assert.equal(todayLA(new Date("2026-06-30T06:00:00Z")), "2026-06-29");
});

test("parseFirstContact: set / empty / (not set) / unreadable", () => {
  assert.equal(parseFirstContact("Date of First Contact: 6/29/2026\nx"), "6/29/2026");
  assert.equal(parseFirstContact("Date of First Contact: \nx"), "");
  assert.equal(parseFirstContact("Date of First Contact: (not set)"), "");
  assert.equal(parseFirstContact("no such line"), null);
});

test("parseInspectionDate mirrors parseFirstContact for Date of Inspection", () => {
  assert.equal(parseInspectionDate("Date of Inspection: 6/30/2026"), "6/30/2026");
  assert.equal(parseInspectionDate("Date of Inspection: (not set)"), "");
});

// ── C3: inspection-date write guards ────────────────────────────────────────

function ftStub({ current = "", writes = [] } = {}) {
  return {
    filetracGetClaim: async () => ({ content: [{ type: "text", text: `Date of Inspection: ${current}` }] }),
    filetracUpdateClaimDates: async (args) => { writes.push(args); return { content: [] }; },
  };
}

test("writeInspectionDate: writes once, sets guard flag", async () => {
  const writes = [];
  const entry = {
    proposed_date_iso: "2026-07-08",
    claim_context: { ft_internal_claim_id: "3711537", company_index: 1, ia_firm: "PCAS" },
  };
  const line = await writeInspectionDate(entry, { filetrac: ftStub({ writes }) });
  assert.match(line, /SET Date of Inspection 2026-07-08/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].claim_id, "3711537");
  assert.equal(entry.inspection_date_written, true);
  // second call → guard, no write
  const line2 = await writeInspectionDate(entry, { filetrac: ftStub({ writes }) });
  assert.match(line2, /already written/);
  assert.equal(writes.length, 1);
});

test("writeInspectionDate: existing FT value adopted, never overwritten", async () => {
  const writes = [];
  const entry = {
    proposed_date_iso: "2026-07-08",
    claim_context: { ft_internal_claim_id: "1", company_index: 1 },
  };
  const line = await writeInspectionDate(entry, { filetrac: ftStub({ current: "7/01/2026", writes }) });
  assert.match(line, /already 7\/01\/2026/);
  assert.equal(writes.length, 0);
  assert.equal(entry.inspection_date_written, true);
});

test("writeInspectionDate: reinspection kind never touches dates", async () => {
  const entry = { proposed_date_iso: "2026-07-08", claim_context: { kind: "reinspection", ft_internal_claim_id: "1", company_index: 1 } };
  const line = await writeInspectionDate(entry, { filetrac: ftStub() });
  assert.match(line, /re-inspection/);
  assert.equal(entry.inspection_date_written, undefined);
});

test("writeInspectionDate: SLG flagged, no FT call; missing id flagged", async () => {
  assert.match(await writeInspectionDate({ proposed_date_iso: "2026-07-08", claim_context: { ia_firm: "SLG" } }, {}), /SLG\/XA/);
  assert.match(await writeInspectionDate({ proposed_date_iso: "2026-07-08", claim_context: {} }, {}), /no internal claimID/);
});

test("updateQueststarOnConfirm: no row id → skip; with row id → status + note", async () => {
  assert.match(await updateQueststarOnConfirm({ claim_context: {} }, {}), /no row id/);
  const calls = [];
  const qs = {
    updateClaimRow: async (id, f) => calls.push(["update", id, f]),
    listClaimRows: async () => [{ id: 1445, fields: { notes: "old" } }],
    appendClaimNote: async (row, line) => calls.push(["note", row.id, line]),
  };
  const entry = { proposed_date_iso: "2026-07-08", proposed_time_window: "9am-10am", claim_context: { queststar_row_id: 1445 } };
  const line = await updateQueststarOnConfirm(entry, { queststar: qs });
  assert.match(line, /1445/);
  assert.deepEqual(calls[0], ["update", 1445, { inspection_status: "Scheduled" }]);
  assert.equal(calls[1][0], "note");
  assert.match(calls[1][2], /2026-07-08 9am-10am/);
});

// ── C4: counter-offer extraction ────────────────────────────────────────────

test("extractTimeFromReply: full ranges", () => {
  assert.deepEqual(extractTimeFromReply("can we do 10-10:30?"), { startHour: 10, startMin: 0, endHour: 10, endMin: 30, explicit_range: true });
  assert.deepEqual(extractTimeFromReply("2pm to 3pm works"), { startHour: 14, startMin: 0, endHour: 15, endMin: 0, explicit_range: true });
});

test("extractTimeFromReply: bare-hour range without meridiem assumes business hours", () => {
  const w = extractTimeFromReply("how about 2-3");
  assert.equal(w.startHour, 14);
  assert.equal(w.endHour, 15);
});

test("extractTimeFromReply: single time → 1h window, explicit_range false", () => {
  assert.deepEqual(extractTimeFromReply("2pm works better"), { startHour: 14, startMin: 0, endHour: 15, endMin: 0, explicit_range: false });
});

test("extractTimeFromReply: no time → null", () => {
  assert.equal(extractTimeFromReply("Yes that works"), null);
  assert.equal(extractTimeFromReply("What is this about?"), null);
});

test("extractDayFromReply: tomorrow / weekday / M-D resolved in LA", () => {
  const now = new Date("2026-07-02T12:00:00-07:00"); // a Thursday
  assert.equal(extractDayFromReply("tomorrow afternoon", now), "2026-07-03");
  assert.equal(extractDayFromReply("can we do friday", now), "2026-07-03");
  assert.equal(extractDayFromReply("thursday would be better", now), "2026-07-09"); // same weekday → next week
  assert.equal(extractDayFromReply("how about 7/10", now), "2026-07-10");
  assert.equal(extractDayFromReply("yes", now), null);
});

test("windowLabel + replyTimeMatchesProposal", () => {
  assert.equal(windowLabel({ startHour: 10, startMin: 30, endHour: 11, endMin: 30 }), "10:30am-11:30am");
  assert.equal(replyTimeMatchesProposal({ startHour: 9, startMin: 0 }, "9am-10am"), true);
  assert.equal(replyTimeMatchesProposal({ startHour: 10, startMin: 0 }, "9am-10am"), false);
});

// ── D3: inspected command grammar ───────────────────────────────────────────

test("grammar: inspected with file#, name, dates", () => {
  assert.deepEqual(parseApprovalCommand("inspected 81031873"), { verb: "inspected", target: "81031873", date: null });
  assert.deepEqual(parseApprovalCommand("inspected tracey 7/1"), { verb: "inspected", target: "tracey", date: "7/1" });
  assert.deepEqual(parseApprovalCommand("INSPECTED 81031873 2026-07-01"), { verb: "inspected", target: "81031873", date: "2026-07-01" });
  assert.deepEqual(parseApprovalCommand("inspected yoav avicasis 7/1/2026"), { verb: "inspected", target: "yoav avicasis", date: "7/1/2026" });
  assert.equal(parseApprovalCommand("inspected"), null);
});

// ── D3: completion writer + sweep ───────────────────────────────────────────

const {
  markInspectionCompleted, sweepCompletedInspections, usDateEqualsIso,
  laDateTimeParts, completionKey, loadCompletionLedger,
} = await import("../scripts/sms-monitor.mjs");

test("usDateEqualsIso + laDateTimeParts + completionKey", () => {
  assert.equal(usDateEqualsIso("6/30/2026", "2026-06-30"), true);
  assert.equal(usDateEqualsIso("7/1/2026", "2026-06-30"), false);
  assert.deepEqual(laDateTimeParts("2026-06-30T10:30:00-07:00"), { date_iso: "2026-06-30", time_hhmm: "10:30" });
  assert.equal(completionKey("81031873", "2026-06-30"), "81031873:2026-06-30");
});

function ftCompletionStub({ current = "", writes = [] } = {}) {
  return {
    filetracGetClaim: async () => ({ content: [{ type: "text", text: `Date of Inspection: ${current}` }] }),
    filetracUpdateClaimDates: async (args) => { writes.push(args); return { content: [] }; },
    filetracListClaims: async () => ({ content: [{ type: "text", text: "File #: 81031873 | Claim ID: 3711537 | x" }] }),
  };
}

test("markInspectionCompleted: PCAS writes FT date, overwrites a differing planned date", async () => {
  const writes = [];
  const lines = await markInspectionCompleted(
    { ia_firm: "PCAS", company_index: 1, ft_internal_claim_id: "999" },
    { date_iso: "2026-07-02", time_hhmm: "10:30" },
    { filetrac: ftCompletionStub({ current: "7/01/2026", writes }) },
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].inspection_date, "2026-07-02");
  assert.match(lines[0], /was 7\/01\/2026/);
});

test("markInspectionCompleted: same-day FT value → no write", async () => {
  const writes = [];
  const lines = await markInspectionCompleted(
    { ia_firm: "PCAS", company_index: 1, ft_internal_claim_id: "999" },
    { date_iso: "2026-06-30", time_hhmm: "10:30" },
    { filetrac: ftCompletionStub({ current: "6/30/2026", writes }) },
  );
  assert.equal(writes.length, 0);
  assert.match(lines[0], /already/);
});

test("markInspectionCompleted: resolves internal claimID from File # when missing", async () => {
  const writes = [];
  await markInspectionCompleted(
    { ia_firm: "PCAS", file_number: "81031873" },
    { date_iso: "2026-07-02", time_hhmm: "10:30" },
    { filetrac: ftCompletionStub({ writes }) },
  );
  assert.equal(writes[0].claim_id, "3711537");
  assert.equal(writes[0].company_index, 1);
});

test("markInspectionCompleted: SLG routes to XA site_inspected with date + END time", async () => {
  const calls = [];
  const xact = {
    xactFindAssignmentByName: async () => ({ content: [{ type: "text", text: "Claim #: 12 | MFN: 06X7T7W" }] }),
    xactUpdateWorkflowStatus: async (args) => { calls.push(args); return { content: [] }; },
  };
  const lines = await markInspectionCompleted(
    { ia_firm: "SLG", insured: "Vincent Pinedo" },
    { date_iso: "2026-07-02", time_hhmm: "15:30" },
    { xact },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { mfn: "06X7T7W", status: "site_inspected", date: "2026-07-02", time: "15:30" });
  assert.match(lines[0], /Site Inspected 2026-07-02 15:30/);
});

test("sweep 1: passed tracker event → completion written once, ledgered, entry flagged", async () => {
  const ledgerPath = path.join(TMP, "ledger1.json");
  const marks = [], notes = [];
  const entry = {
    id: "t1", contact_name: "Test Person", claim_id: "81031111",
    proposed_date_iso: "2026-07-01", proposed_time_window: "9am-10am",
    calendar_event_id: "ev1", resolved: true,
    claim_context: { file_number: "81031111", ia_firm: "PCAS", company_index: 1, ft_internal_claim_id: "42" },
  };
  const deps = {
    ledgerPath,
    calendarListEvents: async () => ({ content: [{ type: "text", text: "ID: ev1\nInspection — Test Person\nStart: 2026-07-01T09:00:00-07:00\nEnd: 2026-07-01T10:00:00-07:00" }] }),
    markInspectionCompleted: async (t, w) => { marks.push([t, w]); return [`FT claim 42: Date of Inspection ${w.date_iso}`]; },
    ntfy: async (n) => notes.push(n),
  };
  const now = new Date("2026-07-02T08:00:00-07:00").getTime();
  const tracker = { pending: [entry] };
  const actions = await sweepCompletedInspections(tracker, now, deps);
  assert.equal(marks.length, 1);
  assert.equal(marks[0][1].date_iso, "2026-07-01");
  assert.equal(marks[0][1].time_hhmm, "10:00"); // event END, per Hakiel
  assert.equal(entry.inspection_completed_written, true);
  assert.equal(actions.filter(a => /inspection_completed/.test(a.action)).length, 1);
  // second run: ledger + entry flag → no new writes
  const again = await sweepCompletedInspections(tracker, now, deps);
  assert.equal(marks.length, 1);
  assert.equal(again.filter(a => /inspection_completed/.test(a.action)).length, 0);
});

test("sweep 1: future/moved event → untouched; reinspection kind → never", async () => {
  const ledgerPath = path.join(TMP, "ledger2.json");
  const marks = [];
  const mk = async (t, w) => { marks.push([t, w]); return ["ok"]; };
  const now = new Date("2026-07-02T08:00:00-07:00").getTime();
  const future = {
    contact_name: "F", proposed_date_iso: "2026-07-03", proposed_time_window: "9am-10am",
    calendar_event_id: "ev9", claim_context: { file_number: "1", ia_firm: "PCAS" },
  };
  const reinsp = {
    contact_name: "R", proposed_date_iso: "2026-07-01", proposed_time_window: "9am-10am",
    claim_context: { file_number: "2", ia_firm: "PCAS", kind: "reinspection" },
  };
  await sweepCompletedInspections({ pending: [future, reinsp] }, now, {
    ledgerPath, markInspectionCompleted: mk, ntfy: async () => {},
    calendarListEvents: async () => ({ content: [{ type: "text", text: "ID: ev9\nInspection — F\nStart: 2026-07-03T09:00:00-07:00\nEnd: 2026-07-03T10:00:00-07:00" }] }),
  });
  assert.equal(marks.length, 0);
  assert.equal(future.inspection_completed_written, undefined);
});

test("sweep 2: manually-scheduled '[ADJ] … Inspection' event resolves file # + firm", async () => {
  const ledgerPath = path.join(TMP, "ledger3.json");
  const marks = [], notes = [];
  const deps = {
    ledgerPath,
    calendarListEvents: async () => ({ content: [{ type: "text", text: "ID: cal9\n[ADJ] Yoav Avicasis Inspection — PCAS/Seaview 81031873\nStart: 2026-06-30T10:00:00-07:00\nEnd: 2026-06-30T11:00:00-07:00\nLocation: 3717 Broadlawn Dr" }] }),
    markInspectionCompleted: async (t, w) => { marks.push([t, w]); return ["FT ok"]; },
    ntfy: async (n) => notes.push(n),
  };
  const now = new Date("2026-07-01T08:00:00-07:00").getTime();
  await sweepCompletedInspections({ pending: [] }, now, deps);
  assert.equal(marks.length, 1);
  assert.equal(marks[0][0].file_number, "81031873");
  assert.equal(marks[0][0].ia_firm, "PCAS");
  assert.equal(marks[0][0].insured, "Yoav Avicasis");
  assert.equal(marks[0][1].time_hhmm, "11:00");
  // ledgered → second run no-op
  await sweepCompletedInspections({ pending: [] }, now, deps);
  assert.equal(marks.length, 1);
});

// ── D5: uniqueness parenthetical ────────────────────────────────────────────

const { deriveCauseParenthetical } = await import("../scripts/pipeline/orchestrator.mjs");

test("deriveCauseParenthetical: real June descriptions", () => {
  assert.equal(deriveCauseParenthetical(
    "A clogged sewer flooded the unit, causing damage and mold inside, on the wall between the primary bedroom bathroom & closet"),
    "Sewer Backup");
  assert.equal(deriveCauseParenthetical(
    "The unit 204 above the insureds unit had a water over flow issue, so the water came down the ceiling, light fixture, smoke detection, walls and the unit"),
    "Water From Unit Above");
  assert.equal(deriveCauseParenthetical("slab leak under the kitchen"), "Slab Leak");
  assert.equal(deriveCauseParenthetical("collapse from wieght of snow"), "Weight of Snow");
  assert.equal(deriveCauseParenthetical("a tree fell on the fence and gate"), "Tree on Structure");
  assert.equal(deriveCauseParenthetical("wind damage to shingles"), null);
  assert.equal(deriveCauseParenthetical(null), null);
});
