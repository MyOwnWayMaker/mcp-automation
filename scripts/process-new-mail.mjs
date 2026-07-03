#!/usr/bin/env node
// process-new-mail.mjs — claim-pipeline entry point.
//
// Usage:
//   node scripts/process-new-mail.mjs               # live: scan + act + mark processed
//   node scripts/process-new-mail.mjs --dry-run     # plan only, no Drive/Queststar writes
//   node scripts/process-new-mail.mjs --message <id> [--dry-run]
//   node scripts/process-new-mail.mjs --since-days 14
//
// Cron via launchd com.hakiel.claim-pipeline.plist; the orchestrator is
// idempotent so re-running is safe (state file dedups message IDs).

import "./pipeline/env.mjs";
import { processBatch, processMessage } from "./pipeline/orchestrator.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (i + 1 < args.length && !args[i + 1].startsWith("--")) return args[i + 1];
  return true;
};

const dryRun = !!flag("--dry-run");
const messageId = flag("--message");
const since_days = parseInt(flag("--since-days") ?? "7", 10);
const query = flag("--query");
const max_messages = parseInt(flag("--max") ?? "25", 10);

(async () => {
  try {
    let result;
    if (messageId) {
      result = await processMessage(messageId, { dryRun });
    } else {
      result = await processBatch({ since_days, query, max_messages, dryRun });
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("FAIL:", e?.stack ?? e?.message ?? e);
    process.exit(1);
  }
})();
