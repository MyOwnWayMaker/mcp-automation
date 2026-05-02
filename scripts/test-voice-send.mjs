/**
 * Smoke test: run voiceSendSms directly on the local VM (bypasses Railway,
 * which hits Voice's bot detection). Reads voice_session.json from the repo
 * root and runs the same Playwright flow the deployed tool uses.
 *
 * Usage:
 *   node scripts/test-voice-send.mjs --number "+15551234567" --body "test message"
 *   node scripts/test-voice-send.mjs --thread "+15551234567" --body "follow up"
 *   node scripts/test-voice-send.mjs --number "+15551234567" --body "..." --skip-verify
 *
 * VOICE_HEADLESS=false runs with a visible browser window for debugging UI hiccups.
 */
import { voiceSendSms } from "../dist/tools/voice.js";

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--number") flags.number = args[++i];
  else if (a === "--thread") flags.thread_id = args[++i];
  else if (a === "--body") flags.body = args[++i];
  else if (a === "--skip-verify") flags.skip_verify = true;
  else if (a === "--force") flags.force = true;
}

if (!flags.body) {
  console.error("Missing --body");
  console.error('Usage: node scripts/test-voice-send.mjs --number "+15551234567" --body "..."');
  process.exit(1);
}
if (!flags.number && !flags.thread_id) {
  console.error("Missing --number or --thread");
  process.exit(1);
}

console.log("Sending Voice SMS locally...");
console.log("Args:", JSON.stringify({ ...flags, body: flags.body.slice(0, 60) + (flags.body.length > 60 ? "…" : "") }, null, 2));
console.log("(headless mode — set VOICE_HEADLESS=false to watch)\n");

const start = Date.now();
const result = await voiceSendSms(flags);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`Took ${elapsed}s\n`);
console.log("─── Result ───");
console.log(result.content[0].text);
console.log("─── End ───");
