import { chromium, type Browser, type Page } from "playwright";
import fs from "fs";
import path from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SESSION_PATH = process.env.FILETRAC_SESSION_PATH || "/Users/hakielmcqueen/mcp-automation/filetrac_session.json";

// ─── ASP Cookie Cache ──────────────────────────────────────────────────────────
// After the first browser flow, we save the ASP session cookie so subsequent
// calls can skip the browser entirely and use a direct HTTP fetch (~1s vs 30s).

interface AspCompanyCredential {
  aspBase: string;
  aspCookies: string;
  savedAt: string;
  companyName?: string;
}

interface FiletracSession {
  cookies: unknown[];
  localStorage: Record<string, string>;
  sessionStorage?: Record<string, string>;
  aspBase?: string;
  aspCookies?: string;  // raw Cookie header string (e.g. "ASPSESSIONIDXXXX=YYYY")
  aspCookiesSavedAt?: string;
  // Per-company credentials keyed by "See Jobs" button index (0-3)
  // 0=Accelerated, 1=Premier Claims, 2=Stewardship, 3=US Claim Solutions
  aspCredentials?: Record<string, AspCompanyCredential>;
}

function loadSession(): FiletracSession {
  if (process.env.FILETRAC_SESSION_JSON) {
    return JSON.parse(process.env.FILETRAC_SESSION_JSON);
  } else if (fs.existsSync(SESSION_PATH)) {
    return JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
  }
  throw new Error(
    "FileTrac session not found. Set FILETRAC_SESSION_JSON env var or run: " +
    "node /Users/hakielmcqueen/mcp-automation/scripts/auth-filetrac.mjs"
  );
}

/**
 * Load aspBase and aspCookies for the given company index.
 * Checks aspCredentials map first (per-company), falls back to top-level fields (Premier Claims).
 * company_index: 0=Accelerated, 1=Premier Claims (default), 2=Stewardship, 3=US Claim Solutions
 */
function getAspCredentials(companyIndex?: number): { aspBase: string; aspCookies: string } {
  const session = loadSession();
  const idx = companyIndex ?? 1;
  // Check per-company map first
  const perCompany = session.aspCredentials?.[String(idx)];
  if (perCompany?.aspBase && perCompany?.aspCookies) {
    return { aspBase: perCompany.aspBase, aspCookies: perCompany.aspCookies };
  }
  // Fall back to top-level (Premier Claims / company 1)
  return {
    aspBase: session.aspBase ?? "",
    aspCookies: session.aspCookies ?? "",
  };
}

function saveAspToSession(aspBase: string, aspCookies: string, companyIndex?: number): void {
  // Only save to local file — Railway env var is updated separately
  if (!fs.existsSync(SESSION_PATH)) return;
  try {
    const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
    const now = new Date().toISOString();
    // Save per-company if index provided
    if (companyIndex !== undefined) {
      if (!session.aspCredentials) session.aspCredentials = {};
      session.aspCredentials[String(companyIndex)] = {
        ...(session.aspCredentials[String(companyIndex)] ?? {}),
        aspBase,
        aspCookies,
        savedAt: now,
      };
    }
    // Also update top-level for Premier Claims (company 1) backward compat
    if (companyIndex === undefined || companyIndex === 1) {
      session.aspBase = aspBase;
      session.aspCookies = aspCookies;
      session.aspCookiesSavedAt = now;
    }
    fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
  } catch { /* non-fatal */ }
}

/**
 * Check whether the given ASP credentials are still valid by fetching
 * a lightweight page. Returns false if session expired or redirected to login.
 */
