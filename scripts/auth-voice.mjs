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

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SESSION_PATH = process.env.VOICE_SESSION_PATH || path.join(REPO_ROOT, "voice_session.json");

const browser = await chromium.launch({ headless: false, slowMo: 200 });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

console.log("Opening voice.google.com...");
await page.goto("https://voice.google.com/u/0/messages", { waitUntil: "domcontentloaded" });

console.log("\n>>> Sign in as hdynamo217@gmail.com (or whichever Voice account you want).");
console.log(">>> Complete any 2-step verification.");
console.log(">>> Once you see your inbox, this script will detect it and save the session.\n");
console.log("Waiting up to 5 minutes...");

try {
  // Detect we are on a logged-in voice page (URL is /messages or /calls or similar,
  // and there's no signin form). Generous timeout for slow MFA / device approval.
  await page.waitForFunction(
    () => location.href.includes("voice.google.com") && !location.href.includes("accounts.google.com") &&
          !!document.querySelector("body"),
    { timeout: 5 * 60 * 1000 }
  );
  // Extra grace for the inbox to render
  await page.waitForTimeout(3000);
  console.log("✅ Logged-in page detected:", page.url());
} catch {
  console.log("⚠️  Timed out waiting for login. Saving whatever session exists...");
}

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
