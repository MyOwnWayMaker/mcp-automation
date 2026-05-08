/**
 * XactAnalysis auth script — Windows/Railway-portable.
 *
 * Drives Verisk SSO with email + password, clicks email-MFA option,
 * polls the user's primary Gmail inbox for the OTP, types it in,
 * and saves the resulting session.
 *
 * Run from repo root:
 *   node scripts/auth-xactanalysis.mjs
 *
 * Reads from env vars (or falls back to local files at the repo root):
 *   - GOOGLE_CREDENTIALS_JSON or credentials.json
 *   - GOOGLE_TOKEN_JSON       or token.json
 *   - XACTANALYSIS_EMAIL      (required — Verisk SSO email)
 *   - XACTANALYSIS_PASSWORD   (required — Verisk SSO password)
 *
 * Writes:
 *   - xactanalysis_session.json (full session, repo root)
 */
import { chromium } from "playwright";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const REPO_ROOT = process.cwd();
const ENV_PATH = path.resolve(REPO_ROOT, ".env");
if (fs.existsSync(ENV_PATH)) {
  dotenv.config({ path: ENV_PATH });
}

const SESSION_PATH = path.resolve(REPO_ROOT, "xactanalysis_session.json");
const TOKEN_PATH   = path.resolve(REPO_ROOT, "token.json");
const CREDS_PATH   = path.resolve(REPO_ROOT, "credentials.json");

if (!process.env.XACTANALYSIS_EMAIL || !process.env.XACTANALYSIS_PASSWORD) {
  console.error("❌ XACTANALYSIS_EMAIL and XACTANALYSIS_PASSWORD must be set (env var or .env file).");
  process.exit(1);
}

// ── Gmail helper (uses primary Gmail to read the OTP email) ──────────────────
function loadCreds() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(
      `Need Gmail credentials. Either set GOOGLE_CREDENTIALS_JSON env var or save credentials.json at ${CREDS_PATH}`
    );
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
}
function loadToken() {
  if (process.env.GOOGLE_TOKEN_JSON) {
    return JSON.parse(process.env.GOOGLE_TOKEN_JSON);
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      `Need Gmail token. Either set GOOGLE_TOKEN_JSON env var or save token.json at ${TOKEN_PATH}`
    );
  }
  return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
}

function buildGmailClient() {
  const creds = loadCreds();
  const token = loadToken();
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

        const fromHeader = full.data.payload?.headers?.find(h => h.name === "From")?.value || "";
        const subjectHeader = full.data.payload?.headers?.find(h => h.name === "Subject")?.value || "";
        console.log(`  Checking email: from="${fromHeader}" subject="${subjectHeader}"`);

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
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

// Step 3: MFA — choose method based on MFA_METHOD env var (default "email").
// "email" → click first SELECT (email) and poll Gmail for the OTP.
// "sms"   → click second SELECT (SMS to phone) and read the OTP from stdin.
const MFA_METHOD = (process.env.MFA_METHOD || "email").toLowerCase();
console.log(`\n>>> Waiting for MFA screen... (method=${MFA_METHOD})`);
const mfaTriggeredAt = Date.now();

try {
  const selectButtons = page.locator('button:has-text("SELECT")');
  await selectButtons.first().waitFor({ state: "visible", timeout: 15000 });
  console.log("✅ MFA screen detected");

  let otp;
  if (MFA_METHOD === "sms") {
    await selectButtons.nth(1).click();
    console.log("✅ Clicked second SELECT (SMS / text option)");
    console.log(">>> SMS code will arrive on your phone — please type it directly into the browser's OTP field. Script will wait for the dashboard to load.");
    await page.waitForTimeout(2000);
    // Skip auto-fill; user enters code in the visible browser. The dashboard
    // wait at the bottom of this script handles the post-OTP redirect.
  } else {
    await selectButtons.first().click();
    console.log("✅ Clicked first SELECT (email option)");
    await page.waitForTimeout(2000);
    otp = await fetchOtpFromGmail(mfaTriggeredAt);
  }

  if (otp) {
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
  sessionStorage: sessionStorageData,
}, null, 2));
console.log(`\n✅ Session saved to ${SESSION_PATH}`);
console.log(`Size: ${(fs.statSync(SESSION_PATH).size / 1024).toFixed(1)} KB`);

await page.waitForTimeout(2000);
await browser.close();

// Auto-push the fresh session to Railway. Delegates to the
// update-railway-sessions.mjs helper so the Railway-push logic
// (CLI resolution, v3/v4 syntax fallback, error reporting) lives in one
// place. Skip with SKIP_RAILWAY_PUSH=1 if you only want the local file.
if (process.env.SKIP_RAILWAY_PUSH === "1") {
  console.log("\n⚠️  SKIP_RAILWAY_PUSH=1 set — Railway env var NOT updated.");
  console.log("    Run `node scripts/update-railway-sessions.mjs` manually when ready.");
} else {
  console.log("\n>>> Pushing session to Railway via update-railway-sessions.mjs...");
  const { spawnSync } = await import("child_process");
  const helperPath = path.resolve(REPO_ROOT, "scripts/update-railway-sessions.mjs");
  const result = spawnSync(
    process.execPath, // current node binary
    [helperPath],
    { cwd: REPO_ROOT, stdio: "inherit" }
  );
  if (result.status === 0) {
    console.log("\n✅ Railway session pushed. Auto-redeploys in ~60s.");
  } else {
    console.error(`\n❌ Railway push failed. Try running manually: node scripts/update-railway-sessions.mjs`);
  }
}

console.log("Done!");
