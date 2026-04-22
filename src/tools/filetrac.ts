import { chromium, type Browser, type Page } from "playwright";
import fs from "fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SESSION_PATH = process.env.FILETRAC_SESSION_PATH || "/Users/hakielmcqueen/mcp-automation/filetrac_session.json";

// ─── ASP Cookie Cache ──────────────────────────────────────────────────────────
// After the first browser flow, we save the ASP session cookie so subsequent
// calls can skip the browser entirely and use a direct HTTP fetch (~1s vs 30s).

interface FiletracSession {
  cookies: unknown[];
  localStorage: Record<string, string>;
  sessionStorage?: Record<string, string>;
  aspBase?: string;
  aspCookies?: string;  // raw Cookie header string (e.g. "ASPSESSIONIDXXXX=YYYY")
  aspCookiesSavedAt?: string;
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

function saveAspToSession(aspBase: string, aspCookies: string): void {
  // Only save to local file — Railway env var is updated separately
  if (!fs.existsSync(SESSION_PATH)) return;
  try {
    const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
    session.aspBase = aspBase;
    session.aspCookies = aspCookies;
    session.aspCookiesSavedAt = new Date().toISOString();
    fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
  } catch { /* non-fatal */ }
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
  const mA = html.match(new RegExp(`(?:id|name)=["']?${id}["']?[^>]*value=["']([^"']+)["']`, "i"));
  if (mA?.[1]) return mA[1];

  // Pattern B: value BEFORE id/name  (<input value="Y" ... id="X">) — common in ASP
  const mB = html.match(new RegExp(`<[a-z]+[^>]+value=["']([^"']+)["'][^>]*(?:id|name)=["']?${id}["']`, "i"));
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

  // Save ASP cookies for future fast-path requests
  const cookies = await page.context().cookies();
  const aspCookies = cookies
    .filter(c => c.domain.includes(new URL(aspBase).hostname))
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
  if (aspCookies) saveAspToSession(aspBase, aspCookies);

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

    // Accept rows with 2+ cells (date + text is enough)
    if (cells.length >= 2) {
      // Skip rows that look like form scaffolding (all short labels)
      const hasSubstance = cells.some(c => c.length > 10);
      if (hasSubstance) rows.push(cells.join(" | "));
    }
  }

