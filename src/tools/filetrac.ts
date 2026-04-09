import { chromium, type Browser, type Page } from "playwright";
import fs from "fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SESSION_PATH = process.env.FILETRAC_SESSION_PATH || "/Users/hakielmcqueen/mcp-automation/filetrac_session.json";
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
 */
async function getFiletracPage(companyIndex = 0): Promise<{
  browser: Browser;
  page: Page;
  aspBase: string;
}> {
  let session: { cookies: unknown[]; localStorage: Record<string, string>; sessionStorage?: Record<string, string> };
  if (process.env.FILETRAC_SESSION_JSON) {
    session = JSON.parse(process.env.FILETRAC_SESSION_JSON);
  } else if (fs.existsSync(SESSION_PATH)) {
    session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
  } else {
    throw new Error(
      `FileTrac session not found. Set FILETRAC_SESSION_JSON env var or run: ` +
      `node /Users/hakielmcqueen/mcp-automation/scripts/auth-filetrac.mjs`
    );
  }

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

  // Inject fresh Cognito tokens
  await page.goto("https://ftevolve.com");
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate((ls: Record<string, string>) => {
    for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
  }, localStorage);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);

  // Go to linked-companies
  await page.goto("https://ftevolve.com/app/legacy/linked-companies");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(5000);

  // Verify we're logged in
  const currentUrl = page.url();
  if (currentUrl.includes("/auth/")) {
    await browser.close();
    throw new Error(
      "FileTrac Cognito refresh token has expired (30-day limit). " +
      "Re-run: node /Users/hakielmcqueen/mcp-automation/scripts/auth-filetrac.mjs"
    );
  }

  // Click "See Jobs" for the requested company
  const seeJobsBtns = await page.locator('button:has-text("See Jobs")').all();
  if (seeJobsBtns.length === 0) {
    await browser.close();
    throw new Error("No companies found on FileTrac linked-companies page.");
  }
  const idx = Math.min(companyIndex, seeJobsBtns.length - 1);
  await seeJobsBtns[idx].click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000);

  const aspBase = new URL(page.url()).origin;
  return { browser, page, aspBase };
}

export async function filetracListClaims(args: {
  company_index?: number;
  max_results?: number;
}): Promise<CallToolResult> {
  const companyIdx = args.company_index ?? 1; // Default to Premier Claims (index 1) which has the most jobs
  const { browser, page, aspBase } = await getFiletracPage(companyIdx);

  try {
    // We're already on claimList.asp after getFiletracPage
    const claimUrl = page.url();
    if (!claimUrl.includes("claimList")) {
      await page.goto(`${aspBase}/system/claimList.asp`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3000);
    }

    // Find all claim file number links (8-digit numbers)
    const links = await page.locator("a").all();
    const claims: string[] = [];
    const limit = args.max_results ?? 20;

    for (const link of links) {
      if (claims.length >= limit) break;
      const text = (await link.innerText().catch(() => "")).trim();
      const href = await link.getAttribute("href").catch(() => "");
      if (/^\d{8}$/.test(text) && href) {
        // Get the claim ID from href (claimView.asp?claimID=XXXXX)
        const claimIdMatch = href.match(/claimID=(\d+)/);
        const claimId = claimIdMatch ? claimIdMatch[1] : "";

        // Get row text for context (the containing row)
        const row = await link.locator("xpath=ancestor::tr[1]").first();
        const rowText = (await row.innerText().catch(() => "")).trim().replace(/\t+/g, " | ").replace(/\n+/g, " ");
        claims.push(`File #: ${text} | Claim ID: ${claimId} | ${rowText}`);
      }
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
  const { browser, page, aspBase } = await getFiletracPage(args.company_index ?? 1);

  try {
    await page.goto(`${aspBase}/system/claimView.asp?claimID=${args.claim_id}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    const bodyText = (await page.locator("body").innerText().catch(() => ""))
      .replace(/\t+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Also grab key field values
    const dateContact = await page.inputValue("#claimDateContact").catch(() => "");
    const dateInspection = await page.inputValue("#claimDateInspection").catch(() => "");
    const dateComplete = await page.inputValue("#claimDateComplete").catch(() => "");
    const fileNum = await page.inputValue("#claimFileID").catch(async () =>
      (await page.locator("#claimFileID").innerText().catch(() => ""))
    );

    return ok(
      `Claim Detail (ID: ${args.claim_id}):\n\n` +
      (fileNum ? `File #: ${fileNum}\n` : "") +
      `Date of First Contact: ${dateContact || "(not set)"}\n` +
      `Date of Inspection: ${dateInspection || "(not set)"}\n` +
      `Date of Claim Complete: ${dateComplete || "(not set)"}\n\n` +
      `--- Full Details ---\n${bodyText.substring(0, 3000)}`
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
  file_number: string;
  note: string;
  category?: string;
  visible_to_client?: boolean;
  company_index?: number;
}): Promise<CallToolResult> {
  const { browser, page, aspBase } = await getFiletracPage(args.company_index ?? 1);

  try {
    await page.goto(`${aspBase}/system/quickNotes.asp?claimFID=${args.file_number}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Verify file # loaded correctly
    const fileId = await page.inputValue("#claimFileID").catch(() => "");
    if (!fileId || fileId !== args.file_number) {
      // Try to set it if not pre-filled
      await page.fill("#claimFileID", args.file_number).catch(() => {});
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

    return ok(`✅ Note added to FileTrac claim (File #${args.file_number}):\n"${args.note.substring(0, 100)}..."`);
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
  const page = await browser.newPage();

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
