/**
 * Smoke test: voice_get_thread by contact (phone number).
 *
 * Usage:  node scripts/test-voice-get-thread.mjs "(909) 709-2452"
 *   (any phone number / contact name visible in your inbox)
 */
import { voiceGetThread } from "../dist/tools/voice.js";

const contact = process.argv[2];
if (!contact) {
  console.error("Usage: node scripts/test-voice-get-thread.mjs \"<contact name or phone>\"");
  process.exit(1);
}

console.log(`Fetching thread for "${contact}"...`);
const start = Date.now();
const result = await voiceGetThread({ contact, max_messages: 200 });
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`Took ${elapsed}s\n`);
console.log("─── Result ───");
console.log(result.content[0].text);
console.log("─── End ───");
