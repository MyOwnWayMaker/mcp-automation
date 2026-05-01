import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import fs from "fs";
import path from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SESSION_PATH = process.env.XACTANALYSIS_SESSION_PATH
  ?? path.resolve(process.cwd(), "xactanalysis_session.json");
const BASE = "https://www.xactanalysis.com/apps";

// Tab name → XA's internal d_<tabid> identifier
const TAB_IDS: Record<string, string> = {
  details:       "d_assignment",     // assignment summary (current default)
  client_policy: "d_clientpolicy",
  notes:         "d_notes",
  documents:     "d_documents",
  map:           "d_map",
  action_items:  "d_actionitems",
  history:       "d_history",
};

// Workflow status codes
const STATUS_CODES: Record<string, number> = {
  customer_contacted: 5,
  site_inspected: 6,
  job_sold: 19,
  job_started: 60,
  job_not_sold: 20,
};

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fmt(date: string): string {
  // Accept YYYY-MM-DD or M/D/YYYY — return YYYY-MM-DD for XactAnalysis
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const parts = date.split("/");
  if (parts.length === 3) {
    const [m, d, y] = parts;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return date;
}

function loadSession(): { cookies: unknown[]; localStorage: Record<string, string> } {
  if (process.env.XACTANALYSIS_SESSION_JSON) {
    return JSON.parse(process.env.XACTANALYSIS_SESSION_JSON);
  }
  if (fs.existsSync(SESSION_PATH)) {
    return JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
  }
  throw new Error(
    "XactAnalysis session not found. Set XACTANALYSIS_SESSION_JSON env var or run: " +
    "node scripts/auth-xactanalysis.mjs"
  );
}

async function getPage(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const session = loadSession();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  await context.addCookies(session.cookies as Parameters<typeof context.addCookies>[0]);

  const page = await context.newPage();

  // Verify session works
  await page.goto(`${BASE}/cxa/start.jsp`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);

  if (page.url().includes("identity.verisk") || page.url().includes("/auth/")) {
    await browser.close();
    throw new Error("XactAnalysis session expired. Re-run auth-xactanalysis.mjs and update XACTANALYSIS_SESSION_JSON.");
  }

  return { browser, context, page };
}

export async function xactListAssignments(args: {
  status?: "in_progress" | "returned" | "all";
  max_results?: number;
  since_date?: string;   // YYYY-MM-DD — show assignments received on/after this date
  include_all?: boolean; // remove date window entirely (shows all time)
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    const statusType = args.status === "returned" ? "returned" :
                       args.status === "in_progress" ? "in_progress" : "";
    const statusParam = statusType ? `&xasp_status_type=${statusType}` : "";

    let url: string;
    if (args.include_all) {
      // No date restriction — returns everything in XactAnalysis
      url = `${BASE}/xactanalysis/search.jsp?date_type=received${statusParam}&columns=cache`;
    } else if (args.since_date) {
      // Explicit date range: from since_date to today
      const today = new Date().toISOString().split("T")[0];
      url = `${BASE}/xactanalysis/search.jsp?date_type=received&start_date=${args.since_date}&end_date=${today}${statusParam}&columns=cache`;
    } else {
      // Default: 2-year (730-day) sliding window
      url = `${BASE}/xactanalysis/search.jsp?date_type=received&date_preset=730${statusParam}&columns=cache`;
    }

    await page.goto(url);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(5000);

    // Collect all assignment links across pages
    const assignments: string[] = [];
    const limit = args.max_results ?? 200;
    let pageNum = 1;

    while (assignments.length < limit) {
      const pageUrl = pageNum === 1 ? url : `${url}&page=${pageNum}`;
      if (pageNum > 1) {
        await page.goto(pageUrl);
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(4000);
      }

      const links = await page.locator("a").all();
      let addedThisPage = 0;
      for (const link of links) {
        if (assignments.length >= limit) break;
        const href = await link.getAttribute("href").catch(() => "");
        const text = (await link.innerText().catch(() => "")).trim();
        if (href?.includes("detail.jsp") && text) {
          const mfnMatch = href.match(/mfn=([A-Z0-9]+)/);
          const mfn = mfnMatch ? mfnMatch[1] : "";
          const entry = `Claim #: ${text} | MFN: ${mfn} | URL: ${href}`;
          if (!assignments.includes(entry)) {
            assignments.push(entry);
            addedThisPage++;
          }
        }
      }

      // Stop paginating if no new results were found on this page
      const hasNextPage = await page.locator('a:has-text("Next"), a:has-text("next"), [rel="next"]').count() > 0;
      if (!hasNextPage || addedThisPage === 0) break;
      pageNum++;
    }

    if (assignments.length === 0) return ok("No assignments found.");

    // Table context from current page
    const tableText = (await page.locator("body").innerText().catch(() => ""))
      .split("\n")
      .filter(l => l.trim())
      .slice(0, 60)
      .join("\n");

    return ok(`XactAnalysis Assignments (${args.status ?? "in_progress"}):\n\n${assignments.join("\n---\n")}\n\n=== Full List ===\n${tableText.substring(0, 2000)}`);
  } finally {
    await browser.close();
  }
}

// ── Tab navigation helper ────────────────────────────────────────────────────
// Lands on the assignment detail page and switches to the requested tab via
// XA's gotoDetailTab() JS API. Returns the page so caller can scrape further.
async function navigateToTab(page: Page, mfn: string, tabId: string): Promise<void> {
  await page.goto(`${BASE}/cxa/detail.jsp?mfn=${mfn}&src=ip`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(4000);
  if (tabId !== "d_assignment") {
    await page.evaluate(
      ({ tab, mfn }: { tab: string; mfn: string }) =>
        (window as any).gotoDetailTab(tab, mfn, "ip", false, 0),
      { tab: tabId, mfn }
    );
    await page.waitForTimeout(4000);
  }
}

// ── CLIENT/POLICY parser ─────────────────────────────────────────────────────
// Defensive label-anchored extraction. Returns null for missing fields.
// Always includes raw_html + raw_text so callers can iterate the parser.
type Address = {
  street: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

function parseAddress(block: string): Address {
  // Tries to parse "<street>\n<street2?>\n<city>, <state> <zip>" or single-line variants.
  const cleaned = block.split("\n").map(l => l.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return { street: null, street2: null, city: null, state: null, zip: null };
  }
  // Find the line with "City, ST ZIP" — usually last
  let cszIdx = -1;
  let csz: { city: string; state: string; zip: string } | null = null;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const m = cleaned[i].match(/^(.+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
    if (m) {
      cszIdx = i;
      csz = { city: m[1].trim(), state: m[2], zip: m[3] };
      break;
    }
  }
  const streetLines = cszIdx >= 0 ? cleaned.slice(0, cszIdx) : cleaned;
  return {
    street: streetLines[0] ?? null,
    street2: streetLines[1] ?? null,
    city: csz?.city ?? null,
    state: csz?.state ?? null,
    zip: csz?.zip ?? null,
  };
}

function findValueAfterLabel(text: string, label: string | RegExp, maxChars = 200): string | null {
  const re = label instanceof RegExp
    ? label
    : new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\n]\\s*([^\\n]+)`, "i");
  const m = text.match(re);
  if (!m) return null;
  const v = (m[1] || "").trim().substring(0, maxChars);
  return v.length > 0 ? v : null;
}

function findBlockUnderLabel(text: string, label: string, lineCount = 3): string | null {
  // Find the label as a line by itself, then take the next `lineCount` non-empty lines.
  const lines = text.split("\n").map(l => l.trim());
  const idx = lines.findIndex(l => l.toLowerCase() === label.toLowerCase());
  if (idx < 0) return null;
  const block: string[] = [];
  for (let i = idx + 1; i < lines.length && block.length < lineCount; i++) {
    if (!lines[i]) continue;
    // Stop if we hit another label-like line (Title Case ending in : or known section header)
    if (/^[A-Z][a-zA-Z ]{2,30}$/.test(lines[i]) && i > idx + 1) break;
    block.push(lines[i]);
  }
  return block.length > 0 ? block.join("\n") : null;
}

function parseClientPolicy(rawText: string): {
  loss_address: Address;
  mailing_address: Address;
  insured: { name: string | null; phone: string | null; email: string | null };
  policy: { number: string | null; effective_date: string | null; expiration_date: string | null };
  coverage: { code: string | null; limit: number | null; deductible: number | null }[];
} {
  // Loss + Mailing addresses — XA renders "Loss Address" then the address block on next lines
  const lossBlock = findBlockUnderLabel(rawText, "Loss Address", 4)
    ?? findBlockUnderLabel(rawText, "Risk Address", 4)
    ?? "";
  const mailBlock = findBlockUnderLabel(rawText, "Mailing Address", 4) ?? "";

  // Insured contact
  const insuredName = findValueAfterLabel(rawText, /Insured(?:\s+Name)?/i)
    ?? findValueAfterLabel(rawText, /Policyholder/i);
  const phone = findValueAfterLabel(rawText, /(?:Insured\s+)?Phone(?:\s+Number)?/i);
  const email = findValueAfterLabel(rawText, /(?:Insured\s+)?Email/i);

  // Policy
  const policyNum = findValueAfterLabel(rawText, /Policy(?:\s+Number|\s+#|#)/i);
  const effDate = findValueAfterLabel(rawText, /Effective\s+Date/i);
  const expDate = findValueAfterLabel(rawText, /Expiration\s+Date/i);

  // Coverage — patterns like "Coverage A $250,000" or "A $250,000 / $1,000"
  const coverage: { code: string | null; limit: number | null; deductible: number | null }[] = [];
  const covRe = /Coverage\s+([A-F])\s*[:\$]?\s*\$?([\d,]+)(?:\s*\/\s*\$?([\d,]+))?/gi;
  let cm: RegExpExecArray | null;
  while ((cm = covRe.exec(rawText)) !== null) {
    coverage.push({
      code: cm[1],
      limit: cm[2] ? parseInt(cm[2].replace(/,/g, ""), 10) : null,
      deductible: cm[3] ? parseInt(cm[3].replace(/,/g, ""), 10) : null,
    });
  }

  return {
    loss_address: parseAddress(lossBlock),
    mailing_address: parseAddress(mailBlock),
    insured: {
      name: insuredName,
      phone,
      email,
    },
    policy: {
      number: policyNum,
      effective_date: effDate,
      expiration_date: expDate,
    },
    coverage,
  };
}

// ── xact_get_assignment (now tab-aware) ──────────────────────────────────────

export async function xactGetAssignment(args: {
  mfn: string;
  tab?: "details" | "client_policy" | "notes" | "documents" | "map" | "action_items" | "history";
}): Promise<CallToolResult> {
  const tabName = args.tab ?? "details";
  const tabId = TAB_IDS[tabName];
  if (!tabId) {
    return ok(`Unknown tab: ${tabName}. Valid: ${Object.keys(TAB_IDS).join(", ")}`);
  }

  const { browser, page } = await getPage();

  try {
    await navigateToTab(page, args.mfn, tabId);

    const tabContainerId = tabId; // XA convention: container has id matching the tab id

    // Pull both rendered text and HTML of the tab's container (fall back to body)
    const { rawText, rawHtml } = await page.evaluate((containerId: string) => {
      const el = document.getElementById(containerId) || document.body;
      return {
        rawText: (el as HTMLElement).innerText.replace(/\n{3,}/g, "\n\n").trim(),
        rawHtml: el.innerHTML,
      };
    }, tabContainerId);

    // Special handling for client_policy: parse into structured JSON
    if (tabName === "client_policy") {
      const parsed = parseClientPolicy(rawText);
      const result = {
        mfn: args.mfn,
        tab: "client_policy",
        ...parsed,
        raw_text: rawText.substring(0, 4000),
        raw_html: rawHtml.substring(0, 8000),
      };
      return ok(JSON.stringify(result, null, 2));
    }

    // All other tabs: return rendered text (default behavior preserved for `details`)
    return ok(
      `Assignment Detail (MFN: ${args.mfn}, tab: ${tabName}):\n\n` +
      rawText.substring(0, 4000)
    );
  } finally {
    await browser.close();
  }
}

async function updateWorkflowStatus(
  context: BrowserContext,
  page: Page,
  mfn: string,
  statusCode: number,
  date: string,       // YYYY-MM-DD
  time = "09:00:00",
  note = ""
): Promise<string> {
  // Get the CID from the detail page URL
  await page.goto(`${BASE}/cxa/detail.jsp?mfn=${mfn}&src=ip`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(5000);

  // Get the cid from the existing updateStatus call in the page
  const cidMatch = (await page.content()).match(/cid=(\d+)/);
  const cid = cidMatch ? cidMatch[1] : "";

  // Trigger the updateStatus dialog
  await page.evaluate((code: number) => (window as any).updateStatus(code), statusCode);
  await page.waitForTimeout(3000);

  // Find the dialog iframe
  const dlgFrame = page.frames().find(f => f.url().includes("dlg_updateStatus"));
  if (!dlgFrame) {
    throw new Error(`Status dialog iframe not found for updateStatus(${statusCode})`);
  }

  await dlgFrame.waitForLoadState("domcontentloaded");

  // Fill date, time, and optional note
  await dlgFrame.evaluate((params: { date: string; time: string; note: string }) => {
    const dateEl = document.getElementById("dateupdated") as HTMLInputElement;
    if (dateEl) dateEl.value = params.date;
    const timeEl = document.getElementById("timeupdated") as HTMLInputElement;
    if (timeEl) timeEl.value = params.time;
    const notesEl = document.getElementById("notes") as HTMLTextAreaElement;
    if (notesEl && params.note) notesEl.value = params.note;
  }, { date, time, note });

  // Click UPDATE STATUS
  await dlgFrame.click("#updatestatus_button");
  await page.waitForTimeout(4000);

  return `Status ${statusCode} updated to ${date}`;
}

export async function xactUpdateDates(args: {
  mfn: string;
  customer_contacted_date?: string;  // YYYY-MM-DD or M/D/YYYY
  site_inspected_date?: string;
  note?: string;
}): Promise<CallToolResult> {
  const { browser, context, page } = await getPage();

  try {
    const results: string[] = [];

    if (args.customer_contacted_date) {
      const date = fmt(args.customer_contacted_date);
      const result = await updateWorkflowStatus(context, page, args.mfn, STATUS_CODES.customer_contacted, date, "09:00:00", args.note ?? "");
      results.push(`Customer Contacted: ${date} ✅`);
    }

    if (args.site_inspected_date) {
      const date = fmt(args.site_inspected_date);
      const result = await updateWorkflowStatus(context, page, args.mfn, STATUS_CODES.site_inspected, date, "09:00:00", args.note ?? "");
      results.push(`Site Inspected: ${date} ✅`);
    }

    if (results.length === 0) return ok("No dates provided to update.");

    return ok(`XactAnalysis assignment ${args.mfn} updated:\n${results.join("\n")}`);
  } finally {
    await browser.close();
  }
}

export async function xactUpdateWorkflowStatus(args: {
  mfn: string;
  status: "customer_contacted" | "site_inspected" | "job_sold" | "job_started" | "job_not_sold";
  date: string;  // YYYY-MM-DD or M/D/YYYY
  time?: string; // HH:MM (24h), defaults to 09:00
  note?: string;
}): Promise<CallToolResult> {
  const { browser, context, page } = await getPage();

  try {
    const statusCode = STATUS_CODES[args.status];
    if (!statusCode) {
      return ok(`Unknown status: ${args.status}. Valid: ${Object.keys(STATUS_CODES).join(", ")}`);
    }

    const date = fmt(args.date);
    const time = args.time ? `${args.time}:00` : "09:00:00";

    await updateWorkflowStatus(context, page, args.mfn, statusCode, date, time, args.note ?? "");

    return ok(`✅ XactAnalysis ${args.mfn}: "${args.status}" set to ${date}`);
  } finally {
    await browser.close();
  }
}

export async function xactAddNote(args: {
  mfn: string;
  note: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await page.goto(`${BASE}/cxa/detail.jsp?mfn=${args.mfn}&src=ip`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(4000);

    // Switch to notes tab and wait for content to load
    await page.evaluate((mfn: string) => (window as any).gotoDetailTab("d_notes", mfn, "ip", false, 0), args.mfn);
    await page.waitForTimeout(5000);

    // ── Step 1: Capture notes tab structure for debugging ──────────────────────
    // Dump the #d_notes div HTML and all window note-related functions.
    // This runs on every call so we can see exactly what the UI looks like.
    const [notesHtml, noteFns, clickableInNotes] = await Promise.all([
      page.evaluate(() => {
        const el = document.getElementById("d_notes") || document.querySelector("[id*='notes']");
        return el ? el.innerHTML.substring(0, 3000) : "(#d_notes not found)";
      }).catch(() => "(eval failed)"),
      page.evaluate(() =>
        Object.keys(window as any)
          .filter(k => /note|Note/i.test(k) && typeof (window as any)[k] === "function")
          .join(", ")
      ).catch(() => ""),
      page.evaluate(() => {
        const el = document.getElementById("d_notes");
        if (!el) return "(no #d_notes)";
        return Array.from(el.querySelectorAll("a, button, input[type='button'], input[type='submit'], [onclick]"))
          .map(e => `${e.tagName} | text="${(e as HTMLElement).innerText?.substring(0,40)}" | onclick="${e.getAttribute('onclick') || ''}"`)
          .join("\n");
      }).catch(() => ""),
    ]);

    // ── Step 2: Try calling window note functions directly ─────────────────────
    // XA exposes updateStatus() for status changes — notes likely have a similar API.
    const directCallResult = await page.evaluate((noteText: string) => {
      const w = window as any;
      // Try common XA note-adding JS function names
      if (typeof w.addNote === "function") { w.addNote(noteText); return "called addNote()"; }
      if (typeof w.AddNote === "function") { w.AddNote(noteText); return "called AddNote()"; }
      if (typeof w.saveNote === "function") { w.saveNote(noteText); return "called saveNote()"; }
      if (typeof w.SaveNote === "function") { w.SaveNote(noteText); return "called SaveNote()"; }
      if (typeof w.addActionNote === "function") { w.addActionNote(noteText); return "called addActionNote()"; }
      return null;
    }, args.note).catch(() => null);

    if (directCallResult) {
      await page.waitForTimeout(3000);
      return ok(`✅ Note added to XactAnalysis assignment ${args.mfn} via ${directCallResult}:\n"${args.note.substring(0, 100)}"`);
    }

    // ── Step 3: Look for note input in the notes tab (textarea or contenteditable) ──
    await page.waitForTimeout(1000);
    const noteInputSel = [
      "#d_notes textarea",
      "#d_notes [contenteditable='true']",
      "#d_notes input[type='text']",
      "textarea",
      "[contenteditable='true']",
    ].join(", ");

    let noteInput = page.locator(noteInputSel).first();
    if (await noteInput.count() === 0) {
      // Click any button in #d_notes that might reveal the input
      const addBtnInNotes = page.locator(
        "#d_notes a, #d_notes button, #d_notes input[type='button'], " +
        'a:has-text("Add a Note"), a:has-text("Add Note"), button:has-text("Add")'
      ).first();
      if (await addBtnInNotes.count() > 0) {
        await addBtnInNotes.click();
        await page.waitForTimeout(3000);
        noteInput = page.locator(noteInputSel).first();
      }
    }

    if (await noteInput.count() > 0) {
      const tagName = await noteInput.evaluate(el => el.tagName.toLowerCase()).catch(() => "unknown");
      if (tagName === "div" || tagName === "span") {
        // contenteditable — use type() instead of fill()
        await noteInput.click();
        await noteInput.evaluate((el, text) => { (el as HTMLElement).innerText = text; }, args.note);
      } else {
        await noteInput.fill(args.note);
      }

      // Submit
      await page.locator(
        "#d_notes input[type='submit'], #d_notes button[type='submit'], " +
        "#d_notes input[value*='Save'], #d_notes input[value*='Add'], " +
        "input[type='submit'], button[type='submit']"
      ).first().click().catch(async () => {
        await page.keyboard.press("Enter").catch(() => {});
      });
      await page.waitForTimeout(3000);
      return ok(`✅ Note added to XactAnalysis assignment ${args.mfn}:\n"${args.note.substring(0, 100)}"`);
    }

    // ── Step 4: Return full debug so we can see what mechanism XA actually uses ──
    return ok(
      `Could not add note to ${args.mfn}. Debug snapshot:\n\n` +
      `=== #d_notes HTML (first 3000 chars) ===\n${notesHtml}\n\n` +
      `=== Note-related window functions ===\n${noteFns || "(none found)"}\n\n` +
      `=== Clickable elements in #d_notes ===\n${clickableInNotes}`
    );
  } finally {
    await browser.close();
  }
}

// Set the top search bar dropdown to "Claim #" or "Quick search" mode.
// getPage() lands on start.jsp which already has the search bar rendered.
async function setSearchType(page: Page, mode: "claim" | "quick"): Promise<void> {
  const typeBtn = page.locator(".quick-search-type-button").first();
  if (await typeBtn.count() === 0) return;

  const currentText = (await typeBtn.innerText().catch(() => "")).toLowerCase();
  const alreadyClaim = currentText.includes("claim");

  if ((mode === "claim" && alreadyClaim) || (mode === "quick" && !alreadyClaim)) return;

  await typeBtn.click();
  await page.waitForTimeout(800);

  const target = mode === "claim"
    ? page.locator(".xa-menu-item").filter({ hasText: /Claim #/i }).first()
    : page.locator(".xa-menu-item").filter({ hasText: /Quick search/i }).first();

  if (await target.count() > 0) {
    await target.click();
    await page.waitForTimeout(500);
  }
}


export async function xactFindAssignmentByClaim(args: {
  claim_number: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    // Switch top search bar to "Claim #" mode (searches all years, not just recent 20)
    await setSearchType(page, "claim");

    const searchInput = page.locator("#headerQSearch_input");
    await searchInput.fill(args.claim_number);
    await page.keyboard.press("Enter");

    // Claim # search shows results inline in a dropdown — no page navigation.
    // Wait for the result row to appear, then click it to reach detail.jsp.
    await page.waitForTimeout(3000);

    // Look for a clickable element containing the claim number in the search result area
    const resultRow = page.locator(`text="${args.claim_number}"`).first();
    if (await resultRow.count() > 0) {
      await Promise.all([
        page.waitForNavigation({ timeout: 15000, waitUntil: "domcontentloaded" }).catch(() => null),
        resultRow.click(),
      ]);
      await page.waitForTimeout(3000);
    }

    const currentUrl = page.url();
    const mfnMatch = currentUrl.match(/mfn=([A-Z0-9]+)/);

    if (mfnMatch) {
      const mfn = mfnMatch[1];
      const bodyText = (await page.locator("body").innerText().catch(() => ""))
        .split("\n").filter(l => l.trim()).slice(0, 25).join("\n");
      return ok(`Found assignment for claim "${args.claim_number}":\nMFN: ${mfn}\nURL: ${currentUrl}\n\n${bodyText}`);
    }

    // Fallback: scan for detail.jsp links on whatever page we ended up on
    const links = await page.locator("a[href*='detail.jsp']").all();
    if (links.length > 0) {
      const results: string[] = [];
      for (const link of links) {
        const href = await link.getAttribute("href").catch(() => "");
        const text = (await link.innerText().catch(() => "")).trim();
        const mfn = href?.match(/mfn=([A-Z0-9]+)/)?.[1] ?? "";
        results.push(`Claim #: ${text} | MFN: ${mfn}`);
      }
      return ok(`Found ${results.length} result(s) for claim "${args.claim_number}":\n\n${results.join("\n---\n")}`);
    }

    const bodySnippet = (await page.locator("body").innerText().catch(() => ""))
      .split("\n").filter(l => l.trim()).slice(0, 20).join("\n");
    return ok(`No assignment found for claim "${args.claim_number}".\nPage snapshot:\n${bodySnippet}`);
  } finally {
    await browser.close();
  }
}

export async function xactFindAssignmentByName(args: {
  name_query: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    // Switch top search bar to "Quick search" mode (searches by policyholder name)
    await setSearchType(page, "quick");

    const searchInput = page.locator("#headerQSearch_input");
    await searchInput.fill(args.name_query);

    // Quick Search navigates to search.jsp — wait for that full page load
    await Promise.all([
      page.waitForNavigation({ timeout: 15000, waitUntil: "domcontentloaded" }).catch(() => null),
      page.keyboard.press("Enter"),
    ]);
    await page.waitForTimeout(3000);

    const currentUrl = page.url();

    // Direct match to detail page
    if (currentUrl.includes("detail.jsp")) {
      const mfnMatch = currentUrl.match(/mfn=([A-Z0-9]+)/);
      const mfn = mfnMatch ? mfnMatch[1] : "unknown";
      const bodyText = (await page.locator("body").innerText().catch(() => ""))
        .split("\n").filter(l => l.trim()).slice(0, 25).join("\n");
      return ok(`Direct match for "${args.name_query}":\nMFN: ${mfn}\n\n${bodyText}`);
    }

    // Results list page
    const links = await page.locator("a[href*='detail.jsp']").all();
    if (links.length === 0) {
      const bodySnippet = (await page.locator("body").innerText().catch(() => ""))
        .split("\n").filter(l => l.trim()).slice(0, 20).join("\n");
      return ok(`No assignments found for name "${args.name_query}".\nPage snapshot:\n${bodySnippet}`);
    }

    const results: string[] = [];
    for (const link of links) {
      const href = await link.getAttribute("href").catch(() => "");
      const text = (await link.innerText().catch(() => "")).trim();
      const mfn = href?.match(/mfn=([A-Z0-9]+)/)?.[1] ?? "";
      results.push(`Claim #: ${text} | MFN: ${mfn}`);
    }
    return ok(`Found ${results.length} candidate(s) for "${args.name_query}":\n\n${results.join("\n---\n")}`);
  } finally {
    await browser.close();
  }
}

export async function xactGetNotes(args: {
  mfn: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await page.goto(`${BASE}/cxa/detail.jsp?mfn=${args.mfn}&src=ip`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(4000);

    await page.evaluate((mfn: string) => (window as any).gotoDetailTab("d_notes", mfn, "ip", false, 0), args.mfn);
    await page.waitForTimeout(4000);

    const bodyText = (await page.locator("body").innerText().catch(() => ""))
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const notesIdx = bodyText.indexOf("Add a Note");
    const notesSection = notesIdx >= 0 ? bodyText.slice(notesIdx) : bodyText;
    return ok(`Notes for assignment ${args.mfn}:\n\n${notesSection.substring(0, 3000)}`);
  } finally {
    await browser.close();
  }
}

// ── xact_delete_note ─────────────────────────────────────────────────────────
// Best-effort: tries multiple strategies to identify and remove a note.
// Pass either note_id (XA's internal note ID) or note_text_match (substring of
// the note body — first matching note will be deleted).
export async function xactDeleteNote(args: {
  mfn: string;
  note_id?: string;
  note_text_match?: string;
}): Promise<CallToolResult> {
  if (!args.note_id && !args.note_text_match) {
    return ok("Provide either note_id or note_text_match.");
  }

  const { browser, page } = await getPage();

  try {
    await navigateToTab(page, args.mfn, "d_notes");

    // Try direct JS function first (XA pattern: deleteNote, removeNote, etc.)
    if (args.note_id) {
      const direct = await page.evaluate((id: string) => {
        const w = window as any;
        if (typeof w.deleteNote === "function") { w.deleteNote(id); return "deleteNote"; }
        if (typeof w.DeleteNote === "function") { w.DeleteNote(id); return "DeleteNote"; }
        if (typeof w.removeNote === "function") { w.removeNote(id); return "removeNote"; }
        return null;
      }, args.note_id).catch(() => null);

      if (direct) {
        await page.waitForTimeout(2000);
        // Confirm any modal that appeared
        await page.locator('button:has-text("OK"), button:has-text("Yes"), button:has-text("Delete"), input[value="OK"], input[value="Yes"], input[value="Delete"]').first().click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(2000);
        return ok(`✅ Note ${args.note_id} deleted via ${direct}() on ${args.mfn}`);
      }
    }

    // Find note rows and identify the target one
    const noteSnapshot = await page.evaluate(({ id, match }: { id?: string; match?: string }) => {
      const container = document.getElementById("d_notes") || document.body;
      const rows = Array.from(container.querySelectorAll("tr, li, div"))
        .filter(el => {
          const txt = (el as HTMLElement).innerText || "";
          if (txt.length < 20 || txt.length > 2000) return false;
          if (id && el.outerHTML.includes(id)) return true;
          if (match && txt.toLowerCase().includes(match.toLowerCase())) return true;
          return false;
        });
      return rows.slice(0, 5).map(r => ({
        tag: r.tagName,
        text: (r as HTMLElement).innerText.substring(0, 200),
        html: r.outerHTML.substring(0, 800),
      }));
    }, { id: args.note_id, match: args.note_text_match });

    if (noteSnapshot.length === 0) {
      return ok(`Note not found on ${args.mfn} (no row matched id=${args.note_id} or text="${args.note_text_match}").`);
    }

    // Click any delete control inside the matched row
    const deleteBtn = page.locator(
      `#d_notes tr:has-text("${args.note_text_match || args.note_id}") :is(a, button, [onclick*="elete"]):is(:has-text("Delete"), [title*="Delete"], [aria-label*="Delete"], [onclick*="elete"])`
    ).first();

    if (await deleteBtn.count() > 0) {
      await deleteBtn.click();
      await page.waitForTimeout(2000);
      await page.locator('button:has-text("OK"), button:has-text("Yes"), button:has-text("Delete"), input[value="OK"], input[value="Yes"]').first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(2000);
      return ok(`✅ Note deleted from ${args.mfn} (matched: "${(args.note_text_match || args.note_id || "").substring(0, 60)}")`);
    }

    return ok(
      `Could not delete note on ${args.mfn} — found ${noteSnapshot.length} matching row(s) but no delete control inside. Debug:\n\n` +
      noteSnapshot.map((r, i) => `[${i}] ${r.tag}: ${r.text}\nHTML: ${r.html}`).join("\n\n---\n\n")
    );
  } finally {
    await browser.close();
  }
}

// ── xact_set_planned_inspection_date ─────────────────────────────────────────
// Best-effort: locate the Planned Inspection Date field and set it.
// Field has its own UI element separate from updateStatus().
export async function xactSetPlannedInspectionDate(args: {
  mfn: string;
  date: string; // YYYY-MM-DD or M/D/YYYY
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();
  const date = fmt(args.date);

  try {
    await navigateToTab(page, args.mfn, "d_assignment");

    // Try a JS API first (XA often exposes setX functions)
    const direct = await page.evaluate(({ d }: { d: string }) => {
      const w = window as any;
      if (typeof w.setPlannedInspectionDate === "function") { w.setPlannedInspectionDate(d); return "setPlannedInspectionDate"; }
      if (typeof w.updatePlannedInspection === "function") { w.updatePlannedInspection(d); return "updatePlannedInspection"; }
      return null;
    }, { d: date }).catch(() => null);

    if (direct) {
      await page.waitForTimeout(3000);
      return ok(`✅ Planned Inspection Date set to ${date} on ${args.mfn} via ${direct}()`);
    }

    // Find the field by label proximity. XA forms typically have a <label>/<td>
    // with "Planned Inspection Date" text and a sibling input.
    const fieldInfo = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll("label, td, th, span, div"))
        .filter(el => /planned\s+inspection\s+date/i.test((el as HTMLElement).innerText || ""));
      if (labels.length === 0) return { found: false, candidates: 0, hint: "" };

      // Look for the closest input/date field
      for (const lbl of labels) {
        const parent = lbl.closest("tr, div, td") || lbl.parentElement;
        if (!parent) continue;
        const input = parent.querySelector(
          "input[type='date'], input[type='text'], input[name*='date' i], input[id*='date' i]"
        ) as HTMLInputElement | null;
        if (input) {
          return {
            found: true,
            id: input.id || "",
            name: input.name || "",
            current_value: input.value || "",
            candidates: labels.length,
            hint: "",
          };
        }
      }
      return { found: false, candidates: labels.length, hint: "label exists but no input nearby" };
    });

    if (!fieldInfo.found) {
      return ok(
        `Could not locate Planned Inspection Date input on ${args.mfn}.\n` +
        `Found ${fieldInfo.candidates} label match(es). Hint: ${fieldInfo.hint}\n` +
        `May need to navigate to a different tab — try the Workflow or Schedule view if XA exposes one.`
      );
    }

    // Fill via the located input. Use both id and name fallbacks.
    const setValue = await page.evaluate(({ id, name, value }: { id?: string; name?: string; value: string }) => {
      const input = (id ? document.getElementById(id) :
                    name ? document.querySelector(`[name="${name}"]`) :
                    null) as HTMLInputElement | null;
      if (!input) return { ok: false, before: null, after: null };
      const before = input.value;
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: true, before, after: input.value };
    }, { id: fieldInfo.id, name: fieldInfo.name, value: date });

    if (!setValue.ok) {
      return ok(`Found field but could not set value on ${args.mfn}.`);
    }

    // Look for a save/submit button on the same form
    await page.waitForTimeout(1000);
    const saveBtn = page.locator(
      'input[value*="Save" i], button:has-text("Save"), input[value*="Submit" i], button:has-text("Submit"), input[value*="Update" i]'
    ).first();
    if (await saveBtn.count() > 0) {
      await saveBtn.click().catch(() => {});
      await page.waitForTimeout(3000);
    }

    return ok(
      `✅ Planned Inspection Date set on ${args.mfn}: ${setValue.before || "(empty)"} → ${date}\n` +
      `Field: id=${fieldInfo.id} name=${fieldInfo.name}\n` +
      `${(await saveBtn.count()) > 0 ? "Save button clicked." : "⚠️  No save button found — change may not have persisted. Verify in XA."}`
    );
  } finally {
    await browser.close();
  }
}
