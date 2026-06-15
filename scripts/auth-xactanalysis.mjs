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
import os from "os";
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

  // Only race stdin when attached to a TTY. In a non-TTY (cron/background)
  // launch, readOtpFromStdin() returns null *immediately*, which would win
  // the race and abort file-polling before the OTP file can be written —
  // breaking the exact unattended path this is meant to support.
  const racers = [filePoll];
  if (process.stdin.isTTY) racers.push(readOtpFromStdin());

  const otp = await Promise.race(racers);
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

// ── Remember-device helper ───────────────────────────────────────────────────
// Verisk shows the session-persistence toggle as one of: a labeled checkbox
// ("Remember this device" / "Keep me signed in" / "Trust this device"), an
// Angular Material mat-checkbox, or a plain input[type=checkbox]. Opting in
// plants a long-lived device-trust cookie — that cookie, persisted in the
// Chromium profile below, is what lets future scheduled re-auths SKIP MFA.
// Best-effort: a missing toggle just means no persistence, never an error.
async function tryCheckRememberDevice(scope) {
  const labelTexts = [
    "Remember this device", "Keep me signed in", "Trust this device",
    "Don't ask again", "Remember me",
    // Okta device-trust toggle (Verisk migrated SSO MFA to Okta mid-2026):
    "Do not challenge me on this device again",
    "Do not challenge me on this device",
    "Do not challenge me on this device for the next",
  ];
  try {
    for (const t of labelTexts) {
      const byLabel = scope.locator(`label:has-text("${t}"), :text("${t}")`).first();
      if (await byLabel.isVisible({ timeout: 800 }).catch(() => false)) {
        await byLabel.click().catch(() => {});
        console.log(`✅ Opted into device persistence: "${t}"`);
        return true;
      }
    }
    for (const sel of ['mat-checkbox', 'input[type="checkbox"]']) {
      const cb = scope.locator(sel).first();
      if (await cb.isVisible({ timeout: 800 }).catch(() => false)) {
        const checked = await cb.isChecked().catch(() => false);
        if (!checked) {
          await cb.click().catch(() => {});
          console.log(`✅ Checked device-persistence box via ${sel}`);
        } else {
          console.log(`✅ Device-persistence box already checked (${sel})`);
        }
        return true;
      }
    }
  } catch { /* best-effort */ }
  console.log("ℹ️ No remember-device toggle found on this screen.");
  return false;
}

// ── Browser login ─────────────────────────────────────────────────────────────
// Persistent Chromium profile on disk so Verisk device-trust survives across
// re-auths. Once the device is trusted (a remember-device box checked during a
// bootstrap login with an OTP), subsequent logins skip MFA entirely — that's
// what makes the scheduled cron run unattended (no OTP). Mirrors the FileTrac
// remote-MFA persistent-profile pattern. Headful by default (Incapsula is
// friendlier to a real window + returning profile); XA_HEADLESS=1 forces
// headless for environments without a display.
const PROFILE_DIR = process.env.XA_CHROME_PROFILE_DIR
  ?? path.join(os.homedir(), ".xa-userdata");
const HEADLESS = process.env.XA_HEADLESS === "1";
fs.mkdirSync(PROFILE_DIR, { recursive: true });
console.log(`Using Chromium profile: ${PROFILE_DIR} (headless=${HEADLESS})`);
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: HEADLESS,
  slowMo: HEADLESS ? 0 : 200,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const browser = context.browser();
const page = context.pages()[0] ?? await context.newPage();

console.log("Opening XactAnalysis...");
await page.goto("https://www.xactanalysis.com");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(2000);

// Step 1: email → NEXT (skipped if the persistent profile is already authed)
let alreadyAuthed = false;
const emailField = page.locator('input[name="preAuthEmailField"]');
const haveEmailField = await emailField.first()
  .waitFor({ state: "visible", timeout: 10000 })
  .then(() => true)
  .catch(() => false);
if (!haveEmailField) {
  if (/xactanalysis\.com/.test(page.url()) && !/identity\.verisk|\/auth\//.test(page.url())) {
    alreadyAuthed = true;
    console.log("✅ No login screen — persistent profile already authenticated. URL:", page.url());
  } else {
    console.log("⚠️ Email field not found and not on dashboard. URL:", page.url());
  }
}
if (!alreadyAuthed) {
  await emailField.fill(process.env.XACTANALYSIS_EMAIL);
  await page.click('button:has-text("NEXT")');
  await page.waitForTimeout(3000);
}

