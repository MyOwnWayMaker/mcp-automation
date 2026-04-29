/**
 * One-shot: read voice_session.json, drop redundant fields, write
 * voice_session.compact.json. Used to fit under Railway's 32KB env
 * var limit without re-running the browser auth flow.
 */
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const IN_PATH = path.join(REPO_ROOT, "voice_session.json");
const OUT_PATH = path.join(REPO_ROOT, "voice_session.compact.json");

const full = JSON.parse(fs.readFileSync(IN_PATH, "utf-8"));

// storageState already contains the cookies AND origins.localStorage that
// Playwright needs. Everything else in the file was scaffolding for the
// abandoned RPC path and is no longer used by voice.ts.
const compact = {
  account: full.account,
  savedAt: full.savedAt,
  storageState: full.storageState,
};

const compactStr = JSON.stringify(compact);
fs.writeFileSync(OUT_PATH, compactStr);

const before = fs.statSync(IN_PATH).size;
const after = compactStr.length;
console.log(`Before: ${before} bytes`);
console.log(`After:  ${after} bytes`);
console.log(`Reduction: ${Math.round((1 - after / before) * 100)}%`);
console.log(`Fits under Railway 32KB cap: ${after < 32768 ? "yes" : "NO"}`);
console.log(`\nWrote ${OUT_PATH}`);
