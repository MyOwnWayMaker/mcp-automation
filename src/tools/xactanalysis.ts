import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import fs from "fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SESSION_PATH = process.env.XACTANALYSIS_SESSION_PATH || "/Users/hakielmcqueen/mcp-automation/xactanalysis_session.json";
const BASE = "https://www.xactanalysis.com/apps";

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
    "node /Users/hakielmcqueen/mcp-automation/scripts/auth-xactanalysis.mjs"
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

export async function xactGetAssignment(args: {
  mfn: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await page.goto(`${BASE}/cxa/detail.jsp?mfn=${args.mfn}&src=ip`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(5000);

    const bodyText = (await page.locator("body").innerText().catch(() => ""))
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return ok(`Assignment Detail (MFN: ${args.mfn}):\n\n${bodyText.substring(0, 4000)}`);
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

export async function xactFindAssignmentByClaim(args: {
  claim_number: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    // Load all assignments (no date restriction) and scan for the claim number
    const url = `${BASE}/xactanalysis/search.jsp?date_type=received&columns=cache`;
    await page.goto(url);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(5000);

    const links = await page.locator("a").all();
    const matches: string[] = [];

    for (const link of links) {
      const href = await link.getAttribute("href").catch(() => "");
      const text = (await link.innerText().catch(() => "")).trim();
      if (href?.includes("detail.jsp") && text) {
        const mfnMatch = href.match(/mfn=([A-Z0-9]+)/);
        const mfn = mfnMatch ? mfnMatch[1] : "";
        // Match partial or full claim number (case-insensitive)
        if (text.toLowerCase().includes(args.claim_number.toLowerCase())) {
          matches.push(`Claim #: ${text} | MFN: ${mfn} | URL: ${href}`);
        }
      }
    }

    // If not found in default window, try include_all
    if (matches.length === 0) {
      const allUrl = `${BASE}/xactanalysis/search.jsp?date_type=received&columns=cache`;
      await page.goto(allUrl);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(5000);

      const allLinks = await page.locator("a").all();
      for (const link of allLinks) {
        const href = await link.getAttribute("href").catch(() => "");
        const text = (await link.innerText().catch(() => "")).trim();
        if (href?.includes("detail.jsp") && text) {
          const mfnMatch = href.match(/mfn=([A-Z0-9]+)/);
          const mfn = mfnMatch ? mfnMatch[1] : "";
          if (text.toLowerCase().includes(args.claim_number.toLowerCase())) {
            matches.push(`Claim #: ${text} | MFN: ${mfn} | URL: ${href}`);
          }
        }
      }
    }

    if (matches.length === 0) {
      return ok(`No assignment found matching claim number "${args.claim_number}". Try xact_list_assignments with include_all=true to browse all records.`);
    }

    return ok(`Found ${matches.length} match(es) for "${args.claim_number}":\n\n${matches.join("\n---\n")}`);
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
