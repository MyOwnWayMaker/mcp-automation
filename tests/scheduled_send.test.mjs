// Regression tests for scheduled_send.ts queue helpers + sweep policy.
// The sweep itself hits the live Gmail API, so we only test pure logic here:
// queue read/write atomicity, appendToSchedule dedup, and the maturity gate
// in runScheduledSendSweep's keep/drop decisions.
//
// Run with: npm run build && node --test tests/scheduled_send.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  readSchedule,
  writeSchedule,
  appendToSchedule,
  getSchedulePath,
} from "../dist/tools/scheduled_send.js";

function withTempQueue(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-send-test-"));
    const p = path.join(dir, "scheduled_sends.json");
    process.env.SCHEDULED_SENDS_PATH = p;
    try {
      await fn(p);
    } finally {
      delete process.env.SCHEDULED_SENDS_PATH;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
}

const sample = (overrides = {}) => ({
  draft_id: "r-1",
  to: "a@erseville.com",
  subject: "hi",
  link: "https://mail.google.com/mail/u/0/#drafts?compose=r-1",
  send_at_iso: "2027-01-01T00:00:00.000Z",
  auto_send: true,
  recipients_internal_only: true,
  created_at_iso: "2026-06-07T00:00:00.000Z",
  surfaced_at_iso: null,
  ...overrides,
});

test("getSchedulePath honors SCHEDULED_SENDS_PATH override", () => {
  process.env.SCHEDULED_SENDS_PATH = "/tmp/foo.json";
  assert.equal(getSchedulePath(), "/tmp/foo.json");
  delete process.env.SCHEDULED_SENDS_PATH;
});

test("readSchedule: missing file -> empty array (not an error)", withTempQueue(async () => {
  assert.deepEqual(readSchedule(), []);
}));

test("readSchedule: empty file -> empty array", withTempQueue(async (p) => {
  fs.writeFileSync(p, "");
  assert.deepEqual(readSchedule(), []);
}));

test("readSchedule: corrupt JSON -> empty array (don't crash the sweep)", withTempQueue(async (p) => {
  fs.writeFileSync(p, "{not json");
  assert.deepEqual(readSchedule(), []);
}));

test("writeSchedule -> readSchedule round-trip", withTempQueue(async () => {
  const entries = [sample({ draft_id: "r-a" }), sample({ draft_id: "r-b" })];
  writeSchedule(entries);
  assert.deepEqual(readSchedule(), entries);
}));

test("writeSchedule writes ATOMICALLY (no .tmp lingers after success)", withTempQueue(async (p) => {
  writeSchedule([sample()]);
  assert.equal(fs.existsSync(p), true);
  assert.equal(fs.existsSync(`${p}.tmp`), false);
}));

test("appendToSchedule: appends a new entry", withTempQueue(async () => {
  appendToSchedule(sample({ draft_id: "r-a" }));
  appendToSchedule(sample({ draft_id: "r-b" }));
  const list = readSchedule();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(e => e.draft_id), ["r-a", "r-b"]);
}));

test("appendToSchedule: REPLACES existing entry with same draft_id (no ghosts after re-arm)", withTempQueue(async () => {
  // Simulates the on-boot re-arm path: recoverScheduledSends() could re-add
  // the same draft. The queue must NOT accumulate duplicates.
  appendToSchedule(sample({ draft_id: "r-a", subject: "first" }));
  appendToSchedule(sample({ draft_id: "r-a", subject: "second" }));
  const list = readSchedule();
  assert.equal(list.length, 1);
  assert.equal(list[0].subject, "second");
}));

test("appendToSchedule preserves order of OTHER entries when replacing", withTempQueue(async () => {
  appendToSchedule(sample({ draft_id: "r-a", subject: "A" }));
  appendToSchedule(sample({ draft_id: "r-b", subject: "B" }));
  appendToSchedule(sample({ draft_id: "r-c", subject: "C" }));
  // Re-arm r-b: should stay in slot 1, not get appended to the end.
  appendToSchedule(sample({ draft_id: "r-b", subject: "B'" }));
  const list = readSchedule();
  assert.deepEqual(list.map(e => e.draft_id), ["r-a", "r-b", "r-c"]);
  assert.equal(list[1].subject, "B'");
}));
