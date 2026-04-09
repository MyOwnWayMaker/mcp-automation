/**
 * XactAnalysis auth script — opens visible browser, auto-fills email + password,
 * then waits for you to complete MFA manually. Session saved automatically.
 *
 * Run: node /Users/hakielmcqueen/mcp-automation/scripts/auth-xactanalysis.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/xactanalysis_session.json";

const browser = await chromium.launch({ headless: false, slowMo: 300 });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

console.log("Opening XactAnalysis...");
await page.goto("https://www.xactanalysis.com");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(2000);

// Step 1: fill email and click NEXT
await page.fill('input[name="preAuthEmailField"]', process.env.XACTANALYSIS_EMAIL);
await page.click('button:has-text("NEXT")');
await page.waitForTimeout(3000);

// Step 2: fill password on identity.verisk.com
const pwdField = page.locator('input[name="passwordField"]');
if (await pwdField.count() > 0) {
  await pwdField.fill(process.env.XACTANALYSIS_PASSWORD);
  // Check "Remember this device" to reduce future MFA
  await page.check('input[type="checkbox"]').catch(() => {});
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
}

console.log("\n>>> MFA screen should now be showing.");
console.log(">>> Choose Email or SMS, enter the code, and click SELECT/VERIFY.");
console.log(">>> Check 'Remember this device' if offered.");
console.log("\nWaiting up to 120 seconds for you to complete MFA...\n");

// Wait for redirect back to xactanalysis.com
try {
  await page.waitForURL(url => url.href.includes("xactanalysis.com") && !url.href.includes("identity.verisk"), { timeout: 120000 });
  console.log("✅ Login successful! URL:", page.url());
} catch {
  console.log("Timed out — saving whatever session exists...");
}

await page.waitForTimeout(3000);

// Capture all cookies from all domains
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

console.log("Cookies:", cookies.length);
console.log("localStorage keys:", Object.keys(localStorageData).length);
console.log("sessionStorage keys:", Object.keys(sessionStorageData).length);

fs.writeFileSync(SESSION_PATH, JSON.stringify({ cookies, localStorage: localStorageData, sessionStorage: sessionStorageData }, null, 2));
console.log(`\n✅ Session saved to ${SESSION_PATH}`);

await page.waitForTimeout(3000);
await browser.close();
console.log("Done!");
