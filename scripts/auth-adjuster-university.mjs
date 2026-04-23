/**
 * Adjuster University auth script — logs in and saves session to JSON.
 * Opens a visible browser so you can complete any MFA or CAPTCHA manually if needed.
 *
 * Run from Mac Terminal:
 *   node /Users/hakielmcqueen/mcp-automation/scripts/auth-adjuster-university.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/adjuster_university_session.json";
const LOGIN_URL = process.env.ADJUSTER_UNIVERSITY_URL || "https://adjuster-university.com/access/";
const EMAIL = process.env.ADJUSTER_UNIVERSITY_EMAIL;
const PASSWORD = process.env.ADJUSTER_UNIVERSITY_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("Missing ADJUSTER_UNIVERSITY_EMAIL or ADJUSTER_UNIVERSITY_PASSWORD in .env");
  process.exit(1);
}

const browser = await chromium.launch({ headless: false, slowMo: 300 });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();

console.log("Opening Adjuster University login page...");
await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(2000);

// Try to auto-fill login form — common selectors used by Teachable/Thinkific/custom LMS
const filled = await page.evaluate(({ email, password }) => {
  const emailSelectors = [
    'input[name="email"]',
    'input[type="email"]',
    'input[name="username"]',
    'input[name="login"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
  ];
  const passSelectors = [
    'input[name="password"]',
    'input[type="password"]',
  ];

  let emailField = null;
  for (const sel of emailSelectors) {
    emailField = document.querySelector(sel);
    if (emailField) break;
  }
  let passField = null;
  for (const sel of passSelectors) {
    passField = document.querySelector(sel);
    if (passField) break;
  }

  if (emailField && passField) {
    emailField.value = email;
    emailField.dispatchEvent(new Event("input", { bubbles: true }));
    emailField.dispatchEvent(new Event("change", { bubbles: true }));
    passField.value = password;
    passField.dispatchEvent(new Event("input", { bubbles: true }));
    passField.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}, { email: EMAIL, password: PASSWORD });

if (filled) {
  console.log("Credentials auto-filled. Submitting...");
  await page.waitForTimeout(500);
  // Try clicking submit button
  const submitted = await page.evaluate(() => {
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:contains("Sign in")',
      'button:contains("Log in")',
      'button:contains("Login")',
    ];
    for (const sel of submitSelectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); return true; }
    }
    // Fallback: click first button
    const btn = document.querySelector("button");
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!submitted) {
    console.log("Could not auto-click submit — please click Login manually in the browser.");
  }
} else {
  console.log("\n>>> Could not auto-fill form. Please log in manually in the browser window.");
  console.log(">>> Credentials: Username=" + EMAIL + "  Password=" + PASSWORD);
}

console.log("\nWaiting up to 3 minutes for login to complete...");
console.log(">>> If you need to paste a verification link, paste it into THIS browser window's address bar.");
try {
  // Wait for URL to change away from login/access page
  await page.waitForURL(
    url => !url.href.includes("/access") && !url.href.includes("/login") && !url.href.includes("/sign-in"),
    { timeout: 180000 }
  );
  console.log("Login detected! Current URL:", page.url());
} catch {
  console.log("URL did not change — saving current session anyway.");
  console.log("Current URL:", page.url());
}

// Extra wait so you can see you're logged in before it closes
console.log("Saving session in 5 seconds...");
await page.waitForTimeout(5000);

// Save session
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
