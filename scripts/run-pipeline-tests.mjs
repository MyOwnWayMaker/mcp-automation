#!/usr/bin/env node
/**
 * run-pipeline-tests.mjs — runs the pipeline test suite and ntfy's on any
 * failure. Invoked from launchd com.hakiel.pipeline-tests every ~6h.
 *
 * Why a wrapper instead of `node --test tests/`:
 *   - `npm test` does a full `tsc` build first; this is a fast regression
 *     loop that only needs to exercise the .mjs test files.
 *   - We only want to ntfy on FAILURE, not every periodic green run.
 *
 * Env:
 *   PIPELINE_TESTS_NTFY_TOPIC   default `hakiel-mac-mini-xa-reauth`
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NTFY_TOPIC = process.env.PIPELINE_TESTS_NTFY_TOPIC || "hakiel-mac-mini-xa-reauth";

const PIPELINE_TEST_FILES = [
  "tests/sms_monitor.test.mjs",
  "tests/sms_register_pending.test.mjs",
  "tests/orchestrator_helpers.test.mjs",
  "tests/queststar_wire.test.mjs",
];

const present = PIPELINE_TEST_FILES.filter((f) => fs.existsSync(path.join(REPO, f)));
const missing = PIPELINE_TEST_FILES.filter((f) => !fs.existsSync(path.join(REPO, f)));

const startIso = new Date().toISOString();
console.log(`=== pipeline-tests ${startIso} ===`);
console.log(`running: ${present.join(", ")}`);
if (missing.length) console.log(`missing (will warn): ${missing.join(", ")}`);

const res = spawnSync("node", ["--test", ...present], {
  cwd: REPO,
  encoding: "utf8",
  env: { ...process.env, NODE_NO_WARNINGS: "1" },
});

console.log(res.stdout);
if (res.stderr) console.error(res.stderr);

// node --test exit code: 0 = all pass, 1 = at least one fail.
const code = res.status ?? 1;
const passLine = (res.stdout.match(/pass\s+(\d+)/) || [])[1] || "?";
const failLine = (res.stdout.match(/fail\s+(\d+)/) || [])[1] || "?";

async function ntfy(title, body, priority = "default", tags = "") {
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: "POST",
      headers: {
        Title: title.replace(/[—–]/g, "-").replace(/[^\x20-\x7E]/g, "?"),
        Priority: priority,
        Tags: tags,
      },
      body,
    });
  } catch (e) {
    console.error("ntfy error:", e.message);
  }
}

if (missing.length) {
  await ntfy(
    "pipeline-tests: missing files",
    `${missing.length} test file(s) not found:\n${missing.join("\n")}\n\nCheck the repo state.`,
    "default",
    "warning",
  );
}

if (code !== 0) {
  await ntfy(
    `pipeline-tests FAILED (${failLine}/${Number(passLine) + Number(failLine || 0)})`,
    `${failLine} fail / ${passLine} pass at ${startIso}\n\nSee logs/pipeline-tests.stderr.log.`,
    "high",
    "rotating_light",
  );
  process.exit(1);
}

console.log(`✓ all green (${passLine} tests)`);
process.exit(0);
