/**
 * FileTrac auth script — opens visible browser, you complete MFA manually,
 * then session is saved automatically.
 *
 * Run: node /Users/hakielmcqueen/mcp-automation/scripts/auth-filetrac.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/filetrac_session.json";

const browser = await chromium.launch({ headless: false, slowMo: 500 });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

console.log("Opening FileTrac...");
await page.goto("https://ftevolve.com/auth/login");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(2000);

// Fill credentials
await page.fill('input[name="email"]', process.env.FILETRAC_EMAIL);
await page.fill('input[name="password"]', process.env.FILETRAC_PASSWORD);
await page.click('button[type="submit"]').catch(() => page.locator("button").first().click());

console.log("\n>>> MFA screen should now be showing in the browser.");
console.log(">>> 1. Check 'Remember device for 30 days'");
console.log(">>> 2. Enter your MFA code in the browser");
console.log(">>> 3. Click Submit in the browser");
console.log("\nWaiting up to 90 seconds for you to complete MFA...\n");

// Wait for redirect away from auth pages (up to 90 seconds)
try {
  await page.waitForURL(url => !url.href.includes("/auth/"), { timeout: 90000 });
  console.log("✅ Login detected! URL:", page.url());
} catch {
  console.log("Timed out waiting — saving whatever session exists...");
}

await page.waitForTimeout(2000);

// Capture Cognito session data
const cookies = await context.cookies();
const localStorageData = await page.evaluate(() => {
  const data = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    data[key] = window.localStorage.getItem(key);
  }
  return data;
});
const sessionStorageData = await page.evaluate(() => {
  const data = {};
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    data[key] = window.sessionStorage.getItem(key);
  }
  return data;
});

console.log("Cookies:", cookies.length);
console.log("localStorage keys:", Object.keys(localStorageData));

// ── Capture ASP session cookie by clicking "See Jobs" ──────────────────────
// This populates aspBase + aspCookies so the MCP fast path works immediately
// without needing the full browser flow on every get_claim call.
let aspBase = null;
let aspCookies = null;

console.log("\nNavigating to linked-companies to capture ASP session cookie...");
try {
  await page.goto("https://ftevolve.com/app/legacy/linked-companies", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector('button:has-text("See Jobs")', { timeout: 20000 });

  const seeJobsBtns = await page.locator('button:has-text("See Jobs")').all();
  if (seeJobsBtns.length > 0) {
    // Index 1 = Premier Claims (the main company)
    const idx = Math.min(1, seeJobsBtns.length - 1);
    console.log(`Clicking "See Jobs" (index ${idx})...`);
    await seeJobsBtns[idx].click();
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
    await page.waitForTimeout(1500);

    aspBase = new URL(page.url()).origin;
    const allCookies = await context.cookies();
    const aspDomain = new URL(aspBase).hostname;
    const aspCookieList = allCookies
      .filter(c => c.domain.includes(aspDomain))
      .map(c => `${c.name}=${c.value}`)
      .join("; ");

    if (aspCookieList) {
      aspCookies = aspCookieList;
      console.log(`✅ ASP session captured: ${aspBase}`);
      console.log(`   Cookies: ${aspCookieList.substring(0, 80)}...`);
    } else {
      console.log("⚠️  No ASP cookies found — fast path will not be available");
    }
  }
} catch (e) {
  console.log(`⚠️  Could not capture ASP session: ${e.message}`);
  console.log("   The session will still work, but get_claim will use the slower browser path.");
}

const sessionData = {
  cookies,
  localStorage: localStorageData,
  sessionStorage: sessionStorageData,
  ...(aspBase ? { aspBase } : {}),
  ...(aspCookies ? { aspCookies } : {}),
  ...(aspBase ? { aspCookiesSavedAt: new Date().toISOString() } : {}),
};

fs.writeFileSync(SESSION_PATH, JSON.stringify(sessionData, null, 2));
console.log(`\n✅ Session saved to ${SESSION_PATH}`);
if (aspBase) {
  console.log(`✅ ASP fast-path enabled — get_claim will now respond in ~1 second`);
}

await page.waitForTimeout(2000);
await browser.close();
console.log("Done!");