// Step 2: password
const pwdField = page.locator('input[name="passwordField"]');
if (await pwdField.count() > 0) {
  await pwdField.fill(process.env.XACTANALYSIS_PASSWORD);
  // "Keep me signed in" sometimes appears on the password screen — opt in here
  // too (and again on the OTP screen below) so device-trust is planted.
  await tryCheckRememberDevice(page);
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
  // Okta MFA detection — Verisk migrated SSO MFA to Okta mid-2026. The Okta
  // page lives at .../ui/oktaMfa, auto-sends the SMS, and shows the code field
  // ("Enter a code") directly with a "FINISH LOGIN" button. There is NO
  // "SELECT method" step, so the legacy selectButtons.nth(1).click() below used
  // to time out (locator.click 30s) and abort the whole MFA step. We now detect
  // Okta and skip straight to OTP entry.
  const oktaCodeField = page.locator(
    'input[autocomplete="one-time-code"], input[name*="passcode" i], input[name*="code" i], input[id*="code" i]'
  );
  // Race the legacy SELECT form, the Okta code page, and a direct dashboard
  // landing (a trusted device skips MFA entirely — the unattended-cron path).
  const mfaOrDash = await Promise.race([
    selectButtons.first().waitFor({ state: "visible", timeout: 25000 }).then(() => "mfa").catch(() => null),
    page.waitForURL(u => /\/ui\/oktaMfa/i.test(u.href), { timeout: 25000 }).then(() => "okta").catch(() => null),
    oktaCodeField.first().waitFor({ state: "visible", timeout: 25000 }).then(() => "okta").catch(() => null),
    page.waitForURL(u => u.href.includes("xactanalysis.com") && !u.href.includes("identity.verisk"), { timeout: 25000 }).then(() => "dash").catch(() => null),
  ]);
  if (alreadyAuthed || mfaOrDash === "dash") {
    console.log("✅ MFA skipped — device trusted / already authenticated.");
    throw { __skipMfa: true };
  }
  const isOkta = mfaOrDash === "okta" || /\/ui\/oktaMfa/i.test(page.url());
  if (mfaOrDash === "mfa") {
    console.log("✅ MFA screen detected (legacy Verisk SELECT form)");
  } else if (isOkta) {
    console.log("✅ MFA screen detected (Okta flow — code field shown, SMS auto-sent)");
  } else {
    console.log("⚠️ MFA screen not detected within 25s. URL:", page.url());
  }

  let otp;
  if (MFA_METHOD === "sms") {
    // Legacy Verisk form needs an explicit SMS-method click; the Okta flow shows
    // the code field directly (SMS already sent), so we must NOT click a
    // non-existent SELECT (that was the 30s timeout that broke the whole step).
    if (!isOkta && (await selectButtons.count()) > 1) {
      await selectButtons.nth(1).click();
      console.log("✅ Clicked second SELECT (SMS / text option)");
      await page.waitForTimeout(2000);
    } else {
      console.log("→ Okta/auto SMS: code field already present, no method-select click needed");
    }
    otp = await fetchOtpForSms();
  } else {
    if (!isOkta && (await selectButtons.count()) > 0) {
      await selectButtons.first().click();
      console.log("✅ Clicked first SELECT (email option)");
      await page.waitForTimeout(2000);
    }
    otp = await fetchOtpFromGmail(mfaTriggeredAt);
  }

  if (otp) {
    await page.waitForTimeout(4000);
    const otpSelectors = [
      'input[name="otpCode"]',
      'input[autocomplete="one-time-code"]',
      'input[name="code"]',
      'input[name="otp"]',
      'input[name*="code" i]',
      'input[name*="otp" i]',
      'input[id*="code" i]',
      'input[id*="otp" i]',
      'input[id*="passcode" i]',
      'input[id*="verification" i]',
      'input[inputmode="numeric"]',
      'input[aria-label*="code" i]',
      'input[aria-label*="verification" i]',
      'input[aria-label*="passcode" i]',
      'input[placeholder*="code" i]',
      'input[placeholder*="enter" i]',
      'input[placeholder*="verification" i]',
      'input[type="tel"]',
      'input[type="number"]',
      'input[type="text"][maxlength]',
      'input[type="password"][maxlength]',
      'input[id^="mat-input-"]',  // Angular Material auto-generated id (Verisk identity page)
    ];

    const scopes = [
      { name: 'page', loc: page },
      ...page.frames().filter(f => f !== page.mainFrame()).map((f, i) => ({ name: `frame[${i}]:${f.url().slice(0, 80)}`, loc: f })),
    ];

    let otpEntered = false;
    outer: for (const scope of scopes) {
      for (const sel of otpSelectors) {
        try {
          const field = scope.loc.locator(sel).first();
          if (await field.isVisible({ timeout: 1500 }).catch(() => false)) {
            await field.click().catch(() => {});
            await field.fill(otp).catch(async () => {
              await field.focus().catch(() => {});
              await page.keyboard.type(otp, { delay: 80 });
            });
            console.log(`✅ Entered OTP "${otp}" via ${scope.name} selector: ${sel}`);
            otpEntered = true;
            break outer;
          }
        } catch (_) { /* try next */ }
      }
    }

    // Last-resort fallback: if the page has exactly one visible text/tel/password input, use it.
    // The Verisk OTP page renders just the OTP field on screen, so this is unambiguous.
    if (!otpEntered) {
      try {
        const candidates = await page.$$eval(
          'input[type="text"], input[type="tel"], input[type="password"], input:not([type])',
          els => els
            .map((e, idx) => ({ idx, visible: !!(e.offsetWidth || e.offsetHeight), id: e.id, name: e.name }))
            .filter(x => x.visible)
        );
        if (candidates.length === 1) {
          const c = candidates[0];
          const sel = c.id ? `#${c.id}` : (c.name ? `input[name="${c.name}"]` : `input[type="text"]`);
          const field = page.locator(sel).first();
          await field.click().catch(() => {});
          await field.fill(otp).catch(async () => {
            await field.focus().catch(() => {});
            await page.keyboard.type(otp, { delay: 80 });
          });
          console.log(`✅ Entered OTP "${otp}" via single-visible-input fallback: ${sel}`);
          otpEntered = true;
        }
      } catch (_) { /* fall through to diagnostic */ }
    }

    if (!otpEntered) {
      console.log("⚠️  Could not find OTP input field — please enter the code manually: " + otp);
      const dumpDir = process.env.XA_DEBUG_DUMP_DIR || '/Users/dino/.claude/jobs/91a395c2/tmp';
      try { fs.mkdirSync(dumpDir, { recursive: true }); } catch {}
      const ts = `${Date.now()}`;
      try { await page.screenshot({ path: `${dumpDir}/xa-otp-fail-${ts}.png`, fullPage: true }); console.log(`📸 Screenshot: ${dumpDir}/xa-otp-fail-${ts}.png`); } catch (e) { console.log('screenshot fail:', e.message); }
      try { const html = await page.content(); fs.writeFileSync(`${dumpDir}/xa-otp-fail-${ts}.html`, html); console.log(`📄 HTML dump: ${dumpDir}/xa-otp-fail-${ts}.html`); } catch (e) { console.log('html dump fail:', e.message); }
      try {
        const inputs = await page.$$eval('input', els => els.map(e => ({
          name: e.name, id: e.id, type: e.type, placeholder: e.placeholder,
          maxlength: e.maxLength, autocomplete: e.autocomplete,
          ariaLabel: e.getAttribute('aria-label'), visible: !!(e.offsetWidth || e.offsetHeight),
        })));
        console.log('Inputs on page:', JSON.stringify(inputs, null, 2));
      } catch (e) { console.log('input enum fail:', e.message); }
    } else {
      // Opt into "Remember this device" on the OTP screen BEFORE submitting, so
      // Verisk plants the device-trust cookie that lets future re-auths skip MFA.
      await tryCheckRememberDevice(page);
      // Try Enter-key submit FIRST — the OTP input is focused, and modern forms
      // submit on Enter. This avoids guessing button text wrong (a "Continue"
      // somewhere else on the page is not the OTP submit).
      let submitted = false;
      try {
        await page.keyboard.press('Enter');
        console.log(`✅ Submitted OTP via Enter key`);
        submitted = true;
        // Give the form 4s to navigate. If still on identity page, fall through.
        await page.waitForTimeout(4000);
        const stillIdentity = /identity\.verisk|\/auth\//.test(page.url());
        if (stillIdentity) {
          console.log(`(Enter didn't trigger nav; trying button click fallback)`);
          submitted = false;
        }
      } catch (_) { /* fall through to button-click */ }

      if (!submitted) {
        for (const selector of [
          'button:has-text("FINISH LOGIN")',   // Okta (Verisk-branded) OTP submit
          'button:has-text("Finish")',
          'button:has-text("Verify")',
          'input[type="submit"][value*="Verify" i]',
          'button:has-text("Submit")',
          'button:has-text("Continue")',
          'button:has-text("Sign in")',
          'button[type="submit"]',
          'input[type="submit"]',
        ]) {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click();
            console.log(`✅ Submitted OTP via button: ${selector}`);
            break;
          }
        }
      }
    }
  }
} catch (e) {
  if (e && e.__skipMfa) {
    // intentional skip — device trusted, no MFA needed
  } else {
    console.log(">>> MFA step error:", e.message);
    console.log(">>> Please complete MFA manually in the browser if it's open.");
  }
}

