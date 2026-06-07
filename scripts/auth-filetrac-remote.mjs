/**
 * FileTrac re-auth — HEADLESS + remote MFA.
 *
 * Unlike auth-filetrac.mjs (visible browser, human types MFA in the browser),
 * this runs headless and reads the MFA code from a FILE, so the code can be
 * supplied remotely (Hakiel texts it; Claude writes it to the file). Mirrors
 * the XA OTP-via-file mechanism.
 *
 * Run with creds injected from Railway (the .env has no FILETRAC creds) and the
 * MAIN repo as cwd (so Railway linkage + session output resolve there):
 *   cd /Users/dino/mcp-automation && \
 *   env -u RAILWAY_API_TOKEN -u RAILWAY_TOKEN railway run \
 *     node .claude/worktrees/filetrac-remote-mfa/scripts/auth-filetrac-remote.mjs
 *
 * Env knobs:
 *   FILETRAC_MFA_FILE       path to poll for the code   (default /tmp/filetrac-mfa.txt)
 *   FILETRAC_MFA_WAIT       seconds to wait for the code (default 600)
 *   FILETRAC_HEADFUL=1      show the browser (debug)     (default headless)
 *   FILETRAC_DUMP_DIR       where to write MFA HTML/png   (default repo root / cwd)
 *   FILETRAC_USER_DATA_DIR  persistent browser profile    (default ~/.filetrac-userdata)
 *
 * PERSISTENT PROFILE / ZERO-CODE RE-AUTH: the browser runs out of a persistent
 * userDataDir so Cognito's "Remember device for 30 days" device-key survives
 * between runs. The FIRST re-auth on a fresh profile needs one MFA code (it ticks
 * remember-device); subsequent re-auths within the device window skip MFA
 * entirely → fully unattended. If MFA is still required (device window lapsed),
 * the code-via-file path is still there.
 */
import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";
import dotenv from "dotenv";

const REPO_ROOT = process.cwd();
const ENV_PATH = path.resolve(REPO_ROOT, ".env");
if (fs.existsSync(ENV_PATH)) dotenv.config({ path: ENV_PATH });

const SESSION_PATH = path.resolve(REPO_ROOT, "filetrac_session.json");
const MFA_FILE = process.env.FILETRAC_MFA_FILE || "/tmp/filetrac-mfa.txt";
const MFA_WAIT_MS = (Number(process.env.FILETRAC_MFA_WAIT) || 600) * 1000;
const DUMP_DIR = process.env.FILETRAC_DUMP_DIR || REPO_ROOT;
const USER_DATA_DIR = process.env.FILETRAC_USER_DATA_DIR || path.join(os.homedir(), ".filetrac-userdata");

const EMAIL = process.env.FILETRAC_EMAIL;
const PASSWORD = process.env.FILETRAC_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("❌ FILETRAC_EMAIL / FILETRAC_PASSWORD not in env.");
  console.error("   Run via: env -u RAILWAY_API_TOKEN railway run node <this script>");
  process.exit(2);
}

const headless = process.env.FILETRAC_HEADFUL !== "1";
console.log(`Launching ${headless ? "headless" : "headful"} browser (persistent profile: ${USER_DATA_DIR})...`);
// Persistent context so the Cognito remember-device key survives between runs.
const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless,
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = context.pages()[0] || await context.newPage();

const FORCE_FRESH = process.env.FILETRAC_FORCE_FRESH === "1";
if (FORCE_FRESH) {
  // Proactive renewal: clear the live session (cookies + Cognito session tokens)
  // but PRESERVE the remembered-device keys, so the sign-in below issues a NEW
  // 30-day refresh token (resets the hard cap) yet still skips MFA → zero-code.
  console.log("FORCE_FRESH: clearing live session, keeping remembered-device keys...");
  await page.goto("https://ftevolve.com/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.evaluate(() => {
    const keep = /(deviceKey|deviceGroupKey|randomPasswordKey|LastAuthUser)$/;
    for (const k of Object.keys(localStorage)) if (!keep.test(k)) localStorage.removeItem(k);
  }).catch(() => {});
  await context.clearCookies().catch(() => {});
}

