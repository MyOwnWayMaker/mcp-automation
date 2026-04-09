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

// Capture session data
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
console.log("sessionStorage keys:", Object.keys(sessionStorageData));

fs.writeFileSync(SESSION_PATH, JSON.stringify({ cookies, localStorage: localStorageData, sessionStorage: sessionStorageData }, null, 2));
console.log(`\n✅ Session saved to ${SESSION_PATH}`);

await page.waitForTimeout(3000);
await browser.close();
console.log("Done!");