// Step 6: Wait for successful redirect
let loginSucceeded = false;
console.log("\n>>> Waiting up to 120 seconds for XactAnalysis dashboard...");
try {
  await page.waitForURL(
    url => url.href.includes("xactanalysis.com") && !url.href.includes("identity.verisk"),
    { timeout: 120000 }
  );
  loginSucceeded = true;
  console.log("✅ Login successful! URL:", page.url());
} catch {
  console.log("Timed out waiting for the authenticated dashboard.");
  // Diagnostic on dashboard timeout — capture post-submit state to debug what went wrong
  try {
    const dumpDir = process.env.XA_DEBUG_DUMP_DIR || '/Users/dino/.claude/jobs/91a395c2/tmp';
    fs.mkdirSync(dumpDir, { recursive: true });
    const ts = `${Date.now()}`;
    console.log(`Current URL: ${page.url()}`);
    try { await page.screenshot({ path: `${dumpDir}/xa-dash-fail-${ts}.png`, fullPage: true }); console.log(`📸 Dashboard-fail screenshot: ${dumpDir}/xa-dash-fail-${ts}.png`); } catch (e) { console.log('dash screenshot fail:', e.message); }
    try { const html = await page.content(); fs.writeFileSync(`${dumpDir}/xa-dash-fail-${ts}.html`, html); console.log(`📄 Dashboard-fail HTML: ${dumpDir}/xa-dash-fail-${ts}.html`); } catch (e) { console.log('dash html fail:', e.message); }
    try {
      const visibleText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      console.log(`Visible text on post-submit page:\n${visibleText}`);
    } catch (e) { console.log('text grab fail:', e.message); }
  } catch (e) { console.log('dashboard-timeout diagnostic fail:', e.message); }
}

