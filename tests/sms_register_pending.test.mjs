// Regression tests for scripts/sms-register-pending.mjs.
//
// Locks the CLI contract — the pipeline orchestrator and Hakiel both invoke
// this from the shell after sending an inspection SMS. If a flag rename or
// arg-parser regression slipped in, the monitor would never see the entry
// and we'd repeat the Carol Gross "6h silent gap" failure.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

const SCRIPT = path.resolve(process.cwd(), "scripts/sms-register-pending.mjs");

function runCli(args, trackerPath) {
  // The script always writes to <repo>/data/sms_tracker.json. To isolate per
  // test, we run with cwd = a temp dir that has its own data/ subdir.
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sms-reg-"));
  fs.mkdirSync(path.join(tmpRepo, "data"));
  // Seed with an existing tracker if provided.
  if (trackerPath) fs.copyFileSync(trackerPath, path.join(tmpRepo, "data/sms_tracker.json"));
  // Resolve the script via its absolute path — sms-register-pending.mjs uses
  // __dirname/.. for REPO, so the tracker lives in the real repo. We override
  // by symlinking the real script into tmpRepo/scripts and call from there.
  const scriptDir = path.join(tmpRepo, "scripts");
  fs.mkdirSync(scriptDir);
  // Copy (not symlink) so the script's `path.dirname(import.meta.url)/..`
  // resolves to tmpRepo, not the real repo.
  fs.copyFileSync(SCRIPT, path.join(scriptDir, "sms-register-pending.mjs"));
  const res = spawnSync("node", [path.join(scriptDir, "sms-register-pending.mjs"), ...args], {
    cwd: tmpRepo,
    encoding: "utf8",
  });
  const trackerOut = path.join(tmpRepo, "data/sms_tracker.json");
  const tracker = fs.existsSync(trackerOut) ? JSON.parse(fs.readFileSync(trackerOut, "utf8")) : null;
  return { ...res, tracker, tmpRepo };
}

test("CLI: missing required flag → exit code 2", () => {
  const { status, stderr } = runCli([
    "--contact=Carol", "--claim=1", "--send-iso=2026-06-10T00:00:00Z",
    // --thread omitted
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /--thread/);
});

test("CLI: full flag set creates one tracker entry with all fields", () => {
  const { status, tracker } = runCli([
    "--thread=t.+13104861443",
    "--contact=Carol Gross",
    "--claim=3708717",
    "--company-index=1",
    "--ia-firm=PCAS",
    "--send-iso=2026-06-10T02:15:00.000Z",
    "--proposed-date=2026-06-11",
    "--window=10am-11am",
  ]);
  assert.equal(status, 0);
  assert.equal(tracker.pending.length, 1);
  const e = tracker.pending[0];
  assert.equal(e.thread_id, "t.+13104861443");
  assert.equal(e.contact_name, "Carol Gross");
  assert.equal(e.contact_phone, "+13104861443"); // derived from thread_id
  assert.equal(e.claim_id, "3708717");
  assert.equal(e.company_index, 1);
  assert.equal(e.ia_firm, "PCAS");
  assert.equal(e.send_iso, "2026-06-10T02:15:00.000Z");
  assert.equal(e.proposed_date_iso, "2026-06-11");
  assert.equal(e.proposed_time_window, "10am-11am");
  assert.equal(e.resolved, false);
  assert.equal(e.two_hour_warned, false);
  assert.equal(e.last_processed_inbound_iso, null);
});

test("CLI: --key value form (space-separated) is equivalent to --key=value", () => {
  const { status, tracker } = runCli([
    "--thread", "t.+15551234567",
    "--contact", "Test Person",
    "--claim", "99999",
    "--send-iso", "2026-06-11T01:00:00.000Z",
  ]);
  assert.equal(status, 0);
  assert.equal(tracker.pending[0].thread_id, "t.+15551234567");
  assert.equal(tracker.pending[0].contact_name, "Test Person");
});

test("CLI: re-registering same id replaces (no duplicate)", () => {
  // First register
  const seed = runCli([
    "--thread=t.+15551112222",
    "--contact=Duplicate Tester",
    "--claim=A",
    "--send-iso=2026-06-10T00:00:00.000Z",
    "--proposed-date=2026-06-11",
  ]);
  // Re-register with different claim_id but same id (id = contact-slug + send_iso date)
  const seedTracker = path.join(seed.tmpRepo, "data/sms_tracker.json");
  const { tracker } = runCli([
    "--thread=t.+15551112222",
    "--contact=Duplicate Tester",
    "--claim=B-UPDATED",
    "--send-iso=2026-06-10T05:00:00.000Z", // same DATE → same id
    "--proposed-date=2026-06-11",
  ], seedTracker);
  assert.equal(tracker.pending.length, 1, "must replace, not duplicate");
  assert.equal(tracker.pending[0].claim_id, "B-UPDATED");
});

test("CLI: different send-iso DATE produces a new entry", () => {
  const seed = runCli([
    "--thread=t.+15551112222",
    "--contact=Two Day Tester",
    "--claim=X",
    "--send-iso=2026-06-10T00:00:00.000Z",
  ]);
  const seedTracker = path.join(seed.tmpRepo, "data/sms_tracker.json");
  const { tracker } = runCli([
    "--thread=t.+15551112222",
    "--contact=Two Day Tester",
    "--claim=Y",
    "--send-iso=2026-06-11T00:00:00.000Z", // different DATE
  ], seedTracker);
  assert.equal(tracker.pending.length, 2);
});
