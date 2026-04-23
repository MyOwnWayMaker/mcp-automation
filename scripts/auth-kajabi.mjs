/**
 * Kajabi auth script — logs into Tax Wealth Tips course and saves session.
 * Opens visible browser for manual completion if auto-login fails.
 *
 * Run from Mac Terminal:
 *   node /Users/hakielmcqueen/mcp-automation/scripts/auth-kajabi.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/kajabi_session.json";
const LOGIN_URL = process.env.KAJABI_URL || "https://tax-free-wealth-challenge.mykajabi.com/login";
const EMAIL = process.env.KAJABI_EMAIL;
const PASSWORD = process.env.KAJABI_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("Missing KAJABI_EMAIL or KAJABI_PASSWORD in .env");
  process.exit(1);
}

const browser = await chromium.launch({ headless: false, slowMo: 300 });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();

console.log("Opening Kajabi login page:", LOGIN_URL);
await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(2000);

// Kajabi's standard login form
try {
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.waitForTimeout(500);
  await page.click('button[type="submit"]');
  console.log("Credentials submitted.");
} catch {
  // Fallback: try other selectors
  try {
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    console.log("Credentials submitted (fallback selectors).");
  } catch {
    console.log("Auto-fill failed. Please log in manually in the browser window.");
    console.log("Email:", EMAIL, "  Password:", PASSWORD);
  }
}

console.log("\nWaiting up to 60 seconds for login to complete...");
try {
  await page.waitForURL(
    url => !url.href.includes("/login") && !url.href.includes("/sign_in"),
    { timeout: 60000 }
  );
  console.log("Login detected! Current URL:", page.url());
} catch {
  console.log("URL did not change — saving session anyway. URL:", page.url());
}

await page.waitForTimeout(2000);

const cookies = await context.cookies();
const localStorageData = await page.evaluate(() => {
  const data = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    data[key] = window.localStorage.getItem(key);
  }
  return data;
});

fs.writeFileSync(
  SESSION_PATH,
  JSON.stringify({ cookies, localStorage: localStorageData, loginUrl: page.url(), savedAt: new Date().toISOString() }, null, 2)
);
console.log(`\nSession saved to ${SESSION_PATH}`);
console.log(`Cookies saved: ${cookies.length}`);
console.log("You can now run the scraper.");

await page.waitForTimeout(2000);
await browser.close();
console.log("Done!");
