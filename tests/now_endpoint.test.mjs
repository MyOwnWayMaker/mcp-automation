// Unit tests for buildNowPayload (the helper behind GET /now).
// Run after `npm run build` with: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { buildNowPayload } from "../dist/util/now.js";

test("buildNowPayload: iso_utc parses cleanly", () => {
  const p = buildNowPayload();
  const d = new Date(p.iso_utc);
  assert.ok(!Number.isNaN(d.getTime()), "iso_utc must be a valid Date");
  assert.match(p.iso_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("buildNowPayload: date_pacific matches iso_pacific date prefix", () => {
  const p = buildNowPayload();
  assert.equal(p.date_pacific, p.iso_pacific.slice(0, 10));
});

test("buildNowPayload: weekday_pacific matches Intl output for the same instant", () => {
  const now = new Date();
  const p = buildNowPayload(now);
  const expected = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
  }).format(now);
  assert.equal(p.weekday_pacific, expected);
});

test("buildNowPayload: tz_offset_minutes is PDT (-420) or PST (-480)", () => {
  const p = buildNowPayload();
  assert.ok(
    p.tz_offset_minutes === -420 || p.tz_offset_minutes === -480,
    `expected -420 or -480, got ${p.tz_offset_minutes}`,
  );
});

test("buildNowPayload: unix_seconds is within 5s of Date.now()", () => {
  const before = Math.floor(Date.now() / 1000);
  const p = buildNowPayload();
  const after = Math.floor(Date.now() / 1000);
  assert.ok(
    p.unix_seconds >= before - 1 && p.unix_seconds <= after + 1,
    `unix_seconds ${p.unix_seconds} not bracketed by [${before}, ${after}]`,
  );
});

test("buildNowPayload: time_pacific_24h matches HH:MM in 0-23 range", () => {
  const p = buildNowPayload();
  assert.match(p.time_pacific_24h, /^([01]\d|2[0-3]):[0-5]\d$/);
});

test("buildNowPayload: time_pacific_12h has AM/PM and 1-12 hour", () => {
  const p = buildNowPayload();
  assert.match(p.time_pacific_12h, /^(1[0-2]|[1-9]):[0-5]\d (AM|PM)$/);
});

test("buildNowPayload: timezone is America/Los_Angeles", () => {
  const p = buildNowPayload();
  assert.equal(p.timezone, "America/Los_Angeles");
});

test("buildNowPayload: deterministic for a fixed instant (PDT, 2026-07-04 noon UTC)", () => {
  // 2026-07-04 12:00:00 UTC = 2026-07-04 05:00 PDT (UTC-7)
  const fixed = new Date("2026-07-04T12:00:00.000Z");
  const p = buildNowPayload(fixed);
  assert.equal(p.date_pacific, "2026-07-04");
  assert.equal(p.weekday_pacific, "Saturday");
  assert.equal(p.time_pacific_24h, "05:00");
  assert.equal(p.time_pacific_12h, "5:00 AM");
  assert.equal(p.tz_offset_minutes, -420);
  assert.equal(p.iso_pacific, "2026-07-04T05:00:00.000-07:00");
  assert.equal(p.unix_seconds, Math.floor(fixed.getTime() / 1000));
});

test("buildNowPayload: deterministic for a fixed instant (PST, 2026-01-15 noon UTC)", () => {
  // 2026-01-15 12:00:00 UTC = 2026-01-15 04:00 PST (UTC-8)
  const fixed = new Date("2026-01-15T12:00:00.000Z");
  const p = buildNowPayload(fixed);
  assert.equal(p.date_pacific, "2026-01-15");
  assert.equal(p.weekday_pacific, "Thursday");
  assert.equal(p.time_pacific_24h, "04:00");
  assert.equal(p.time_pacific_12h, "4:00 AM");
  assert.equal(p.tz_offset_minutes, -480);
  assert.equal(p.iso_pacific, "2026-01-15T04:00:00.000-08:00");
});
