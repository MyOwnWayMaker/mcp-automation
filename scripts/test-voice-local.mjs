/**
 * Smoke test: run voiceListThreads directly on the local VM (no MCP harness).
 * Reads voice_session.json from disk (same as the deployed tool does on Railway,
 * except Railway uses the env var while local uses the file).
 *
 * Run from the repo root after capturing a session:
 *   node scripts/test-voice-local.mjs
 *
 * Set VOICE_HEADLESS=false to run with a visible browser window for debugging.
 */
import { voiceListThreads } from "../dist/tools/voice.js";

console.log("Running voice_list_threads locally...");
console.log("(headless mode — set VOICE_HEADLESS=false to watch)\n");

const start = Date.now();
const result = await voiceListThreads({ limit: 5 });
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`Took ${elapsed}s\n`);
console.log("─── Result ───");
console.log(result.content[0].text);
console.log("─── End ───");
