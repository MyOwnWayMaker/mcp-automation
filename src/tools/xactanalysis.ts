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
  if (!block) return { street: null, street2: null, city: null, state: null, zip: null };
  const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { street: null, street2: null, city: null, state: null, zip: null };
  }

  // Single-line full: "<street>, <city>, <state> <zip> [country]". Two commas required.
  // city captured as [^,]+ so the regex can't merge street+city when both are present.
  const fullSingle = (line: string) =>
    line.match(/^(.+),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:\s+[A-Z]{2,3})?\s*$/);
  // CSZ-only: "<city>, <state> <zip> [country]". One comma.
  const cszOnly = (line: string) =>
    line.match(/^([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:\s+[A-Z]{2,3})?\s*$/);

  if (lines.length === 1) {
    const m = fullSingle(lines[0]);
    if (m) return { street: m[1].trim(), street2: null, city: m[2].trim(), state: m[3], zip: m[4] };
    const c = cszOnly(lines[0]);
    if (c) return { street: null, street2: null, city: c[1].trim(), state: c[2], zip: c[3] };
    return { street: lines[0], street2: null, city: null, state: null, zip: null };
  }

  // Multi-line: scan from the bottom for the CSZ line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const c = cszOnly(lines[i]);
    if (c) {
      return {
        street: lines[0] ?? null,
        street2: i > 1 ? lines[1] : null,
        city: c[1].trim(),
        state: c[2],
        zip: c[3],
      };
    }
  }

  // Last resort: collapse to one line and try the full single-line pattern.
  const m = fullSingle(lines.join(" "));
  if (m) return { street: m[1].trim(), street2: null, city: m[2].trim(), state: m[3], zip: m[4] };

  return { street: lines[0], street2: lines[1] ?? null, city: null, state: null, zip: null };
}

// Match a label appearing alone on its own line ("Address", "Address:") OR
// inline with a colon ("Address: 4470 Main"). Returns the value on the same
// line (after the colon) or the next non-empty line. Accepts a list of label
// variants — first match wins.
function findValueAfterLabel(text: string, labels: string | string[], maxChars = 200): string | null {
  const labelArr = Array.isArray(labels) ? labels : [labels];
  const lines = text.split("\n").map(l => l.trim());

  for (const label of labelArr) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const standaloneRe = new RegExp(`^${escaped}\\s*:?\\s*$`, "i");
    const inlineRe = new RegExp(`^${escaped}\\s*:\\s*(.+)$`, "i");

    for (let i = 0; i < lines.length; i++) {
      const inline = lines[i].match(inlineRe);
      if (inline && inline[1].trim()) {
        return inline[1].trim().substring(0, maxChars);
      }
      if (standaloneRe.test(lines[i])) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]) return lines[j].substring(0, maxChars);
        }
      }
    }
  }
  return null;
}

// Same flexible matching but collects multi-line blocks (addresses).
function findBlockUnderLabel(text: string, labels: string | string[], lineCount = 4): string | null {
  const labelArr = Array.isArray(labels) ? labels : [labels];
  const lines = text.split("\n").map(l => l.trim());
  const labelLineRe = /^[A-Z][a-zA-Z #/]{2,30}\s*:?$/;

  for (const label of labelArr) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const standaloneRe = new RegExp(`^${escaped}\\s*:?\\s*$`, "i");
    const inlineRe = new RegExp(`^${escaped}\\s*:\\s*(.+)$`, "i");

    for (let i = 0; i < lines.length; i++) {
      const block: string[] = [];
      const inline = lines[i].match(inlineRe);
      if (inline && inline[1].trim()) {
        block.push(inline[1].trim());
      } else if (!standaloneRe.test(lines[i])) {
        continue;
      }

      for (let j = i + 1; j < lines.length && block.length < lineCount; j++) {
        if (!lines[j]) continue;
        if (block.length > 0 && labelLineRe.test(lines[j])) break;
        block.push(lines[j]);
      }

      if (block.length > 0) return block.join("\n");
    }
  }
  return null;
}