console.log("Opening FileTrac login...");
await page.goto("https://ftevolve.com/auth/login", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(2000);

let onMfa = false;
let alreadyAuthed = false;
const hasEmailField = await page.locator('input[name="email"]').count();
if (!hasEmailField && !page.url().includes("/auth/login")) {
  // No login form + redirected away → a live session already exists. Skip
  // re-login and just capture it (keeps Railway in sync; harmless).
  console.log("Already authenticated (live session) — capturing without re-login. URL:", page.url());
  alreadyAuthed = true;
} else {
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]').catch(() => page.locator("button").first().click());
  console.log("Credentials submitted — waiting to see if MFA is required...");

  // Either the device is remembered (redirect straight off /auth/) or an MFA
  // screen appears. Race both for up to 20s.
  try {
    await Promise.race([
      page.waitForURL((u) => !u.href.includes("/auth/"), { timeout: 20000 }).then(() => { onMfa = false; }),
      page.waitForSelector('input[autocomplete="one-time-code"], input[name*="code" i], input[name*="otp" i], input[name*="mfa" i], input[type="tel"], input[inputmode="numeric"]', { timeout: 20000 })
        .then(() => { onMfa = true; }),
    ]);
  } catch {
    // Neither fired within 20s — fall through and inspect the page.
  }
}

async function visibleInputs() {
  return page.$$eval("input", (els) =>
    els
      .filter((e) => e.offsetParent !== null || e.type === "hidden")
      .map((e) => ({
        type: e.type, name: e.name, id: e.id,
        placeholder: e.placeholder, autocomplete: e.autocomplete,
        inputmode: e.getAttribute("inputmode"), maxlength: e.maxLength,
      })),
  );
}

const url = page.url();
const stillOnAuth = url.includes("/auth/");
if (!onMfa && !stillOnAuth) {
  console.log("✅ No MFA prompt — device was remembered. URL:", url);
} else {
  onMfa = true;
  console.log("MFA required. URL:", url);
  try {
    fs.writeFileSync(path.join(DUMP_DIR, "_ft_mfa_dump.html"), await page.content());
    await page.screenshot({ path: path.join(DUMP_DIR, "_ft_mfa_dump.png"), fullPage: true }).catch(() => {});
    console.log(`   Dumped MFA page → ${path.join(DUMP_DIR, "_ft_mfa_dump.html")}`);
  } catch (e) { console.log("   (dump failed:", e.message, ")"); }

  const inputs = await visibleInputs();
  console.log("   Inputs on page:", JSON.stringify(inputs));

  const codeSelectors = [
    'input[autocomplete="one-time-code"]',
    'input[name*="code" i]',
    'input[name*="otp" i]',
    'input[name*="mfa" i]',
    'input[name*="verif" i]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
  ];
  let codeSel = null;
  for (const sel of codeSelectors) {
    if (await page.locator(sel).count()) { codeSel = sel; break; }
  }
  if (!codeSel) {
    const generic = 'input:not([type="email"]):not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])';
    if (await page.locator(generic).count()) codeSel = generic;
  }
  if (!codeSel) {
    console.error("❌ Could not locate an MFA code input. See _ft_mfa_dump.html. Inputs:", JSON.stringify(inputs));
    await context.close();
    process.exit(3);
  }
  console.log(`   Code input selector: ${codeSel}`);

  console.log(`\n>>> Waiting up to ${Math.round(MFA_WAIT_MS / 1000)}s for the MFA code`);
  console.log(`>>> Write it to ${MFA_FILE} (Claude does this when Hakiel sends it).`);
  try { fs.existsSync(MFA_FILE) && fs.unlinkSync(MFA_FILE); } catch {}

  async function pollFile() {
    const deadline = Date.now() + MFA_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(MFA_FILE)) {
          const digits = fs.readFileSync(MFA_FILE, "utf8").trim().replace(/\D/g, "");
          if (digits.length >= 4) return digits;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  }
  function readStdin() {
    return new Promise((resolve) => {
      if (!process.stdin.isTTY) return;
      process.stdin.once("data", (d) => resolve(d.toString().replace(/\D/g, "")));
    });
  }
  const racers = [pollFile()];
  if (process.stdin.isTTY) racers.push(readStdin());
  const code = await Promise.race(racers);
  if (!code) {
    console.error(`❌ Timed out after ${Math.round(MFA_WAIT_MS / 1000)}s waiting for the MFA code.`);
    await context.close();
    process.exit(4);
  }
  console.log(`   Got code (${code.length} digits). Entering...`);

  await page.fill(codeSel, code);

  try {
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.count()) {
      if (!(await cb.isChecked())) await cb.check({ timeout: 3000 }).catch(() => {});
      console.log("   ✓ Remember-device checkbox checked.");
    }
  } catch {}

  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Verify")',
    'button:has-text("Submit")',
    'button:has-text("Continue")',
    'button:has-text("Confirm")',
  ];
  let submitted = false;
  for (const sel of submitSelectors) {
    if (await page.locator(sel).count()) { await page.locator(sel).first().click().catch(() => {}); submitted = true; break; }
  }
  if (!submitted) await page.keyboard.press("Enter");

  try {
    await page.waitForURL((u) => !u.href.includes("/auth/"), { timeout: 30000 });
    console.log("✅ MFA accepted! URL:", page.url());
  } catch {
    console.error("❌ Still on an /auth/ page after submitting the code — code may be wrong/expired.");
    try { fs.writeFileSync(path.join(DUMP_DIR, "_ft_mfa_after.html"), await page.content()); } catch {}
    await context.close();
    process.exit(5);
  }
}