// Settle briefly so any post-login Set-Cookie writes land. GUARDED: if the
// page/browser was closed (headful window dismissed, login stalled, launchd
// killed it), do NOT let an uncaught waitForTimeout throw — that is exactly
// what aborted the 2026-05-20 cron AFTER "Login successful" but BEFORE the
// session was captured + pushed, leaving Railway on a stale snapshot.
try { await page.waitForTimeout(3000); } catch { /* page/browser closed — capture what we can below */ }

// Capture session. Each step independently guarded so a partial failure still
// saves what we have (and reports clearly) instead of crashing before the push.
let cookies = [];
let localStorageData = {};
let sessionStorageData = {};
try {
  cookies = await context.cookies();
} catch (e) {
  console.error("⚠️  Could not read cookies (browser/context closed?):", e.message);
}
localStorageData = await page.evaluate(() => {
  const data = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    data[key] = window.localStorage.getItem(key);
  }
  return data;
}).catch(() => ({}));
sessionStorageData = await page.evaluate(() => {
  const data = {};
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    data[key] = window.sessionStorage.getItem(key);
  }
  return data;
}).catch(() => ({}));

console.log(`\nCookies: ${cookies.length}`);
console.log(`localStorage keys: ${Object.keys(localStorageData).length}`);

// Refuse to overwrite the good local file or push a non-authenticated session
// to Railway. Gate on ACTUAL login success (reached the dashboard, not the
// identity.verisk MFA screen) — NOT merely on cookie presence, because a
// timed-out MFA still leaves pre-auth identity cookies behind. Pushing those
// is what risked clobbering Railway with a dead session on 2026-05-21. Exit
// non-zero so the cron wrapper's failure ntfy fires and Hakiel knows to retry.
const onIdentityPage = (() => {
  try { return /identity\.verisk|\/auth\//.test(page.url()); } catch { return true; }
})();
if (!loginSucceeded || onIdentityPage || !cookies || cookies.length === 0) {
  console.error(
    `❌ Login NOT confirmed (loginSucceeded=${loginSucceeded}, onIdentityPage=${onIdentityPage}, cookies=${cookies?.length ?? 0}) ` +
    `— NOT saving or pushing. The OTP was likely not supplied in time. Re-run and enter the code at the prompt.`
  );
  try { await browser.close(); } catch { /* already closed */ }
  process.exit(1);
}

fs.writeFileSync(SESSION_PATH, JSON.stringify({
  cookies,
  localStorage: localStorageData,
  sessionStorage: sessionStorageData,
}, null, 2));
console.log(`\n✅ Session saved to ${SESSION_PATH}`);
console.log(`Size: ${(fs.statSync(SESSION_PATH).size / 1024).toFixed(1)} KB`);

try { await page.waitForTimeout(2000); } catch { /* ignore */ }
try { await browser.close(); } catch { /* ignore */ }

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