async function isAspSessionValid(aspBase: string, aspCookies: string): Promise<boolean> {
  if (!aspBase || !aspCookies) return false;
  try {
    const res = await fetch(`${aspBase}/system/claimList.asp`, {
      headers: {
        "Cookie": aspCookies,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const html = await res.text();
    if (html.includes("Session has expired") || html.includes("Please log in")) return false;
    if (html.includes("ftevolve.com/auth") || html.includes("/sign-in") || html.includes("Forgot password")) return false;
    if ((html.includes("Login") || html.includes("Sign in")) && html.includes("password") && html.length < 8000) return false;
    return html.length > 5000;
  } catch {
    return false;
  }
}

async function fetchAspPage(aspBase: string, aspCookies: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(`${aspBase}${path}`, {
      headers: {
        "Cookie": aspCookies,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Reject login / session-expired pages
    if (html.includes("Session has expired") || html.includes("Please log in")) return null;
    if (html.includes("ftevolve.com/auth") || html.includes("/sign-in") || html.includes("Forgot password")) return null;
    if ((html.includes("Login") || html.includes("Sign in")) && html.includes("password") && html.length < 8000) return null;
    // Reject pages that are clearly too short to be real content
    if (html.length < 500) return null;
    return html;
  } catch {
    return null;
  }
}

/**
 * HTTP fast-path note submit — bypasses Playwright by GETting the form,
 * harvesting hidden inputs, then POSTing with cached cookies. Used when
 * Chromium is unreliable (e.g., on Railway).
 */
async function postFiletracNoteForm(
  aspBase: string,
  aspCookies: string,
  fileNumber: string,
  args: { note: string; category?: string; visible_to_client?: boolean; dry_run?: boolean }
): Promise<{ ok: boolean; status: number; bodyPreview: string; finalUrl?: string; formDump?: string; error?: string; categoryResolvedTo?: string; sentBody?: string; dryRun?: boolean; categoryOptions?: Array<{ value: string; label: string }> }> {
  const formPath = `/system/quickNotes.asp?claimFID=${fileNumber}`;
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

  // 1. GET the form
  const getRes = await fetch(`${aspBase}${formPath}`, {
    headers: { "Cookie": aspCookies, "User-Agent": ua },
    redirect: "follow",
  });
  if (!getRes.ok) {
    return { ok: false, status: getRes.status, bodyPreview: "", error: `GET form failed: ${getRes.status}` };
  }
  const formHtml = await getRes.text();

  // 2. Find the <form> block — try several name/id patterns + action containing quickNotes.asp
  const formBlock =
    formHtml.match(/<form\b[^>]*\bname\s*=\s*["']?frmNotes["']?[\s\S]*?<\/form>/i)?.[0] ??
    formHtml.match(/<form\b[^>]*\bid=["']?frmNotes["']?[\s\S]*?<\/form>/i)?.[0] ??
    formHtml.match(/<form\b[^>]*\baction\s*=\s*["'][^"']*quickNotes\.asp[^"']*["'][\s\S]*?<\/form>/i)?.[0];
  if (!formBlock) {
    return {
      ok: false, status: getRes.status, bodyPreview: "",
      error: "frmNotes <form> not found in form page HTML",
      formDump: formHtml.substring(0, 3000),
    };
  }

  // 3. Resolve action URL
  const actionAttr = formBlock.match(/<form\b[^>]*\baction\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
  let action = actionAttr || formPath;
  if (!/[?&]GO=1\b/i.test(action)) {
    action += action.includes("?") ? "&GO=1" : "?GO=1";
  }
  const postUrl = action.startsWith("http")
    ? action
    : action.startsWith("/")
      ? `${aspBase}${action}`
      : `${aspBase}/system/${action.replace(/^\.?\/?/, "")}`;

  // 4. Harvest all <input> defaults (skip checkboxes/radios — set explicitly)
  const formData: Record<string, string> = {};
  for (const m of formBlock.matchAll(/<input\b[^>]+>/gi)) {
    const tag = m[0];
    const name = tag.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    const type = (tag.match(/\btype\s*=\s*["']?([a-z]+)/i)?.[1] ?? "text").toLowerCase();
    if (type === "checkbox" || type === "radio" || type === "submit" || type === "button") continue;
    const value = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    formData[name] = value;
  }
  // <textarea> defaults
  for (const m of formBlock.matchAll(/<textarea\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/textarea>/gi)) {
    formData[m[1]] = m[2];
  }
  // <select> defaults — selected option, else first option
  for (const sm of formBlock.matchAll(/<select\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    const selName = sm[1];
    const inner = sm[2];
    const sel = inner.match(/<option\b[^>]*\bselected\b[^>]*\bvalue\s*=\s*["']([^"']*)["']/i)
      ?? inner.match(/<option\b[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bselected\b/i);
    if (sel) formData[selName] = sel[1];
    else {
      const first = inner.match(/<option\b[^>]*\bvalue\s*=\s*["']([^"']*)["']/i);
      if (first) formData[selName] = first[1];
    }
  }

  // 5. User-provided overrides
  formData["claimFileID"] = fileNumber;
  formData["msgText"] = args.note;

  // Always extract msgCatID options (for dry-run report + label matching)
  const catSelInner = formBlock.match(/<select\b[^>]*\bname\s*=\s*["']?msgCatID["']?[^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? "";
  const categoryOptions = [...catSelInner.matchAll(/<option\b[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi)]
    .map(o => ({
      value: o[1],
      label: o[2].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim(),
    }));

  // Resolve category by label → option value
  let categoryResolvedTo: string | undefined;
  if (args.category) {
    const target = args.category.toLowerCase();
    const exact = categoryOptions.find(o => o.label.toLowerCase() === target);
    const partial = exact ?? categoryOptions.find(o => o.label.toLowerCase().includes(target));
    if (partial) {
      formData["msgCatID"] = partial.value;
      categoryResolvedTo = `${partial.label} (value=${partial.value})`;
    }
  }

  // Visible to client
  if (args.visible_to_client) formData["msgCustomerView"] = "1";

  // Dry-run: don't actually POST — return form structure + what we'd send
  if (args.dry_run) {
    return {
      ok: true,
      status: 0,
      bodyPreview: "",
      dryRun: true,
      categoryResolvedTo,
      categoryOptions,
      sentBody: new URLSearchParams(formData).toString().substring(0, 2000),
      formDump: formBlock.substring(0, 5000),
    };
  }

  // 6. POST
  const body = new URLSearchParams(formData).toString();
  const postRes = await fetch(postUrl, {
    method: "POST",
    headers: {
      "Cookie": aspCookies,
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${aspBase}${formPath}`,
      "Origin": aspBase,
    },
    body,
    redirect: "follow",
  });
  const postBody = await postRes.text();
  const success = postRes.ok && postRes.status >= 200 && postRes.status < 400;
  return {
    ok: success,
    status: postRes.status,
    bodyPreview: postBody.substring(0, 1500),
    finalUrl: postRes.url,
    categoryResolvedTo,
    // Always include form dump + sent body on failure for debugging
    formDump: success ? undefined : formBlock.substring(0, 5000),
    error: success ? undefined : `POST returned ${postRes.status}`,
    sentBody: success ? undefined : body.substring(0, 2000),
  };
}

/**
 * Extract the 7-9 digit FileTrac file number from claimView HTML.
 * Tries multiple strategies because claimFileID value="" is JS-rendered (empty in static HTML),
 * but the file number DOES appear in navigation links as claimFID=XXXXXXXX.
 */
function extractFileNumber(html: string): string {
  // 1. claimFID= in any href/onclick/script on the page — most reliable for static HTML
  const mLink = html.match(/claimFID=(\d{7,9})/i);
  if (mLink) return mLink[1];

  // 2. Input value (works when JS has already rendered, i.e. in browser-fetched HTML)
  const mInput = extractInputValue(html, "claimFileID");
  if (mInput) return mInput;

  // 3. JavaScript variable assignment
  const mJS = html.match(/(?:claimFileID|claimFID)\s*[=:]\s*['"](\d{7,9})['"]?/i);
  if (mJS) return mJS[1];

  // 4. "File #" label in page text
  const mText = html.match(/File\s*#[:\s]*(\d{7,9})/i);
  if (mText) return mText[1];

  return "";
}

function extractInputValue(html: string, id: string): string {
  // Pattern A: id/name BEFORE value — only return if value is non-empty
  const mA = html.match(new RegExp(`(?:id|name)=["']?${id}["']?[^>]*value\s*=\s*["']([^"']+)["']`, "i"));
  if (mA?.[1]) return mA[1];

  // Pattern B: value BEFORE id/name  (<input value="Y" ... id="X">) — common in ASP
  const mB = html.match(new RegExp(`<[a-z]+[^>]+value\s*=\s*["']([^"']+)["'][^>]*(?:id|name)=["']?${id}["']`, "i"));
  if (mB?.[1]) return mB[1];

  // Pattern C: element innerText  (<span id="X">Y</span>)
  const mC = html.match(new RegExp(`(?:id|name)=["']?${id}["']?[^>]*>([^<]{1,40})<`, "i"));
  if (mC?.[1]?.trim()) return mC[1].trim();

  return "";
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}
const COGNITO_CLIENT_ID = "1frtspmi2af7o8hqtfsfebrc6";
const COGNITO_REGION = "us-east-1";

/**
 * Use the Cognito refresh token to silently get fresh access + id tokens.
 * The refresh token is valid for 30 days — no user interaction needed.
 */
async function refreshCognitoTokens(
  localStorage: Record<string, string>
): Promise<Record<string, string>> {
  const refreshKey = Object.keys(localStorage).find(k => k.endsWith(".refreshToken"));
  const deviceKey  = Object.keys(localStorage).find(k => k.endsWith(".deviceKey"));
  if (!refreshKey) throw new Error("No Cognito refresh token in session.");

  const authParams: Record<string, string> = { REFRESH_TOKEN: localStorage[refreshKey] };
  if (deviceKey) authParams.DEVICE_KEY = localStorage[deviceKey];

  const res = await fetch(`https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: authParams,
    }),
  });

  if (!res.ok) throw new Error(`Cognito refresh failed: ${await res.text()}`);
  const { AuthenticationResult: r } = await res.json() as any;

  const updated = { ...localStorage };
  const idKey     = Object.keys(updated).find(k => k.endsWith(".idToken"));
  const accessKey = Object.keys(updated).find(k => k.endsWith(".accessToken"));
  if (idKey)     updated[idKey]     = r.IdToken;
  if (accessKey) updated[accessKey] = r.AccessToken;
  return updated;
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fmt(date: string): string {
  // Accept YYYY-MM-DD or M/D/YYYY — always return M/D/YYYY
  if (date.includes("-")) {
    const [y, m, d] = date.split("-");
    return `${parseInt(m)}/${parseInt(d)}/${y}`;
  }
  return date;
}

/**
 * Restore Cognito localStorage session, navigate to linked-companies,
 * click "See Jobs" for the requested company (0-based index), and
 * return the browser + page on the ASP claims system.
 * After navigating, saves ASP session cookies for future fast-path requests.
 */
async function getFiletracPage(companyIndex = 0): Promise<{
  browser: Browser;
  page: Page;
  aspBase: string;
}> {
  let session = loadSession();

  // Proactively refresh Cognito tokens — access/id tokens expire every hour
  // but refresh tokens last 30 days, so this is silent and automatic.
  let localStorage = session.localStorage;
  try {
    localStorage = await refreshCognitoTokens(localStorage);
  } catch {
    // If refresh fails (refresh token also expired), proceed with existing tokens
    // and let the auth check below catch it with a clear error
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Inject Cognito tokens then navigate directly to linked-companies
  // (skips reload + networkidle on the homepage — saves 8-10 seconds)
  await page.goto("https://ftevolve.com", { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate((ls: Record<string, string>) => {
    for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
  }, localStorage);
  await page.goto("https://ftevolve.com/app/legacy/linked-companies", { waitUntil: "domcontentloaded", timeout: 15000 });

  // Wait for React to render "See Jobs" buttons (replaces fixed networkidle + waitForTimeout)
  try {
    await page.waitForSelector('button:has-text("See Jobs")', { timeout: 22000 });
  } catch {
    if (page.url().includes("/auth/")) {
      await browser.close();
      throw new Error(
        "FileTrac Cognito refresh token has expired (30-day limit). " +
        "Re-run: node /Users/hakielmcqueen/mcp-automation/scripts/auth-filetrac.mjs"
      );
    }
    await browser.close();
    throw new Error("FileTrac linked-companies page did not render — no 'See Jobs' buttons found.");
  }

  // Click "See Jobs" for the requested company
  const seeJobsBtns = await page.locator('button:has-text("See Jobs")').all();
  const idx = Math.min(companyIndex, seeJobsBtns.length - 1);
  await seeJobsBtns[idx].click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  await page.waitForTimeout(800);

  const aspBase = new URL(page.url()).origin;

  // Save ASP cookies for future fast-path requests (per-company and top-level)
  const cookies = await page.context().cookies();
  const aspCookies = cookies
    .filter(c => c.domain.includes(new URL(aspBase).hostname))
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
  if (aspCookies) saveAspToSession(aspBase, aspCookies, companyIndex);

  return { browser, page, aspBase };
}

export async function filetracListClaims(args: {
  company_index?: number;
  max_results?: number;
  include_closed?: boolean;
}): Promise<CallToolResult> {
  const companyIdx = args.company_index ?? 1; // Default to Premier Claims (index 1) which has the most jobs
  const { browser, page, aspBase } = await getFiletracPage(companyIdx);

  try {
    // Ensure we're on claimList.asp (getFiletracPage lands here after "See Jobs")
    const claimUrl = page.url();
    if (!claimUrl.includes("claimList")) {
      await page.goto(`${aspBase}/system/claimList.asp`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);
    }

    // For closed claims: use the server-side searchType filter (claimListAll.asp returns 404)
    if (args.include_closed) {
      await page.selectOption('select[name="searchType"]', "closedClaims").catch(() => {});
      await page.evaluate(() => {
        const form = (document as any).claimListForm;
        if (form) form.submit();
      });
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);
    }

    // Find claims by href pattern — works for all companies regardless of file # format:
    // Premier Claims uses 8-digit numbers (81030485), Stewardship uses MBR-XXXXX,
    // US Claim Solutions uses USXXXXXX. The claimView.asp?claimID= href is universal.
    // First link per claimID = file number; subsequent = company claim #, skip those.
    const links = await page.locator("a").all();
    const claims: string[] = [];
    const limit = args.max_results ?? 20;
    const seenClaimIds = new Set<string>();

    for (const link of links) {
      if (claims.length >= limit) break;
      const href = (await link.getAttribute("href").catch(() => "")) || "";
      const claimIdMatch = href.match(/claimView\.asp\?claimID=(\d+)/i);
      if (!claimIdMatch) continue;
      const claimId = claimIdMatch[1];
      if (seenClaimIds.has(claimId)) continue; // skip company claim# link (same claimID, second occurrence)
      seenClaimIds.add(claimId);

      const text = (await link.innerText().catch(() => "")).trim();
      if (!text) continue; // skip empty icon links

      // Get row text for context
      const row = await link.locator("xpath=ancestor::tr[1]").first();
      const rowText = (await row.innerText().catch(() => "")).trim().replace(/\t+/g, " | ").replace(/\n+/g, " ");
      claims.push(`File #: ${text} | Claim ID: ${claimId} | ${rowText}`);
    }

    if (claims.length === 0) return ok("No claims found.");
    return ok(`FileTrac Claims:\n\n${claims.join("\n---\n")}`);
  } finally {
    await browser.close();
  }
}

export async function filetracGetClaim(args: {
  claim_id: string;
  company_index?: number;
}): Promise<CallToolResult> {
  const claimPath = `/system/claimView.asp?claimID=${args.claim_id}`;

  // ── Fast path: use cached ASP session cookie (skips 30s browser flow) ──
  const session = loadSession();
  if (session.aspBase && session.aspCookies) {
    const html = await fetchAspPage(session.aspBase, session.aspCookies, claimPath);
    // Require at least 2 of 4 claim-specific markers — single marker can appear on nav/error pages
    const claimMarkers = [
      html?.includes("claimFileID"),
      html?.includes("claimDateContact"),
      html?.includes("claimDateInspection") || html?.includes("claimDateLoss"),
      html?.includes(`claimID=${args.claim_id}`),
    ].filter(Boolean).length;
    if (html && claimMarkers >= 2) {
      const dateContact    = extractInputValue(html, "claimDateContact");
      const dateInspection = extractInputValue(html, "claimDateInspection");
      const dateComplete   = extractInputValue(html, "claimDateComplete");
      const fileNum        = extractInputValue(html, "claimFileID");

      // Extract body text — skip navigation by finding content after the last </script> tag
      const afterScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
      const bodyText = afterScripts
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 2)
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .substring(0, 4000);

      return ok(
        `Claim Detail (ID: ${args.claim_id}):\n\n` +
        (fileNum ? `File #: ${fileNum}\n` : "") +
        `Date of First Contact: ${dateContact || "(not set)"}\n` +
        `Date of Inspection: ${dateInspection || "(not set)"}\n` +
        `Date of Claim Complete: ${dateComplete || "(not set)"}\n\n` +
        `--- Full Details ---\n${bodyText}`
      );
    }
    // Cookie expired or invalid page — fall through to browser flow which will refresh it
  }

  // ── Slow path: full browser flow (also refreshes cached ASP cookie) ──
  const { browser, page, aspBase } = await getFiletracPage(args.company_index ?? 1);

  try {
    await page.goto(`${aspBase}${claimPath}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    const bodyText = (await page.locator("body").innerText().catch(() => ""))
      .replace(/\t+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const dateContact    = await page.inputValue("#claimDateContact").catch(() => "");
    const dateInspection = await page.inputValue("#claimDateInspection").catch(() => "");
    const dateComplete   = await page.inputValue("#claimDateComplete").catch(() => "");
    const fileNum        = await page.inputValue("#claimFileID").catch(async () =>
      (await page.locator("#claimFileID").innerText().catch(() => ""))
    );

    return ok(
      `Claim Detail (ID: ${args.claim_id}):\n\n` +
      (fileNum ? `File #: ${fileNum}\n` : "") +
      `Date of First Contact: ${dateContact || "(not set)"}\n` +
      `Date of Inspection: ${dateInspection || "(not set)"}\n` +
      `Date of Claim Complete: ${dateComplete || "(not set)"}\n\n` +
      `--- Full Details ---\n${bodyText.substring(0, 4000)}`
    );
  } finally {
    await browser.close();
  }
}

export async function filetracUpdateClaimDates(args: {
  claim_id: string;
  first_contact_date?: string;  // YYYY-MM-DD or M/D/YYYY
  inspection_date?: string;
  completed_date?: string;
  company_index?: number;
}): Promise<CallToolResult> {
  const { browser, page, aspBase } = await getFiletracPage(args.company_index ?? 1);

  try {
    await page.goto(`${aspBase}/system/claimView.asp?claimID=${args.claim_id}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    const updates: string[] = [];

    if (args.first_contact_date) {
      const formatted = fmt(args.first_contact_date);
      await page.fill("#claimDateContact", formatted);
      updates.push(`First Contact: ${formatted}`);
    }

    if (args.inspection_date) {
      const formatted = fmt(args.inspection_date);
      await page.fill("#claimDateInspection", formatted);
      updates.push(`Inspection: ${formatted}`);
    }

    if (args.completed_date) {
      const formatted = fmt(args.completed_date);
      // claimDateComplete may be readonly for some companies — try fill then evaluate
      await page.fill("#claimDateComplete", formatted).catch(() => {});
      await page.evaluate((v: string) => {
        const el = document.getElementById("claimDateComplete") as HTMLInputElement;
        if (el) { el.removeAttribute("readonly"); el.value = v; }
      }, formatted);
      updates.push(`Claim Complete: ${formatted}`);
    }

    if (updates.length === 0) {
      return ok("No dates provided to update.");
    }

    // Click Save
    await page.click("#btnSave");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Check for success — page should reload back to claimView
    const finalUrl = page.url();
    const success = finalUrl.includes("claimView") || finalUrl.includes("claimID");

    return ok(
      `${success ? "✅" : "⚠️"} Claim ${args.claim_id} updated:\n` +
      updates.join("\n") +
      `\nFinal URL: ${finalUrl}`
    );
  } finally {
    await browser.close();
  }
}

export async function filetracAddNote(args: {
  file_number?: string;
  claim_id?: string;
  note: string;
  category?: string;
  visible_to_client?: boolean;
  company_index?: number;
  dry_run?: boolean;
}): Promise<CallToolResult> {
  if (!args.file_number && !args.claim_id) {
    return ok("filetrac_add_note requires either file_number or claim_id.");
  }

  // If only claim_id provided, look up the file number
  let fileNumber = args.file_number ?? "";
  if (!fileNumber && args.claim_id) {
    // Fast path: fetch static HTML and search for claimFID= in navigation links
    const session = loadSession();
    if (session.aspBase && session.aspCookies) {
      const claimHtml = await fetchAspPage(session.aspBase, session.aspCookies,
        `/system/claimView.asp?claimID=${args.claim_id}`);
      if (claimHtml) fileNumber = extractFileNumber(claimHtml);
    }

    // Browser path: JS-rendered #claimFileID value is always correct
    if (!fileNumber) {
      const { browser: lookupBrowser, page: lookupPage, aspBase: lookupBase } = await getFiletracPage(args.company_index ?? 1);
      try {
        await lookupPage.goto(`${lookupBase}/system/claimView.asp?claimID=${args.claim_id}`);
        await lookupPage.waitForLoadState("domcontentloaded");
        fileNumber = await lookupPage.waitForFunction(() => {
          const el = document.getElementById("claimFileID") as HTMLInputElement | null;
          return el?.value?.trim() || null;
        }, { timeout: 8000 }).then(h => h.jsonValue()).catch(async () => {
          const html = await lookupPage.content();
          return extractFileNumber(html) || "";
        }) as string;
      } finally {
        await lookupBrowser.close();
      }
    }

    if (!fileNumber) {
      return ok(`Could not determine file number for claim ID ${args.claim_id}. ` +
        `Please provide file_number directly (8-digit number shown in FileTrac).`);
    }
  }

  // ── Fast-path: HTTP form POST (no Playwright) ──
  // Bypasses Chromium hangs on Railway. Does not fall through to Playwright on
  // failure — Playwright path is broken in current deployment, returning an
  // error is more useful than hanging for 60s.
  try {
    const { aspBase: fastAspBase, aspCookies } = getAspCredentials(args.company_index);
    if (fastAspBase && aspCookies) {
      const result = await postFiletracNoteForm(fastAspBase, aspCookies, fileNumber, {
        note: args.note,
        category: args.category,
        visible_to_client: args.visible_to_client,
        dry_run: args.dry_run,
      });
      const noteSnippet = args.note.substring(0, 120) + (args.note.length > 120 ? "..." : "");
      if (result.dryRun) {
        const optList = (result.categoryOptions ?? [])
          .map(o => `  ${o.value.padEnd(8)} ${o.label}`).join("\n") || "  (no options found)";
        return ok(
          `🔍 DRY RUN — would POST to File #${fileNumber} (no submit performed)\n\n` +
          `Category requested: "${args.category ?? "(none)"}" → ${result.categoryResolvedTo ?? "(no match)"}\n` +
          `Visible to client: ${args.visible_to_client ? "yes" : "no"}\n` +
          `Note: "${noteSnippet}"\n\n` +
          `--- Available msgCatID options ---\n${optList}\n\n` +
          `--- Sent body that WOULD be submitted ---\n${result.sentBody ?? "(none)"}\n\n` +
          `--- Form HTML (first 5000 chars) ---\n${result.formDump ?? "(none)"}`
        );
      }
      if (result.ok && result.status >= 200 && result.status < 400) {
        return ok(
          `✅ Note submitted via HTTP fast-path — File #${fileNumber}\n` +
          `Status: ${result.status}\n` +
          `Final URL: ${result.finalUrl ?? "(unknown)"}\n` +
          `Category resolved: ${result.categoryResolvedTo ?? "(default / not set)"}\n` +
          `Visible to client: ${args.visible_to_client ? "yes" : "no"}\n` +
          `Note: "${noteSnippet}"\n\n` +
          `IMPORTANT: HTTP-side success indicates the POST landed without error, but does ` +
          `not guarantee the entry rendered in the diary. Verify in FileTrac UI before relying on it.\n\n` +
          `--- Response body preview (first 1500 chars) ---\n${result.bodyPreview}`
        );
      }
      return ok(
        `❌ HTTP fast-path failed for File #${fileNumber}\n` +
        `Status: ${result.status} | Error: ${result.error ?? "(see body)"}\n` +
        `Final URL: ${result.finalUrl ?? "(none)"}\n` +
        `Category attempted: ${args.category ?? "(none)"} → resolved: ${result.categoryResolvedTo ?? "(no match)"}\n\n` +
        `--- Sent POST body (first 2000 chars) ---\n${result.sentBody ?? "(no sent body)"}\n\n` +
        `--- Form HTML dump (first 5000 chars) ---\n${result.formDump ?? "(no form dump)"}\n\n` +
        `--- POST response body preview ---\n${result.bodyPreview}`
      );
    }
  } catch (e) {
    return ok(`❌ HTTP fast-path threw for File #${fileNumber}: ${(e as Error).message}`);
  }

  const { browser, page, aspBase } = await getFiletracPage(args.company_index ?? 1);

  try {
    await page.goto(`${aspBase}/system/quickNotes.asp?claimFID=${fileNumber}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Verify file # loaded correctly
    const fileId = await page.inputValue("#claimFileID").catch(() => "");
    if (!fileId || fileId !== fileNumber) {
      // Try to set it if not pre-filled
      await page.fill("#claimFileID", fileNumber).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Fill note text
    await page.fill("#msgText", args.note);

    // Set category if provided
    if (args.category) {
      await page.selectOption("#msgCatID", { label: args.category }).catch(async () => {
        // Try partial match
        const options = await page.locator("#msgCatID option").all();
        for (const opt of options) {
          const text = await opt.innerText();
          if (text.toLowerCase().includes(args.category!.toLowerCase())) {
            const val = await opt.getAttribute("value");
            if (val) await page.selectOption("#msgCatID", val);
            break;
          }
        }
      });
    }

    // Visible to client
    if (args.visible_to_client) {
      await page.check("#msgCustomerView").catch(() => {});
    }

    // Submit — click Save button (look for submit/save input)
    await page.click('input[type="button"][value*="Save"], input[type="submit"], button[type="submit"]').catch(async () => {
      // Try JavaScript submit
      await page.evaluate(() => {
        const form = document.getElementById("frmNotes") as HTMLFormElement;
        if (form) {
          (form as any).action = (form.action || "") + (form.action.includes("?") ? "&GO=1" : "?GO=1");
          form.submit();
        }
      });
    });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    return ok(`✅ Note added to FileTrac claim (File #${fileNumber}):\n"${args.note.substring(0, 100)}..."`);
  } finally {
    await browser.close();
  }
}

export async function filetracSubmitTimeExpense(args: {
  file_number: string;
  date?: string;  // M/D/YYYY or YYYY-MM-DD; defaults to today
  hours?: number;
  service_notes?: string;
  expense_amount?: number;
  expense_description?: string;
  company_index?: number;
}): Promise<CallToolResult> {
  const { browser, page, aspBase } = await getFiletracPage(args.company_index ?? 1);

  try {
    await page.goto(`${aspBase}/system/quickTimelog.asp?claimFID=${args.file_number}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Set file number if not loaded
    const currentFileId = await page.inputValue("#claimFileID").catch(() => "");
    if (!currentFileId || currentFileId !== args.file_number) {
      await page.fill("#claimFileID", args.file_number).catch(() => {});
      // Trigger the onchange to load file data
      await page.evaluate(() => {
        const el = document.getElementById("claimFileID") as HTMLInputElement;
        if (el) el.dispatchEvent(new Event("change"));
      });
      await page.waitForTimeout(2000);
    }

    // Set date
    if (args.date) {
      await page.fill("#msgTimeStamp", fmt(args.date)).catch(() => {});
    }

    const filled: string[] = [];

    // Fill service/time row
    if (args.hours !== undefined) {
      // Set quantity/hours for row 1
      await page.fill("#svcQty1", String(args.hours)).catch(() => {});
      if (args.service_notes) {
        await page.fill("#svcNotes1", args.service_notes).catch(() => {});
      }
      filled.push(`Hours: ${args.hours}`);
    }

    // Fill expense row
    if (args.expense_amount !== undefined) {
      await page.fill("#expAmt1", String(args.expense_amount)).catch(() => {});
      if (args.expense_description) {
        await page.fill("#expCommDesc1", args.expense_description).catch(() => {});
      }
      filled.push(`Expense: $${args.expense_amount}${args.expense_description ? ` (${args.expense_description})` : ""}`);
    }

    if (filled.length === 0) {
      return ok("No time or expense data provided.");
    }

    // Submit
    await page.evaluate(() => {
      const form = document.getElementById("frmNotes") as HTMLFormElement;
      if (form) {
        form.action = "quickTimelog.asp?GO=1";
        form.submit();
      }
    });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    return ok(
      `✅ Time & Expense submitted for File #${args.file_number}:\n` +
      filled.join("\n")
    );
  } finally {
    await browser.close();
  }
}

// Matches M/D/YYYY, MM/DD/YYYY, and M/D/YY date formats found in FileTrac diary rows
const DIARY_DATE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;

function parseNotes(html: string, claimId: string): string {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const rows: string[] = [];
  const trMatches = clean.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trMatches) {
    const cells = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(td => td.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim())
      .filter(cell => cell.length > 0);

    if (cells.length < 2) continue;

    // REQUIRE a date pattern in at least one cell.
    // Real diary entries always have a date (M/D/YYYY); form chrome (File #:, Note Category:,
    // Characters left:) never does. This is the primary filter against form scaffolding.
    const hasDate = cells.some(c => DIARY_DATE_RE.test(c));
    if (!hasDate) continue;

    rows.push(cells.join(" | "));
  }

  if (rows.length === 0) {
    // No date-bearing rows found — return raw body text + signal for caller to show debug
    const bodyText = htmlToText(html);
    return `(table-parse-failed)\n${bodyText.substring(0, 6000)}`;
  }

  return `Claim ${claimId} — Notes/Diary (${rows.length} entries):\n\n${rows.join("\n---\n")}`;
}

// Known FileTrac diary URL patterns to try in order
// fileNum = the 8-digit file number (claimFileID) — quickNotes uses claimFID (file number), not claimID
const DIARY_PATH_PATTERNS = (claimId: string, fileNum?: string) => {
  const patterns: string[] = [];
  if (fileNum) {
    patterns.push(
      `/system/quickNotes.asp?claimFID=${fileNum}`,      // add-note form also shows existing notes
      `/system/quickNotesList.asp?claimFID=${fileNum}`,
      `/system/claimDiary.asp?claimFID=${fileNum}`,
      `/system/msgView.asp?claimFID=${fileNum}`,
      `/system/claimNotes.asp?claimFID=${fileNum}`,
      `/system/claimMsg.asp?claimFID=${fileNum}`,
    );
  }
  patterns.push(
    `/system/claimDiary.asp?claimID=${claimId}`,
    `/system/msgView.asp?claimID=${claimId}`,
    `/system/claimNotes.asp?claimID=${claimId}`,
    `/system/diary.asp?claimID=${claimId}`,
    `/system/claimMsg.asp?claimID=${claimId}`,
  );
  return patterns;
};

/**
 * Returns true only for pages that contain FileTrac-specific note field names.
 * Deliberately narrow — "Diary", "diary", and generic "Note+<td>" are excluded
 * because those strings also appear on the claims list / claim overview pages.
 */
function looksLikeNotesPage(html: string): boolean {
  // Only match field names that are unique to the notes form/table, not nav links or claims list.
  return html.includes("msgDate") || html.includes("msgText") || html.includes("msgCatID") ||
         html.includes("msgNoteID");
}

/** Returns true if the parsed result actually contains note rows (not just form scaffolding). */
function hasNoteContent(parsed: string): boolean {
  return !parsed.startsWith("(table-parse-failed)");
}

export async function filetracGetNotes(args: {
  claim_id: string;
  company_index?: number;
}): Promise<CallToolResult> {
  const diag: string[] = [`[filetracGetNotes] claim_id=${args.claim_id}`];

  // ── Fast-path: direct HTTP GET with cached ASP cookies (no Playwright) ──
  // Avoids Chromium hangs on Railway. Same fetch mechanism as filetrac_get_claim.
  // Falls through to browser path only if fast-path can't determine the file number.
  try {
    const { aspBase: fastAspBase, aspCookies } = getAspCredentials(args.company_index);
    if (fastAspBase && aspCookies) {
      const claimViewHtml = await fetchAspPage(
        fastAspBase, aspCookies, `/system/claimView.asp?claimID=${args.claim_id}`
      );
      const fileNum = claimViewHtml ? extractFileNumber(claimViewHtml) : "";
      diag.push(`Fast-path: aspBase=${fastAspBase} fileNum=${fileNum || "n/a"}`);

      let lastBody = "";
      let lastUrl = "";

      // Step A: claimView.asp may have diary entries inlined (Notes tab is just JS show/hide)
      if (claimViewHtml && looksLikeNotesPage(claimViewHtml)) {
        const cvResult = parseNotes(claimViewHtml, args.claim_id);
        if (hasNoteContent(cvResult)) {
          return ok(
            `[Source: fast-path claimView | URL: ${fastAspBase}/system/claimView.asp?claimID=${args.claim_id}]\n` + cvResult
          );
        }
        diag.push(`claimView has notes markers but no date rows`);
        lastBody = cvResult;
        lastUrl = `/system/claimView.asp?claimID=${args.claim_id}`;
      }

      if (fileNum) {
        // quickNotesList first — name suggests it's the listing page (vs. quickNotes.asp = add form)
        const fastUrls = [
          `/system/quickNotesList.asp?claimFID=${fileNum}`,
          `/system/claimMsg.asp?claimFID=${fileNum}`,
          `/system/quickNotes.asp?claimFID=${fileNum}`,
          `/system/claimDiary.asp?claimFID=${fileNum}`,
          `/system/msgView.asp?claimFID=${fileNum}`,
          `/system/claimNotes.asp?claimFID=${fileNum}`,
        ];
        for (const url of fastUrls) {
          const html = await fetchAspPage(fastAspBase, aspCookies, url);
          if (!html) { diag.push(`Fast: ${url} → null`); continue; }
          diag.push(`Fast: ${url} → ${html.length}c`);
          if (looksLikeNotesPage(html)) {
            const result = parseNotes(html, args.claim_id);
            if (hasNoteContent(result)) {
              return ok(`[Source: fast-path | URL: ${fastAspBase}${url}]\n` + result);
            }
            diag.push(`  → notes page but no date rows`);
            lastBody = result;
            lastUrl = url;
          }
        }
        // File # known + cookies valid + no parseable notes anywhere.
        // Don't fall through to Playwright (it hangs on Railway). Surface body text.
        const bodyDump = lastBody
          ? `\n=== Body text snippet from ${lastUrl} (parser missed structure) ===\n${lastBody.substring(0, 4000)}\n`
          : "";
        return ok(
          `=== FileTrac Notes — claim ${args.claim_id} (File #${fileNum}) — fast-path ===\n` +
          `No diary entries parsed. If you expect entries here, run filetrac_refresh_session and retry.\n\n` +
          `Diag: ${diag.join(" | ")}\n` +
          bodyDump
        );
      }
    } else {
      diag.push(`Fast-path: no aspCredentials for company_index=${args.company_index ?? 1}`);
    }
  } catch (e) {
    diag.push(`Fast-path error: ${(e as Error).message}`);
  }

  const { browser, page, aspBase } = await getFiletracPage(args.company_index ?? 1);
  try {
    // Capture ALL non-asset requests — Notes tab may fire AJAX rather than .asp navigation
    const allRequests: string[] = [];
    page.on("request", req => {
      const u = req.url();
      if (!u.includes("google") && !u.includes("amazon") && !u.includes("cloudfront") &&
          !/\.(png|gif|jpg|jpeg|css|js|ico|woff|ttf)(\?|$)/i.test(u) &&
          !u.startsWith("data:")) {
        allRequests.push(u);
      }
    });

    // Navigate to the specific claim by clicking its link from the list
    const claimLink = page.locator(
      `a[href*="claimID=${args.claim_id}"], a:text-is("${args.claim_id}")`
    ).first();

    if (await claimLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      const href = (await claimLink.getAttribute("href").catch(() => "")) ?? "";
      diag.push(`Found claim link on list: href="${href}"`);
      await claimLink.click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);
    } else {
      diag.push(`Claim link not found on list, trying direct goto`);
      await page.goto(`${aspBase}/system/claimView.asp?claimID=${args.claim_id}`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);
    }

    const postNavUrl = page.url();
    diag.push(`After claim nav: ${postNavUrl}`);
    if (postNavUrl.includes("claimList")) {
      return ok(
        `Could not navigate to claim "${args.claim_id}" — redirected to claims list.\n` +
        `Ensure claim_id is the internal claim ID (from filetrac_list_claims "Claim ID:" column).\n` +
        `Diag: ${diag.join(" | ")}`
      );
    }

    const browserFileNum = await page.waitForFunction(() => {
      const el = document.getElementById("claimFileID") as HTMLInputElement | null;
      return el?.value && el.value.trim().length > 0 ? el.value.trim() : null;
    }, { timeout: 8000 }).then(h => h.jsonValue()).catch(async () => {
      return extractFileNumber(await page.content()) || null;
    }) as string | null;
    diag.push(`browserFileNum="${browserFileNum}"`);

    // ── Step 1: Inline scrape — notes may be pre-loaded in the claimView DOM ──
    // The Notes tab on this app has href="" onclick="", meaning it shows/hides
    // content that was already embedded in the initial page load (no network request).
    const claimViewHtml = await page.content();
    if (looksLikeNotesPage(claimViewHtml)) {
      const result = parseNotes(claimViewHtml, args.claim_id);
      if (hasNoteContent(result)) {
        return ok(`[Source: claimView inline | URL: ${postNavUrl}]\n` + result);
      }
      diag.push("claimView has note markers but parseNotes found no date rows");
    }

    // ── Step 2: Direct URL patterns using the established browser session ──
    const diaryUrls: string[] = [];
    if (browserFileNum) {
      diaryUrls.push(
        `${aspBase}/system/quickNotes.asp?claimFID=${browserFileNum}`,
        `${aspBase}/system/claimDiary.asp?claimFID=${browserFileNum}`,
        `${aspBase}/system/msgView.asp?claimFID=${browserFileNum}`,
      );
    }
    diaryUrls.push(
      `${aspBase}/system/claimDiary.asp?claimID=${args.claim_id}`,
      `${aspBase}/system/msgView.asp?claimID=${args.claim_id}`,
      `${aspBase}/system/diary.asp?claimID=${args.claim_id}`,
    );

    for (const url of diaryUrls) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const html = await page.content();
      const frameUrl = page.url();
      diag.push(`Tried: ${url} → ${frameUrl} (${html.length}c)`);
      if (looksLikeNotesPage(html)) {
        const result = parseNotes(html, args.claim_id);
        if (hasNoteContent(result)) {
          return ok(`[Source: direct URL | URL: ${frameUrl}]\n` + result);
        }
        diag.push(`  → has note markers but no date rows`);
      }
    }

    // ── Step 3: Click Notes tab, then check DOM + iframes ──
    await page.goto(`${aspBase}/system/claimView.asp?claimID=${args.claim_id}`,
      { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const notesTab = page.locator([
      'a:has-text("Notes")',
      'a:has-text("Diary")',
      'a:has-text("Messages")',
      'td:has-text("Notes")',
      'li:has-text("Notes")',
      '[onclick*="note" i]',
      '[onclick*="diary" i]',
    ].join(", ")).first();

    let tabFound = false;
    if (await notesTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      tabFound = true;
      const reqsBefore = allRequests.length;
      await notesTab.click();
      await page.waitForTimeout(3000);
      const newReqs = allRequests.slice(reqsBefore);
      diag.push(`Tab click new requests (${newReqs.length}): ${newReqs.slice(0, 5).join(", ") || "(none)"}`);

      const afterClickHtml = await page.content();
      if (looksLikeNotesPage(afterClickHtml)) {
        const result = parseNotes(afterClickHtml, args.claim_id);
        if (hasNoteContent(result)) {
          return ok(`[Source: after tab click | URL: ${page.url()}]\n` + result);
        }
      }

      for (const frame of page.frames()) {
        const fUrl = frame.url();
        if (!fUrl || fUrl === page.url() || fUrl === "about:blank") continue;
        const fHtml = await frame.content().catch(() => "");
        diag.push(`Frame: ${fUrl} (${fHtml.length}c)`);
        if (looksLikeNotesPage(fHtml)) {
          const result = parseNotes(fHtml, args.claim_id);
          if (hasNoteContent(result)) {
            return ok(`[Source: iframe | URL: ${fUrl}]\n` + result);
          }
        }
      }
    } else {
      diag.push("No Notes/Diary tab found on claim page");
    }

    // Return discovery data
    const allLinks = await page.locator("a, [onclick]").all();
    const linkDump: string[] = [];
    for (const link of allLinks.slice(0, 40)) {
      const text = (await link.innerText().catch(() => "")).trim().substring(0, 30);
      const href = (await link.getAttribute("href").catch(() => "")) ?? "";
      const onclick = (await link.getAttribute("onclick").catch(() => "")) ?? "";
      if (text || href || onclick) linkDump.push(`"${text}" href="${href}" onclick="${onclick}"`);
    }

    const bodyText = (await page.locator("body").innerText().catch(() => ""))
      .replace(/\s{3,}/g, "\n").trim().substring(0, 2000);

    return ok(
      `=== FileTrac Notes — No notes found ===\n` +
      `Claim ID: ${args.claim_id} | File #: ${browserFileNum || "unknown"}\n` +
      `Tab found: ${tabFound} | URLs tried: ${diaryUrls.length}\n` +
      `All requests intercepted (${allRequests.length}):\n` +
      allRequests.join("\n") +
      `\n\nLinks on claim page:\n${linkDump.join("\n")}\n\n` +
      `Diag: ${diag.join(" | ")}\n\n` +
      `=== Page body text (2000 chars) ===\n${bodyText}`
    );
  } finally {
    await browser.close();
  }
}

export async function filetracBulkGetClaims(args: {
  claim_ids: string[];
  company_index?: number;
}): Promise<CallToolResult> {
  const ids = args.claim_ids.slice(0, 20); // safety cap at 20
  const session = loadSession();
  const results: string[] = [];
  const failed: string[] = [];

  for (const claimId of ids) {
    const claimPath = `/system/claimView.asp?claimID=${claimId}`;

    if (session.aspBase && session.aspCookies) {
      const html = await fetchAspPage(session.aspBase, session.aspCookies, claimPath);
      const markers = [
        html?.includes("claimFileID"),
        html?.includes("claimDateContact"),
        html?.includes("claimDateInspection") || html?.includes("claimDateLoss"),
        html?.includes(`claimID=${claimId}`),
      ].filter(Boolean).length;

      if (html && markers >= 2) {
        const fileNum        = extractFileNumber(html);
        const dateContact    = extractInputValue(html, "claimDateContact");
        const dateInspection = extractInputValue(html, "claimDateInspection");
        const dateComplete   = extractInputValue(html, "claimDateComplete");
        const afterScripts   = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "");
        const bodyText = afterScripts
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
          .split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 2)
          .join("\n").replace(/\n{3,}/g, "\n\n")
          .substring(0, 1500);

        results.push(
          `=== Claim ${claimId}${fileNum ? ` (File #${fileNum})` : ""} ===\n` +
          `Contact: ${dateContact || "(not set)"} | Inspection: ${dateInspection || "(not set)"} | Complete: ${dateComplete || "(not set)"}\n` +
          bodyText
        );
        continue;
      }
    }

    failed.push(claimId);
    results.push(`=== Claim ${claimId} === FAILED — session expired or claim not found`);
  }

  const header = `Bulk claim details (${results.length - failed.length} ok, ${failed.length} failed) — ${ids.length} requested:\n\n`;
  return ok(header + results.join("\n\n"));
}

export async function filetracBulkAddNote(args: {
  notes: Array<{ claim_id: string; note: string }>;
  category?: string;
  company_index?: number;
}): Promise<CallToolResult> {
  const items = args.notes.slice(0, 10); // safety cap
  const session = loadSession();
  const results: string[] = [];

  // Fast-path: resolve file numbers for all claim IDs before launching browser
  const fileNumbers: Record<string, string> = {};
  if (session.aspBase && session.aspCookies) {
    for (const { claim_id } of items) {
      const html = await fetchAspPage(session.aspBase, session.aspCookies,
        `/system/claimView.asp?claimID=${claim_id}`);
      if (html) {
        const fn = extractFileNumber(html);
        if (fn) fileNumbers[claim_id] = fn;
      }
    }
  }

  // Single browser session for all note submissions
  const { browser, page, aspBase } = await getFiletracPage(args.company_index ?? 1);
  try {
    for (const { claim_id, note } of items) {
      const fileNumber = fileNumbers[claim_id];
      if (!fileNumber) {
        results.push(`❌ Claim ${claim_id}: could not determine file number — skipped`);
        continue;
      }

      await page.goto(`${aspBase}/system/quickNotes.asp?claimFID=${fileNumber}`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);

      await page.fill("#msgText", note);

      if (args.category) {
        await page.selectOption("#msgCatID", { label: args.category }).catch(async () => {
          const options = await page.locator("#msgCatID option").all();
          for (const opt of options) {
            const text = await opt.innerText();
            if (text.toLowerCase().includes(args.category!.toLowerCase())) {
              const val = await opt.getAttribute("value");
              if (val) await page.selectOption("#msgCatID", val);
              break;
            }
          }
        });
      }

      await page.click('input[type="button"][value*="Save"], input[type="submit"], button[type="submit"]').catch(async () => {
        await page.evaluate(() => {
          const form = document.getElementById("frmNotes") as HTMLFormElement;
          if (form) form.submit();
        });
      });
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);

      results.push(`✅ Claim ${claim_id} (File #${fileNumber}): note added`);
    }
  } finally {
    await browser.close();
  }

  return ok(`Bulk note results (${items.length} claims):\n${results.join("\n")}`);
}

// ─── Session Refresh ──────────────────────────────────────────────────────────

/**
 * Re-authenticate via ftevolve.com SSO for one or all companies.
 * Refreshes the cached ASP session cookies without requiring MFA
 * (uses existing Cognito tokens if valid; if expired, falls back to
 * whatever browser session state exists).
 *
 * company_index: 0=Accelerated, 1=Premier Claims, 2=Stewardship, 3=US Claim Solutions
 * If omitted, refreshes all 4 companies sequentially.
 */
export async function filetracRefreshSession(args: {
  company_index?: number;
}): Promise<CallToolResult> {
  let session = loadSession();

  // Proactively try Cognito token refresh — may fail if 30-day limit hit
  let localStorage = session.localStorage;
  try {
    localStorage = await refreshCognitoTokens(localStorage);
  } catch {
    // Expired — proceed with existing tokens; browser cookies may still be valid
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto("https://ftevolve.com", { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.evaluate((ls: Record<string, string>) => {
      for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
    }, localStorage);
    await page.goto("https://ftevolve.com/app/legacy/linked-companies", { waitUntil: "domcontentloaded", timeout: 15000 });

    try {
      await page.waitForSelector('button:has-text("See Jobs")', { timeout: 20000 });
    } catch {
      if (page.url().includes("/auth/")) {
        return ok(
          "FileTrac Cognito refresh token has expired (30-day limit).\n" +
          "Re-run: node /Users/hakielmcqueen/mcp-automation/scripts/auth-filetrac.mjs\n" +
          "Then run Hakiel's update-railway-sessions.mjs to sync to Railway."
        );
      }
      return ok("FileTrac linked-companies page did not render. Cannot refresh session.");
    }

    const seeJobsBtns = await page.locator('button:has-text("See Jobs")').all();
    const companyCount = seeJobsBtns.length;

    // Determine which indices to refresh
    const indicesToRefresh = args.company_index !== undefined
      ? [args.company_index]
      : Array.from({ length: companyCount }, (_, i) => i);

    const results: string[] = [];

    for (const idx of indicesToRefresh) {
      if (idx >= companyCount) {
        results.push(`Company ${idx}: skipped (only ${companyCount} companies found)`);
        continue;
      }

      // Navigate back to linked-companies before each click
      await page.goto("https://ftevolve.com/app/legacy/linked-companies", { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForSelector('button:has-text("See Jobs")', { timeout: 15000 });
      const btns = await page.locator('button:has-text("See Jobs")').all();

      await btns[idx].click();
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
      await page.waitForTimeout(800);

      const aspBase = new URL(page.url()).origin;
      const allCookies = await context.cookies();
      const hostname = new URL(aspBase).hostname;
      const aspCookies = allCookies
        .filter(c => c.domain.includes(hostname))
        .map(c => `${c.name}=${c.value}`)
        .join("; ");

      if (aspCookies) {
        saveAspToSession(aspBase, aspCookies, idx);
        results.push(`Company ${idx}: ✅ refreshed — ${aspBase} (${aspCookies.substring(0, 40)}...)`);
      } else {
        results.push(`Company ${idx}: ⚠️ no cookies captured — ${aspBase}`);
      }
    }

    return ok(
      `FileTrac session refresh complete:\n${results.join("\n")}\n\n` +
      `To sync to Railway run: node /Users/hakielmcqueen/mcp-automation/scripts/update-railway-sessions.mjs`
    );
  } finally {
    await browser.close();
  }
}

export async function filetracListCompanies(args: Record<string, never>): Promise<CallToolResult> {
  let session: { cookies: unknown[]; localStorage: Record<string, string> };
  if (process.env.FILETRAC_SESSION_JSON) {
    session = JSON.parse(process.env.FILETRAC_SESSION_JSON);
  } else if (fs.existsSync(SESSION_PATH)) {
    session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
  } else {
    throw new Error("FileTrac session not found. Set FILETRAC_SESSION_JSON env var.");
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto("https://ftevolve.com");
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate((ls: Record<string, string>) => {
      for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
    }, session.localStorage);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(4000);

    await page.goto("https://ftevolve.com/app/legacy/linked-companies");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(5000);

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const lines = bodyText.split("\n").map(l => l.trim()).filter(l => l);

    // Parse company cards from body text
    const companies: string[] = [];
    let idx = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (lines[i + 1] === "Adjuster" && lines[i + 2] === "See Jobs") {
        const myJobs = lines[i + 4] || "0";
        companies.push(`Index ${idx}: ${line} | My Jobs: ${myJobs}`);
        idx++;
      }
    }

    if (companies.length === 0) {
      return ok(`Linked companies page loaded. Body text:\n${bodyText.substring(0, 1000)}`);
    }
    return ok(`FileTrac Linked Companies:\n\n${companies.join("\n")}`);
  } finally {
    await browser.close();
  }
}

// ─── Document Listing & Download ──────────────────────────────────────────────

interface FiletracDocument {
  report_id: string;
  filename: string;
  date: string;
  file_type: string;
  size_kb: string;
  url: string;
  description: string;
  on_cloud: boolean;
}

/**
 * Parse all uploaded report/document entries from the expanded claimList HTML.
 * Each report entry has data-reportid, data-path, and data-on-cloud on a span element.
 */
function parseDocumentEntries(html: string): FiletracDocument[] {
  const docs: FiletracDocument[] = [];

  // Match all spans with data-reportid, data-path, and optionally data-on-cloud
  const spanRe = /<span[^>]+data-reportid="(\d+)"[^>]+data-path="([^"]+)"[^>]*(?:data-on-cloud="([^"]*)")?/gi;
  let m: RegExpExecArray | null;

  while ((m = spanRe.exec(html)) !== null) {
    const reportID = m[1];
    const dataPath = m[2];
    const onCloud = (m[3] ?? "").toLowerCase() === "true";
    const spanIdx = m.index;

    // Look at context before the span for title, type, description, date
    const lookBack = Math.max(0, spanIdx - 2000);
    const before = html.substring(lookBack, spanIdx);

    // Title: last <a href="reportEdit_TrackEditRpt...">TITLE</a>
    const titleMatch = before.match(/reportEdit_TrackEditRpt[^"]+">([^<]+)<\/a[^>]*>\s*<\/b[^>]*>\s*\(<i>([^<]+)<\/i>\)\s*-\s*([^\n<]{0,120})/i);
    const title = titleMatch ? titleMatch[1].trim() : "";
    const fileType = titleMatch ? titleMatch[2].trim() : "PDF";
    const rawDesc = titleMatch ? titleMatch[3].trim() : "";

    // Date: last date pattern before this span
    const dateMatches = [...before.matchAll(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g)];
    const date = dateMatches.length > 0 ? dateMatches[dateMatches.length - 1][1] : "";

    // Size: look forward from span for NNNkb pattern (may be up to 1600 chars ahead)
    const after = html.substring(spanIdx, spanIdx + 1600);
    const sizeMatch = after.match(/>\s*(\d+\s*KB)\s*</i);
    const sizeKb = sizeMatch ? sizeMatch[1] : "";

    // Filename from URL path segment
    const urlParts = dataPath.replace(/\?.*/, "").split("/");
    const filename = decodeURIComponent(urlParts[urlParts.length - 1]);

    // Clean description: strip trailing HTML artifacts
    const description = rawDesc.replace(/<[^>]+>/g, "").replace(/^\s*[-–]\s*/, "").trim();

    docs.push({
      report_id: reportID,
      filename,
      date,
      file_type: fileType,
      size_kb: sizeKb,
      url: dataPath,
      description: description || title,
      on_cloud: onCloud,
    });
  }

  return docs;
}

/**
 * List uploaded documents/reports for a FileTrac claim.
 * Returns report_id, filename, date, file_type, size_kb, url, description, on_cloud for each.
 * Use report_id with filetrac_download_report to download.
 *
 * company_index: 0=Accelerated, 1=Premier Claims (default), 2=Stewardship, 3=US Claim Solutions
 * Note: if the claim is not found, try a different company_index.
 */
export async function filetracListDocuments(args: {
  claim_id: string | number;
  company_index?: number;
}): Promise<CallToolResult> {
  const companyIdx = args.company_index ?? 1;
  const { aspBase, aspCookies } = getAspCredentials(companyIdx);
  if (!aspBase || !aspCookies) {
    return ok(
      "FileTrac ASP session not available.\n" +
      "Run: node scripts/auth-filetrac.mjs\n" +
      "Then run filetrac_refresh_session to capture all company cookies."
    );
  }

  // Check session validity and give a helpful error if expired
  const valid = await isAspSessionValid(aspBase, aspCookies);
  if (!valid) {
    return ok(
      `FileTrac session for company ${companyIdx} is expired.\n` +
      "Run filetrac_refresh_session to re-authenticate, then retry."
    );
  }

  const claimID = String(args.claim_id);

  // Load the expanded claim list view — this is where report entries live
  const listUrl = `/system/claimList.asp?allBranches=1&searchType=claimID&searchTgt=${claimID}&expand=${claimID}`;
  const html = await fetchAspPage(aspBase, aspCookies, listUrl);

  if (!html) {
    return ok(
      `Failed to load claim list for claim ${claimID} (company ${companyIdx}).\n` +
      "If the claim belongs to a different company, specify company_index:\n" +
      "0=Accelerated, 1=Premier Claims, 2=Stewardship, 3=US Claim Solutions"
    );
  }

  const docs = parseDocumentEntries(html);

  if (docs.length === 0) {
    // Check if claim was found at all (vs. no documents)
    const claimFound = html.includes(`claimID=${claimID}`) || html.includes(`searchTgt=${claimID}`);
    if (!claimFound || html.length < 30000) {
      return ok(
        `Claim ${claimID} not found under company ${companyIdx} (${aspBase}).\n` +
        "Try a different company_index: 0=Accelerated, 1=Premier Claims, 2=Stewardship, 3=US Claim Solutions"
      );
    }
    return ok(`No documents found for claim ${claimID}. The claim exists but has no uploaded reports.`);
  }

  const cloudNote = docs.some(d => d.on_cloud)
    ? "\nNote: Cloud-stored files (on_cloud=true) require report_id for download — pass it to filetrac_download_report."
    : "";

  const lines = docs.map((d, i) =>
    `${i + 1}. [report_id=${d.report_id}] ${d.filename}\n` +
    `   Type: ${d.file_type} | Date: ${d.date} | Size: ${d.size_kb} | Cloud: ${d.on_cloud}\n` +
    (d.description ? `   Desc: ${d.description}\n` : "") +
    `   URL: ${d.url}`
  );

  return ok(
    `Documents for claim ${claimID} — company ${companyIdx} (${aspBase}) — ${docs.length} found:${cloudNote}\n\n` +
    lines.join("\n\n")
  );
}

/**
 * Fetch the authoritative download URL for a report by loading reportView.asp.
 * This is required for cloud-stored files (data-on-cloud="true") — the direct
 * data-path URL returns 404, but reportView.asp's loadContent() JS has the
 * correct cloudDownloads path that actually serves the file.
 *
 * Returns the URL string, or null if it can't be extracted.
 */
async function getReportDownloadUrl(
  aspBase: string,
  aspCookies: string,
  reportId: string
): Promise<string | null> {
  const html = await fetchAspPage(aspBase, aspCookies, `/system/reportView.asp?reportID=${reportId}`);
  if (!html) return null;
  const urlMatch = html.match(/var URL = ['"]([^'"]+)['"]/);
  if (!urlMatch) return null;
  const relPath = urlMatch[1];
  // Build absolute URL: aspBase + /system/ + ./cloudDownloads/... (or ./ENCLOSURES/...)
  return `${aspBase}/system/${relPath}`;
}

/**
 * Download an uploaded FileTrac report/document to a local path.
 *
 * Preferred usage: supply report_id (and company_index if not Premier Claims).
 * The tool will use reportView.asp to get the authoritative download URL,
 * which works for both local-server and cloud-stored files.
 *
 * Alternate: supply report_url from filetrac_list_documents. Works for
 * local-server files (on_cloud=false). Cloud files (on_cloud=true) need report_id.
 *
 * company_index: 0=Accelerated, 1=Premier Claims (default), 2=Stewardship, 3=US Claim Solutions
 */
export async function filetracDownloadReport(args: {
  claim_id?: string | number;
  report_id?: string | number;
  report_url?: string;
  dest_path: string;
  company_index?: number;
}): Promise<CallToolResult> {
  const companyIdx = args.company_index ?? 1;
  const { aspBase, aspCookies } = getAspCredentials(companyIdx);
  if (!aspBase || !aspCookies) {
    return ok(
      "FileTrac ASP session not available.\n" +
      "Run filetrac_refresh_session first."
    );
  }

  // Determine the final download URL
  let targetUrl: string | undefined;

  if (args.report_id) {
    // Preferred path: get authoritative URL from reportView.asp
    const reportID = String(args.report_id);
    const authUrl = await getReportDownloadUrl(aspBase, aspCookies, reportID);
    if (!authUrl) {
      return ok(
        `Could not get download URL for report ${reportID}.\n` +
        "Session may be expired — run filetrac_refresh_session then retry."
      );
    }
    targetUrl = authUrl;
  } else if (args.report_url) {
    // Caller supplied URL directly — try it, fall back to cloud variant if needed
    targetUrl = args.report_url;
  } else if (args.claim_id) {
    // Look up via claim_id to get first available report — rarely needed
    return ok("Supply report_id (from filetrac_list_documents) for a specific file, or report_url for direct download.");
  } else {
    return ok("Provide report_id (preferred) or report_url. Use filetrac_list_documents to get report IDs.");
  }

  // Fetch the binary file
  const fetchFile = async (url: string): Promise<{ buf: Buffer; contentType: string; status: number }> => {
    const res = await fetch(url, {
      headers: {
        "Cookie": aspCookies,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, contentType: res.headers.get("content-type") ?? "", status: res.status };
  };

  let { buf, contentType, status } = await fetchFile(targetUrl).catch(e => ({
    buf: Buffer.alloc(0), contentType: "", status: 0,
  }));

  // If direct URL returned HTML or error, try cloud variant as fallback
  if ((contentType.includes("text/html") || status >= 400 || buf.length === 0) && !args.report_id) {
    const cloudUrl = targetUrl.replace("/system/./ENCLOSURES", "/system/./cloudDownloads/ENCLOSURES");
    if (cloudUrl !== targetUrl) {
      const fallback = await fetchFile(cloudUrl).catch(e => ({
        buf: Buffer.alloc(0), contentType: "", status: 0,
      }));
      if (!fallback.contentType.includes("text/html") && fallback.buf.length > 500) {
        ({ buf, contentType, status } = fallback);
        targetUrl = cloudUrl;
      }
    }
  }

  if (contentType.includes("text/html") || status >= 400) {
    return ok(
      `Download failed (HTTP ${status}, content-type: ${contentType}).\n` +
      "If this is a cloud-stored file, supply report_id instead of report_url so the tool can use reportView.asp to get the correct URL.\n" +
      "If session expired, run filetrac_refresh_session first."
    );
  }

  if (buf.length === 0) {
    return ok("Downloaded file is empty (0 bytes). The file may have been deleted or the URL is invalid.");
  }

  // Ensure destination directory exists and save
  const destResolved = path.resolve(args.dest_path);
  fs.mkdirSync(path.dirname(destResolved), { recursive: true });
  fs.writeFileSync(destResolved, buf);

  const sizeKb = (buf.byteLength / 1024).toFixed(1);
  const filename = path.basename(destResolved);
  return ok(
    `Downloaded: ${filename}\nSaved to: ${destResolved}\nSize: ${sizeKb} KB\nContent-Type: ${contentType}\nSource: ${targetUrl}`
  );
}
