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

// Step 3: Auto-select SMS on MFA screen
console.log("\n>>> Checking for MFA screen...");
await page.waitForTimeout(2000);

try {
  // Click the "Send it through text message" option
  const smsOption = page.locator('text="Send it through text message"').first();
  if (await smsOption.isVisible({ timeout: 5000 })) {
    await smsOption.click();
    console.log("✅ Selected 'Send it through text message'");
    await page.waitForTimeout(1000);

    // Click the Send/Select/Submit button
    for (const selector of [
      'button:has-text("Send")',
      'button:has-text("SELECT")',
      'button:has-text("Submit")',
      'button[type="submit"]',
    ]) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        console.log(`✅ Clicked submit button`);
        break;
      }
    }
    console.log("\n>>> SMS code sent to your phone. Enter it below when it arrives.");
  } else {
    console.log(">>> MFA screen not detected or already past it — waiting for manual completion.");
  }
} catch {
  console.log(">>> Could not auto-select SMS — please complete MFA manually in the browser.");
}

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