  if (rows.length === 0) {
    // Return raw body text so the caller can see what's actually on the page
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
 * Returns true if the HTML is a notes-related page (either creation form OR list).
 * Used to reject completely wrong pages (login, 404, etc).
 */
function looksLikeNotesPage(html: string): boolean {
  return html.includes("msgDate") || html.includes("msgText") || html.includes("msgCatID") ||
         html.includes("msgNoteID") || html.includes("quickNotes") ||
         html.includes("Diary") || html.includes("diary") ||
         (html.includes("Note") && /<td/i.test(html));
}

/** Returns true if the parsed result actually contains note rows (not just form scaffolding). */
function hasNoteContent(parsed: string): boolean {
  return !parsed.startsWith("(table-parse-failed)");
}

export async function filetracGetNotes(args: {
  claim_id: string;
  company_index?: number;
}): Promise<CallToolResult> {
  const session = loadSession();
  const diag: string[] = [`[filetracGetNotes] claim_id=${args.claim_id}`];

  // ── Step 1: Get file number via fast-path ASP fetch ──────────────────────────
  let fileNum = "";
  if (session.aspBase && session.aspCookies) {
    const claimHtml = await fetchAspPage(session.aspBase, session.aspCookies,
      `/system/claimView.asp?claimID=${args.claim_id}`);
    if (claimHtml) {
      fileNum = extractFileNumber(claimHtml);
      diag.push(`Fast-path claimView ${claimHtml.length}chars → fileNum="${fileNum}"`);
    } else {
      diag.push("Fast-path claimView returned null — cookie expired");
    }
  }

  // ── Step 2: Try all known notes URL patterns via fast-path ────────────────────
  if (fileNum && session.aspBase && session.aspCookies) {
    const urlsToTry = [
      `/system/quickNotesList.asp?claimFID=${fileNum}`,
      `/system/quickNotes.asp?claimFID=${fileNum}`,
      `/system/claimDiary.asp?claimFID=${fileNum}`,
      `/system/msgView.asp?claimFID=${fileNum}`,
      `/system/claimNotes.asp?claimFID=${fileNum}`,
      `/system/claimMsg.asp?claimFID=${fileNum}`,
    ];

    for (const url of urlsToTry) {
      const html = await fetchAspPage(session.aspBase, session.aspCookies, url);
      diag.push(`${url} → ${html ? `${html.length}chars` : "null/rejected"}`);

      if (html && looksLikeNotesPage(html)) {
        const result = parseNotes(html, args.claim_id);
        if (hasNoteContent(result)) {
          return ok(result);
        }
        // Parse returned body text fallback — keep going to try next URL
        diag.push(`parseNotes found no rows at ${url} — trying next pattern`);
        // If this is quickNotes.asp (most likely real page), return body text with debug
        if (url.includes("quickNotes.asp")) {
          return ok(
            `Notes page reached (${url}) but table parser found no rows.\n` +
            `Diag: ${diag.join(" | ")}\n\n` +
            `=== Raw page body (first 5000 chars) ===\n` +
            result  // already contains body text from parseNotes fallback
          );
        }
      }
    }
    diag.push("All fast-path URL patterns exhausted");
  }

  // ── Step 3: Browser path — also try claimID-based URLs ───────────────────────
  const { browser, page, aspBase } = await getFiletracPage(args.company_index ?? 1);
  try {
    await page.goto(`${aspBase}/system/claimView.asp?claimID=${args.claim_id}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait up to 8s for #claimFileID to be JS-populated
    const browserFileNum = await page.waitForFunction(() => {
      const el = document.getElementById("claimFileID") as HTMLInputElement | null;
      return el?.value && el.value.trim().length > 0 ? el.value.trim() : null;
    }, { timeout: 8000 }).then(h => h.jsonValue()).catch(async () => {
      const html = await page.content();
      return extractFileNumber(html) || null;
    });

    diag.push(`Browser claimView #claimFileID → "${browserFileNum}"`);
    const fn = (browserFileNum as string | null) || fileNum;

    // Try URL patterns in browser (handles JS-gated pages)
    const browserUrls = fn
      ? [
          `${aspBase}/system/quickNotesList.asp?claimFID=${fn}`,
          `${aspBase}/system/quickNotes.asp?claimFID=${fn}`,
          `${aspBase}/system/msgView.asp?claimFID=${fn}`,
          `${aspBase}/system/claimDiary.asp?claimID=${args.claim_id}`,
          `${aspBase}/system/msgView.asp?claimID=${args.claim_id}`,
        ]
      : [
          `${aspBase}/system/claimDiary.asp?claimID=${args.claim_id}`,
          `${aspBase}/system/msgView.asp?claimID=${args.claim_id}`,
        ];

    for (const url of browserUrls) {
      await page.goto(url);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);

      const html = await page.content();
      diag.push(`Browser ${url} → ${html.length}chars`);

      if (looksLikeNotesPage(html)) {
        const result = parseNotes(html, args.claim_id);
        if (hasNoteContent(result)) return ok(result);

        // Return with raw body + full debug so we can see exact HTML structure
        const bodyText = await page.locator("body").innerText().catch(() => "");
        return ok(
          `Notes page reached but no parseable rows found.\n` +
          `URL: ${url}\nDiag: ${diag.join(" | ")}\n\n` +
          `=== Body text (first 4000 chars) ===\n` +
          bodyText.replace(/\s{3,}/g, "\n").trim().substring(0, 4000)
        );
      }
    }

    return ok(
      `Could not locate notes for claim ${args.claim_id} (file #${fn || "unknown"}).\n` +
      `Diag: ${diag.join(" | ")}`
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
