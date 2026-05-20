/**
 * XactAnalysis auth script — Windows/Railway-portable.
 *
 * Drives Verisk SSO with email + password, picks SMS MFA by default
 * (per Hakiel's xa-reauth-prefs), waits for the SMS OTP to arrive via
 * one of: env var, supply file, or live stdin. Auto-fills, submits,
 * saves the session, pushes to Railway.
 *
 * Run from repo root:
 *   node scripts/auth-xactanalysis.mjs
 *
 * Required env (or .env file at repo root):
 *   - XACTANALYSIS_EMAIL      Verisk SSO email
 *   - XACTANALYSIS_PASSWORD   Verisk SSO password
 *
 * Optional env:
 *   - MFA_METHOD              "sms" (default) | "email"
 *   - XACTANALYSIS_SMS_OTP    Pre-supplied SMS OTP; if set, skips the wait
 *   - XACTANALYSIS_OTP_FILE   Path the script polls for the OTP (default
 *                             /tmp/xactanalysis-otp.txt). When the cron
 *                             runs unattended, Hakiel writes the texted
 *                             OTP to this file (e.g. `echo 123456 >`),
 *                             the script reads it and deletes it.
 *   - XACTANALYSIS_OTP_WAIT_MS  How long to wait for the OTP before
 *                             timing out. Default 300000 (5 min).
 *   - XA_OTP_NTFY_TOPIC       ntfy topic for "OTP needed" alerts.
 *                             Default `hakiel-mac-mini-xa-reauth`.
 *   - SKIP_RAILWAY_PUSH       "1" to skip the post-auth Railway push.
 *
 * Required only when MFA_METHOD=email:
 *   - GOOGLE_CREDENTIALS_JSON or credentials.json
 *   - GOOGLE_TOKEN_JSON       or token.json
 *
 * Writes:
 *   - xactanalysis_session.json (full session, repo root)
 *   - XACTANALYSIS_SESSION_JSON on Railway (via update-railway-sessions)
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

// ── SMS OTP supply ──────────────────────────────────────────────────────────
//
// Three supply paths, checked in priority order:
//   (1) XACTANALYSIS_SMS_OTP env var — pre-supplied, fastest, used by tests.
//   (2) OTP file at XACTANALYSIS_OTP_FILE — polled every 3s. Hakiel writes
//       the texted OTP to this file from any shell (`echo 123456 > <path>`)
//       and the script picks it up. File is deleted after read for single-
//       use safety. This is the path the launchd cron uses.
//   (3) Live stdin — only when running with a TTY. Hakiel types the OTP at
//       the prompt.

const OTP_FILE_PATH = process.env.XACTANALYSIS_OTP_FILE
  ?? "/tmp/xactanalysis-otp.txt";
const OTP_WAIT_MS = parseInt(process.env.XACTANALYSIS_OTP_WAIT_MS || "300000", 10);
const OTP_NTFY_TOPIC = process.env.XA_OTP_NTFY_TOPIC || "hakiel-mac-mini-xa-reauth";

async function notifyOtpNeeded() {
  const url = `https://ntfy.sh/${encodeURIComponent(OTP_NTFY_TOPIC)}`;
  const body = `XA needs the SMS OTP. Write the code to ${OTP_FILE_PATH}:\n  echo 123456 > ${OTP_FILE_PATH}\nWaits up to ${Math.round(OTP_WAIT_MS / 1000)}s.`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Title": "[XA re-auth] need SMS OTP",
        "Priority": "5",
        "Tags": "key,sms",
        "Content-Type": "text/plain; charset=utf-8",
      },
      body,
    });
    console.log(`>>> ntfy alert sent to topic "${OTP_NTFY_TOPIC}"`);
  } catch (e) {
    console.log("  (ntfy alert failed, continuing):", e.message);
  }
}

function readOtpFromFile() {
  try {
    if (!fs.existsSync(OTP_FILE_PATH)) return null;
    const raw = fs.readFileSync(OTP_FILE_PATH, "utf8");
    const m = raw.match(/\b(\d{4,8})\b/);
    if (!m) return null;
    // Single-use: delete the file after reading. Prevents stale OTPs from
    // a previous run polluting the next.
    try { fs.unlinkSync(OTP_FILE_PATH); } catch { /* ignore */ }
    return m[1];
  } catch {
    return null;
  }
}

async function readOtpFromStdin() {
  if (!process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    process.stdout.write(`>>> Enter the SMS OTP (or write it to ${OTP_FILE_PATH} from another shell): `);
    const onData = (chunk) => {
      const line = String(chunk).trim();
      const m = line.match(/\b(\d{4,8})\b/);
      if (m) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(m[1]);
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

async function fetchOtpForSms() {
  // Path 1: env var — used in tests and pre-supplied flows.
  const fromEnv = (process.env.XACTANALYSIS_SMS_OTP || "").trim();
  if (/^\d{4,8}$/.test(fromEnv)) {
    console.log(`✅ OTP supplied via XACTANALYSIS_SMS_OTP env var`);
    return fromEnv;
  }

  // Wipe any stale OTP file from a previous run before we start polling.
  try { fs.unlinkSync(OTP_FILE_PATH); } catch { /* not there, fine */ }

  await notifyOtpNeeded();
  console.log(`>>> Waiting up to ${Math.round(OTP_WAIT_MS / 1000)}s for SMS OTP via file ${OTP_FILE_PATH} or stdin`);

  // Path 2 (file polling) and Path 3 (stdin) raced together. Whichever
  // resolves first wins; the loser is left dangling but it's a one-shot
  // script so process exit will reap it.
  const filePoll = (async () => {
    const deadline = Date.now() + OTP_WAIT_MS;
    while (Date.now() < deadline) {
      const otp = readOtpFromFile();
      if (otp) {
        console.log(`✅ OTP read from ${OTP_FILE_PATH}`);
        return otp;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    return null;
  })();

  const stdinPath = readOtpFromStdin();

  const otp = await Promise.race([filePoll, stdinPath]);
  if (!otp) throw new Error(`Timed out after ${Math.round(OTP_WAIT_MS / 1000)}s waiting for SMS OTP.`);
  return otp;
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

// Step 3: MFA — choose method based on MFA_METHOD env var.
// Default is now "sms" per Hakiel's xa-reauth-prefs (SMS, not email).
// "sms"   → click second SELECT (SMS to phone), wait for OTP via env var,
//           file (XACTANALYSIS_OTP_FILE), or stdin — then auto-fill.
// "email" → click first SELECT (email) and poll Gmail for the OTP.
const MFA_METHOD = (process.env.MFA_METHOD || "sms").toLowerCase();
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
    await page.waitForTimeout(2000);
    otp = await fetchOtpForSms();
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
