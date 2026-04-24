/**
 * XactAnalysis auth script — fully automated.
 * Clicks the first SELECT button (email MFA), reads OTP from Gmail, types it in the browser.
 *
 * Run: node /Users/hakielmcqueen/mcp-automation/scripts/auth-xactanalysis.mjs
 */
import { chromium } from "playwright";
import { google } from "googleapis";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/xactanalysis_session.json";
const TOKEN_PATH   = "/Users/hakielmcqueen/mcp-automation/token.json";
const CREDS_PATH   = "/Users/hakielmcqueen/mcp-automation/credentials.json";

// ── Gmail helper ──────────────────────────────────────────────────────────────
function buildGmailClient() {
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
  const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oauth2.setCredentials(token);
  return google.gmail({ version: "v1", auth: oauth2 });
}

async function fetchOtpFromGmail(afterMs, timeoutMs = 90000) {
  const gmail = buildGmailClient();
  const deadline = Date.now() + timeoutMs;
  console.log(">>> Polling Gmail for OTP email (up to 90 seconds)...");

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      // Broad search — Verisk sends from various subdomains
      const list = await gmail.users.messages.list({
        userId: "me",
        q: "newer_than:1d",
        maxResults: 10,
      });
      const messages = list.data.messages || [];
      for (const msg of messages) {
        const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
        const internalDate = parseInt(full.data.internalDate, 10);
        if (internalDate < afterMs) continue;

        // Get sender
        const fromHeader = full.data.payload?.headers?.find(h => h.name === "From")?.value || "";
        const subjectHeader = full.data.payload?.headers?.find(h => h.name === "Subject")?.value || "";
        console.log(`  Checking email: from="${fromHeader}" subject="${subjectHeader}"`);

        // Extract body text (handle nested parts)
        function extractBody(payload) {
          if (!payload) return "";
          if (payload.body?.data) {
            return Buffer.from(payload.body.data, "base64").toString("utf8");
          }
          if (payload.parts) {
            return payload.parts.map(extractBody).join("\n");
          }
          return "";
        }
        const body = extractBody(full.data.payload);

        // Look for a 4–8 digit OTP (standalone number)
        const match = body.match(/\b(\d{4,8})\b/);
        if (match && (
          fromHeader.toLowerCase().includes("verisk") ||
          fromHeader.toLowerCase().includes("xact") ||
          subjectHeader.toLowerCase().includes("code") ||
          subjectHeader.toLowerCase().includes("verif") ||
          subjectHeader.toLowerCase().includes("one-time")
        )) {
          console.log(`✅ OTP found: ${match[1]} (from: ${fromHeader})`);
          return match[1];
        }
      }
    } catch (e) {
      console.log("  Gmail poll error:", e.message);
    }
  }
  throw new Error("Timed out waiting for OTP email.");
}

// ── Browser login ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: false, slowMo: 200 });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

console.log("Opening XactAnalysis...");
await page.goto("https://www.xactanalysis.com");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(2000);

// Step 1: email → NEXT
await page.fill('input[name="preAuthEmailField"]', process.env.XACTANALYSIS_EMAIL);
await page.click('button:has-text("NEXT")');
await page.waitForTimeout(3000);

// Step 2: password
const pwdField = page.locator('input[name="passwordField"]');
if (await pwdField.count() > 0) {
  await pwdField.fill(process.env.XACTANALYSIS_PASSWORD);
  await page.check('input[type="checkbox"]').catch(() => {});
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
}

// Step 3: MFA — wait for SELECT buttons, click first one (email)
console.log("\n>>> Waiting for MFA screen...");
const mfaTriggeredAt = Date.now();

try {
  // Wait up to 15 seconds for the SELECT button to appear
  const selectBtn = page.locator('button:has-text("SELECT")').first();
  await selectBtn.waitFor({ state: "visible", timeout: 15000 });
  console.log("✅ MFA screen detected");

  await selectBtn.click();
  console.log("✅ Clicked first SELECT (email option)");
  await page.waitForTimeout(2000);

  // Step 4: Read OTP from Gmail
  const otp = await fetchOtpFromGmail(mfaTriggeredAt);

  // Step 5: Find OTP input and type the code
  await page.waitForTimeout(1000);
  const otpSelectors = [
    'input[name="otpCode"]',
    'input[autocomplete="one-time-code"]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[type="text"][maxlength]',
    'input[placeholder*="code" i]',
    'input[placeholder*="enter" i]',
  ];

  let otpEntered = false;
  for (const sel of otpSelectors) {
    const field = page.locator(sel).first();
    if (await field.isVisible({ timeout: 3000 }).catch(() => false)) {
      await field.fill(otp);
      console.log(`✅ Entered OTP "${otp}" into field: ${sel}`);
      otpEntered = true;
      break;
    }
  }

  if (!otpEntered) {
    console.log("⚠️  Could not find OTP input field — please enter the code manually: " + otp);
  } else {
    // Submit OTP
    for (const selector of [
      'button:has-text("Verify")',
      'button:has-text("Submit")',
      'button:has-text("Continue")',
      'button:has-text("Sign in")',
      'button[type="submit"]',
    ]) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        console.log(`✅ Submitted OTP`);
        break;
      }
    }
  }
} catch (e) {
  console.log(">>> MFA step error:", e.message);
  console.log(">>> Please complete MFA manually in the browser if it's open.");
}

// Step 6: Wait for successful redirect
console.log("\n>>> Waiting up to 120 seconds for XactAnalysis dashboard...");
try {
  await page.waitForURL(
    url => url.href.includes("xactanalysis.com") && !url.href.includes("identity.verisk"),
    { timeout: 120000 }
  );
  console.log("✅ Login successful! URL:", page.url());
} catch {
  console.log("Timed out — saving whatever session exists...");
}

await page.waitForTimeout(3000);

// Capture session
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

console.log(`\nCookies: ${cookies.length}`);
console.log(`localStorage keys: ${Object.keys(localStorageData).length}`);

fs.writeFileSync(SESSION_PATH, JSON.stringify({
  cookies,
  localStorage: localStorageData,
  sessionStorage: sessionStorageData
}, null, 2));
console.log(`\n✅ Session saved to ${SESSION_PATH}`);

await page.waitForTimeout(2000);
await browser.close();
console.log("Done!");
