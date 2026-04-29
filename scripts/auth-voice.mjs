/**
 * Google Voice auth script — opens a visible Chromium, you sign in to
 * voice.google.com under hdynamo217@gmail.com, then session is saved.
 *
 * Run from the repo root:
 *   node scripts/auth-voice.mjs
 *
 * Re-run any time the session expires.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import readline from "readline";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SESSION_PATH = process.env.VOICE_SESSION_PATH || path.join(REPO_ROOT, "voice_session.json");

// Google's "browser not secure" block triggers on automation signals like
// --enable-automation and navigator.webdriver=true. Strip those.
const browser = await chromium.launch({
  headless: false,
  slowMo: 100,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
});
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
});
// Mask the webdriver flag before any page script runs
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  // Also fake plugins/languages that headless-detection scripts check
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  Object.defineProperty(navigator, "plugins", {
    get: () => [{ name: "Chrome PDF Plugin" }, { name: "Chrome PDF Viewer" }, { name: "Native Client" }],
  });
});
const page = await context.newPage();

console.log("Opening voice.google.com...");
await page.goto("https://voice.google.com/u/0/messages", { waitUntil: "domcontentloaded" });

console.log("\n>>> Sign in as hdynamo217@gmail.com (or whichever Voice account you want).");
console.log(">>> Complete any 2-step verification.");
console.log(">>> Take all the time you need — there is no countdown.");
console.log("\n>>> When you see your Messages inbox loaded in the browser,");
console.log(">>> come back to this terminal and press ENTER to save the session.\n");

// Wait for ENTER from the user — no timeout. They drive the pace.
await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Press ENTER once your Voice inbox is fully loaded… ", () => {
    rl.close();
    resolve();
  });
});

// Sanity check: did we actually end up on a logged-in Voice page?
const finalUrl = page.url();
console.log(`Current URL: ${finalUrl}`);
if (finalUrl.includes("accounts.google.com")) {
  console.log("⚠️  Browser is still on the Google sign-in page. Saving anyway, but the session will not work.");
  console.log("    Finish login in the browser THEN press ENTER again — or close the browser to abort.");
}
await page.waitForTimeout(1500);

// Capture cookies + storage
const cookies = await context.cookies();
const localStorageData = await page.evaluate(() => {
  const data = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    data[key] = window.localStorage.getItem(key);
  }
  return data;
}).catch(() => ({}));
const sessionStorageData = await page.evaluate(() => {
  const data = {};
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    data[key] = window.sessionStorage.getItem(key);
  }
  return data;
}).catch(() => ({}));

// Pull out the SAPISID for future RPC reverse-engineering work.
const sapisid = cookies.find(c => c.name === "SAPISID")?.value
  ?? cookies.find(c => c.name === "__Secure-3PAPISID")?.value
  ?? null;

// Build a Cookie header string suitable for fetch() to *.google.com.
const googleCookieHeader = cookies
  .filter(c => c.domain.endsWith("google.com") || c.domain === ".google.com")
  .map(c => `${c.name}=${c.value}`)
  .join("; ");

// Build a Playwright storageState the Playwright path can re-import.
const storageState = await context.storageState();

const sessionData = {
  account: "hdynamo217@gmail.com",
  savedAt: new Date().toISOString(),
  cookies,
  localStorage: localStorageData,
  sessionStorage: sessionStorageData,
  storageState,
  // Convenience fields for the (future) RPC fast-path
  googleCookieHeader,
  sapisid,
};

fs.writeFileSync(SESSION_PATH, JSON.stringify(sessionData, null, 2));
console.log(`\n✅ Voice session saved to ${SESSION_PATH}`);
console.log(`   Cookies: ${cookies.length}`);
console.log(`   SAPISID present: ${sapisid ? "yes" : "NO — fast-path RPC unavailable"}`);
console.log(`\nFor Railway: copy the file's contents into the VOICE_SESSION_JSON env var.`);

await page.waitForTimeout(1500);
await browser.close();
console.log("Done!");