type CoverageRow = {
  name: string | null;
  type: string | null;
  policy_limit: number | null;
  deductible: number | null;
  apply_to: string | null;
  itv: number | null;
  reserve: number | null;
};

function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/[$,]/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function parsePercent(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/%/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function parseClientPolicy(rawText: string): {
  loss_address: Address;
  mailing_address: Address;
  insured: { name: string | null; phone: string | null; email: string | null };
  policy: { number: string | null; effective_date: string | null; expiration_date: string | null };
} {
  // Loss address — XA labels it "Risk Location"
  const lossBlock = findBlockUnderLabel(rawText, ["Risk Location", "Loss Address", "Risk Address", "Loss Location"], 4) ?? "";
  // Mailing — "Mailing Address" if present, else plain "Address" (insured's address)
  const mailBlock = findBlockUnderLabel(rawText, ["Mailing Address", "Address"], 4) ?? "";

  // Insured contact
  const insuredName = findValueAfterLabel(rawText, ["Insured Name", "Policyholder Name", "Policyholder", "Insured"]);
  const phoneRaw = findValueAfterLabel(rawText, ["Mobile Phone", "Phone Number", "Home Phone", "Work Phone", "Insured Phone", "Phone"]);
  // Strip XA's " - Primary" / " - Mobile" suffix on phone display
  const phone = phoneRaw ? phoneRaw.replace(/\s*-\s*(Primary|Mobile|Home|Work|Cell)\b.*$/i, "").trim() || phoneRaw : null;
  const email = findValueAfterLabel(rawText, ["Email Address", "Insured Email", "Email"]);

  // Policy
  const policyNum = findValueAfterLabel(rawText, ["Policy Number", "Policy #", "Policy No"]);
  const effDate = findValueAfterLabel(rawText, ["Effective Date", "Policy Effective Date", "Policy Effective"]);
  const expDate = findValueAfterLabel(rawText, ["Expiration Date", "Policy Expiration Date", "Policy Expiration"]);

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

    // Pull text + HTML, and (when present) extract the coverage table from the DOM
    // so we don't lose column alignment in innerText.
    const { rawText, rawHtml, coverageRaw } = await page.evaluate((containerId: string) => {
      const el = document.getElementById(containerId) || document.body;
      const rawText = (el as HTMLElement).innerText.replace(/\n{3,}/g, "\n\n").trim();
      const rawHtml = el.innerHTML;

      type Row = {
        name: string | null; type: string | null; policy_limit: string | null;
        deductible: string | null; apply_to: string | null; itv: string | null; reserve: string | null;
      };
      let coverageRaw: Row[] = [];

      const tables = Array.from(el.querySelectorAll("table"));
      for (const tbl of tables) {
        let headers: string[] = [];
        const theadCells = Array.from(tbl.querySelectorAll("thead th, thead td"));
        if (theadCells.length > 0) {
          headers = theadCells.map(h => (h as HTMLElement).innerText.trim().toLowerCase());
        } else {
          const allRows = Array.from(tbl.querySelectorAll("tr"));
          const thRow = allRows.find(tr => tr.querySelector("th"));
          if (thRow) {
            headers = Array.from(thRow.querySelectorAll("th"))
              .map(h => (h as HTMLElement).innerText.trim().toLowerCase());
          } else if (allRows[0]) {
            headers = Array.from(allRows[0].querySelectorAll("td"))
              .map(h => (h as HTMLElement).innerText.trim().toLowerCase());
          }
        }
        if (!headers.includes("coverage")) continue;
        if (!headers.some(h => /policy.*limit|^limit$/.test(h))) continue;

        const findIdx = (...keys: string[]) => {
          for (const k of keys) {
            const idx = headers.findIndex(h => h === k || h.includes(k));
            if (idx >= 0) return idx;
          }
          return -1;
        };
        const colName = findIdx("coverage");
        const colType = findIdx("type");
        const colLimit = findIdx("policy limit", "limit");
        const colDed = findIdx("deductible");
        const colApply = findIdx("apply to", "apply");
        const colITV = findIdx("itv");
        const colReserve = findIdx("reserve");

        const allRows = Array.from(tbl.querySelectorAll("tr"));
        const rows: Row[] = [];
        for (const tr of allRows) {
          if (tr.querySelector("th")) continue;     // skip header rows
          const cells = Array.from(tr.querySelectorAll("td"));
          if (cells.length < 2) continue;
          const v = (idx: number): string | null =>
            (idx >= 0 && idx < cells.length) ? (cells[idx] as HTMLElement).innerText.trim() : null;
          rows.push({
            name: v(colName),
            type: v(colType),
            policy_limit: v(colLimit),
            deductible: v(colDed),
            apply_to: v(colApply),
            itv: v(colITV),
            reserve: v(colReserve),
          });
        }
        if (rows.length > 0) {
          coverageRaw = rows;
          break;
        }
      }

      return { rawText, rawHtml, coverageRaw };
    }, tabContainerId);

    // Special handling for client_policy: parse into structured JSON
    if (tabName === "client_policy") {
      const parsed = parseClientPolicy(rawText);
      const coverage: CoverageRow[] = coverageRaw.map(c => ({
        name: c.name || null,
        type: c.type || null,
        policy_limit: parseMoney(c.policy_limit),
        deductible: parseMoney(c.deductible),
        apply_to: c.apply_to || null,
        itv: parsePercent(c.itv),
        reserve: parseMoney(c.reserve),
      }));
      const result = {
        mfn: args.mfn,
        tab: "client_policy",
        ...parsed,
        coverage,
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
  await page.goto(`${BASE}/cxa/detail.jsp?mfn=${mfn}&src=ip`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(5000);

  // Trigger the updateStatus dialog
  await page.evaluate((code: number) => (window as any).updateStatus(code), statusCode);
  await page.waitForTimeout(3000);

  const dlgFrame = page.frames().find(f => f.url().includes("dlg_updateStatus"));
  if (!dlgFrame) {
    throw new Error(`Status dialog iframe not found for updateStatus(${statusCode})`);
  }
  await dlgFrame.waitForLoadState("domcontentloaded");

  // Fingerprint #dateupdated BEFORE writing — needed for diagnostics if the
  // override doesn't stick (Vue/MDL/datepicker overlays may ignore writes).
  const fingerprint = await dlgFrame.evaluate(() => {
    const el = document.getElementById("dateupdated") as HTMLInputElement | null;
    if (!el) return null;
    const w = window as any;
    return {
      id: el.id,
      name: el.name,
      type: el.type,
      tagName: el.tagName,
      className: el.className,
      readonly: el.readOnly,
      autocomplete: el.autocomplete,
      prefilled_value: el.value,
      outer_html: el.outerHTML.substring(0, 600),
      framework_markers: {
        has_vue_app: !!(el as any).__vue_app__,
        has_vue_parent: !!(el as any).__vueParentComponent,
        has_vue_global: typeof w.Vue !== "undefined",
        has_react_props: !!(el as any).__reactProps$,
        is_mdl: el.classList.toString().includes("mdl"),
      },
      sibling_overlay_html: (() => {
        // Datepicker libraries often render a sibling element (calendar overlay,
        // hidden field with the canonical value, etc.) — capture the parent's HTML
        // so we can see what's actually in play.
        const parent = el.parentElement;
        return parent ? parent.outerHTML.substring(0, 1000) : "";
      })(),
    };
  });

  // Three write strategies, with a readback gate after each. We only proceed to
  // submit if dateupdated actually equals our target — otherwise the dialog
  // commits its prefilled "now" value, which corrupts XA. If all strategies
  // fail, navigate away to safely close the dialog without saving.
  type WriteResult = { strategy: string; date_after: string | null; time_after: string | null };
  const results: WriteResult[] = [];

  const readback = async (): Promise<{ date: string | null; time: string | null }> =>
    await dlgFrame.evaluate(() => {
      const d = document.getElementById("dateupdated") as HTMLInputElement | null;
      const t = document.getElementById("timeupdated") as HTMLInputElement | null;
      return { date: d?.value ?? null, time: t?.value ?? null };
    });

  // Strategy A: native setter on HTMLInputElement.prototype + input/change/blur
  await dlgFrame.evaluate((params: { date: string; time: string; note: string }) => {
    const setVal = (id: string, value: string) => {
      const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) return;
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else (el as any).value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    };
    setVal("dateupdated", params.date);
    setVal("timeupdated", params.time);
    if (params.note) setVal("notes", params.note);
  }, { date, time, note });
  let r = await readback();
  results.push({ strategy: "native_setter+events", date_after: r.date, time_after: r.time });

  // Strategy B: Playwright fill (real keyboard events, more realistic)
  if (r.date !== date) {
    try {
      await dlgFrame.locator("#dateupdated").fill(date);
      await dlgFrame.locator("#timeupdated").fill(time).catch(() => {});
      r = await readback();
      results.push({ strategy: "playwright_fill", date_after: r.date, time_after: r.time });
    } catch (e: any) {
      results.push({ strategy: "playwright_fill", date_after: `error: ${e?.message ?? e}`, time_after: null });
    }
  }

  // Strategy C: focus → clear → type character-by-character
  if (r.date !== date) {
    try {
      await dlgFrame.focus("#dateupdated");
      await dlgFrame.evaluate(() => {
        const el = document.getElementById("dateupdated") as HTMLInputElement | null;
        if (!el) return;
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, "");
        else el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await dlgFrame.locator("#dateupdated").pressSequentially(date, { delay: 30 });
      r = await readback();
      results.push({ strategy: "focus+clear+pressSequentially", date_after: r.date, time_after: r.time });
    } catch (e: any) {
      results.push({ strategy: "focus+clear+pressSequentially", date_after: `error: ${e?.message ?? e}`, time_after: null });
    }
  }

  // GATE: only submit if date stuck. Otherwise navigate away to dismiss the
  // dialog cleanly (no save fires) and throw with the diagnostic snapshot.
  if (r.date !== date) {
    await page.goto(`${BASE}/cxa/detail.jsp?mfn=${mfn}&src=ip`).catch(() => {});
    await page.waitForTimeout(1500);

    const debug = {
      target_date: date,
      target_time: time,
      status_code: statusCode,
      input_fingerprint: fingerprint,
      attempts: results,
      reason: "dateupdated input value did not stick after three write strategies; dialog dismissed without save to prevent corruption",
    };
    const err: any = new Error(`updateStatus(${statusCode}): date input rejected override (${date}). All three write strategies failed.`);
    err.debug = debug;
    throw err;
  }

  // Date stuck — safe to submit
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
// XA's Planned Inspection Date field is gated by an edit affordance — the
// static row shows the value but you can't write to it. Clicking the edit
// icon (Material Icons "edit" or class~="edit") opens a popover with the real
// input. We then fire native + framework-friendly events and verify by
// re-reading the assignment.

function dateMatchesAny(rendered: string, isoDate: string): boolean {
  if (!rendered) return false;
  const [y, m, d] = isoDate.split("-").map(Number);
  const candidates = [
    `${m}/${d}/${y}`,
    `${m.toString().padStart(2, "0")}/${d.toString().padStart(2, "0")}/${y}`,
    isoDate,
    `${m}/${d}/${y.toString().slice(-2)}`,
    `${m.toString().padStart(2, "0")}/${d.toString().padStart(2, "0")}/${y.toString().slice(-2)}`,
  ];
  return candidates.some(c => rendered.includes(c));
}

async function readPlannedDate(page: Page, mfn: string): Promise<string> {
  await navigateToTab(page, mfn, "d_assignment");
  return await page.evaluate(() => {
    // Read from the editable workflow row only — body text also contains the
    // status-timeline entry which records the moment of update ("May 1, 2026
    // 10:35:53 AM"), so reading from there gave us the submission timestamp,
    // not the planned date persisted in the row's value cell.
    const labelRe = /^\s*planned\s+inspection\s+date\s*:?\s*$/i;
    const trs = Array.from(document.querySelectorAll("tr"));
    for (const tr of trs) {
      const first = tr.children[0] as HTMLElement | undefined;
      if (!first || !labelRe.test((first.innerText || "").trim())) continue;
      for (let i = 1; i < tr.children.length; i++) {
        const txt = ((tr.children[i] as HTMLElement).innerText || "").trim();
        if (txt) return txt;
      }
      return "";
    }
    return "";
  });
}

export async function xactSetPlannedInspectionDate(args: {
  mfn: string;
  date: string; // YYYY-MM-DD or M/D/YYYY
}): Promise<CallToolResult> {
  const dateIso = fmt(args.date);
  const { browser, context, page } = await getPage();

  try {
    // The Planned Inspection Date row's edit affordance is a button whose onclick
    // calls window.updateStatus(N). N is the workflow status code (68 in the
    // shipped XA build, but we extract it dynamically in case it ever changes).
    // Calling updateStatus(N) directly opens the same iframe dialog as every
    // other workflow status update, which is what updateWorkflowStatus already
    // knows how to fill + submit.
    await navigateToTab(page, args.mfn, "d_assignment");
    const found = await page.evaluate(() => {
      const labelRe = /^\s*planned\s+inspection\s+date\s*:?\s*$/i;
      const trs = Array.from(document.querySelectorAll("tr"));
      for (const tr of trs) {
        const first = tr.children[0] as HTMLElement | undefined;
        if (!first || !labelRe.test((first.innerText || "").trim())) continue;
        const btn = tr.querySelector('button[onclick*="updateStatus"], a[onclick*="updateStatus"]');
        if (!btn) continue;
        const m = (btn.getAttribute("onclick") || "").match(/updateStatus\s*\(\s*(\d+)/);
        if (m) {
          return {
            code: parseInt(m[1], 10),
            row_html: (tr as HTMLElement).outerHTML.substring(0, 2000),
          };
        }
      }
      return null;
    });

    if (!found) {
      return ok(JSON.stringify({
        ok: false,
        error: "Could not locate the Planned Inspection Date row with an updateStatus(N) button",
      }, null, 2));
    }

    let updateError: string | null = null;
    let updateDebug: any = null;
    try {
      await updateWorkflowStatus(context, page, args.mfn, found.code, dateIso, "09:00:00", "");
    } catch (e: any) {
      updateError = String(e?.message || e);
      updateDebug = e?.debug ?? null;
    }

    const verified = await readPlannedDate(page, args.mfn);
    const success = !updateError && dateMatchesAny(verified, dateIso);

    if (success) {
      return ok(JSON.stringify({
        ok: true,
        value: verified,
        method: `updateStatus(${found.code}) iframe dialog`,
      }, null, 2));
    }

    return ok(JSON.stringify({
      ok: false,
      value_read: verified || "(empty)",
      target_iso: dateIso,
      extracted_workflow_code: found.code,
      update_error: updateError,
      // When the helper aborts because the input rejected the override, debug
      // contains the input fingerprint + per-strategy readback so we can see
      // which write paths were tried and what the input ended up at.
      debug_snapshot: {
        row_html: found.row_html,
        update_debug: updateDebug,
      },
    }, null, 2));
  } finally {
    await browser.close();
  }
}