await page.waitForTimeout(2000);

// FileTrac/ftevolve auth lives in localStorage (Cognito tokens), NOT cookies —
// a valid session legitimately has 0 top-level cookies. Capture the Cognito
// localStorage on the ftevolve origin now; cookies are re-read AFTER the ASP
// navigation below so the legacy claims.filetrac.net cookies are included.
const localStorageData = await page.evaluate(() => {
  const d = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); d[k] = localStorage.getItem(k); } return d;
});
const sessionStorageData = await page.evaluate(() => {
  const d = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); d[k] = sessionStorage.getItem(k); } return d;
});
console.log("localStorage keys:", Object.keys(localStorageData).length, "(Cognito tokens; cookies captured after ASP step)");

let aspBase = null, aspCookies = null;
console.log("Navigating to linked-companies to capture ASP session cookie...");
try {
  await page.goto("https://ftevolve.com/app/legacy/linked-companies", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector('button:has-text("See Jobs")', { timeout: 20000 });
  const btns = await page.locator('button:has-text("See Jobs")').all();
  if (btns.length) {
    const idx = Math.min(1, btns.length - 1); // 1 = Premier Claims
    await btns[idx].click();
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
    await page.waitForTimeout(1500);
    aspBase = new URL(page.url()).origin;
    const all = await context.cookies();
    const host = new URL(aspBase).hostname;
    const list = all.filter((c) => c.domain.includes(host)).map((c) => `${c.name}=${c.value}`).join("; ");
    if (list) { aspCookies = list; console.log(`✅ ASP session captured: ${aspBase}`); }
    else console.log("⚠️  No ASP cookies found — fast path unavailable.");
  }
} catch (e) {
  console.log(`⚠️  Could not capture ASP session: ${e.message}`);
}

// Re-capture cookies now (after the ASP nav) so any claims.filetrac.net cookies
// are included. Validity for FileTrac = off the /auth/ pages AND we have real
// auth material: Cognito localStorage tokens OR a captured ASP cookie string.
// (Cookie COUNT is not a signal here — a healthy session can be 0 cookies.)
const cookies = await context.cookies();
const authed = !page.url().includes("/auth/") &&
  (Object.keys(localStorageData).length > 0 || !!aspCookies);
if (!authed) {
  console.error(`❌ Login NOT confirmed (localStorage=${Object.keys(localStorageData).length}, aspCookies=${!!aspCookies}, url=${page.url()}) — NOT saving. Re-run.`);
  await context.close();
  process.exit(6);
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
console.log(`\n✅ Session saved to ${SESSION_PATH} (${cookies.length} cookies${aspBase ? ", ASP fast-path enabled" : ""}).`);

try { fs.existsSync(MFA_FILE) && fs.unlinkSync(MFA_FILE); } catch {}

await page.waitForTimeout(1000);
await context.close();
console.log("Done.");
