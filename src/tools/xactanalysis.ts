import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import fs from "fs";
import path from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SESSION_PATH = process.env.XACTANALYSIS_SESSION_PATH
  ?? path.resolve(process.cwd(), "xactanalysis_session.json");
// Live session file — written after every tool call so the next call starts
// with rotated cookies (Incapsula, AWSALB, refreshed auth tokens). Survives
// across tool invocations within a worker lifetime; lost on worker restart,
// at which point we fall back to env var / disk. Path is overridable for
// tests; defaults to /tmp on Railway (ephemeral but per-worker-process).
const LIVE_SESSION_PATH = process.env.XACTANALYSIS_LIVE_SESSION_PATH
  ?? "/tmp/xactanalysis_session.live.json";
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
  // Prefer the live file written by persistCookies after the previous call.
  // It has rotated Incapsula/AWS/auth cookies that the env-var snapshot lacks.
  if (fs.existsSync(LIVE_SESSION_PATH)) {
    try {
      const ageMs = Date.now() - fs.statSync(LIVE_SESSION_PATH).mtimeMs;
      // 30-day cap — beyond that the rotated cookies are stale enough that
      // we'd rather fall back to the freshly-captured env var.
      if (ageMs < 30 * 24 * 60 * 60 * 1000) {
        return JSON.parse(fs.readFileSync(LIVE_SESSION_PATH, "utf-8"));
      }
    } catch { /* fall through to env var / disk */ }
  }
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

async function persistCookies(
  context: BrowserContext,
  baseSession: { cookies: unknown[]; localStorage: Record<string, string> },
): Promise<void> {
  // Best-effort: capture rotated cookies (Incapsula, AWSALB, refreshed auth)
  // and write to the live session path. Never throws into the caller; a
  // failure here just means the next call reuses slightly older cookies.
  try {
    const cookies = await context.cookies();
    fs.writeFileSync(
      LIVE_SESSION_PATH,
      JSON.stringify(
        {
          cookies,
          localStorage: baseSession.localStorage ?? {},
          _persistedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    // intentionally swallowed
  }
}

async function getPage(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}> {
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
    // If we just loaded from the live file, drop it so the next call falls
    // back to the env-var snapshot (which may still be valid).
    try { if (fs.existsSync(LIVE_SESSION_PATH)) fs.unlinkSync(LIVE_SESSION_PATH); } catch { /* ignore */ }
    throw new Error("XactAnalysis session expired. Re-run auth-xactanalysis.mjs and update XACTANALYSIS_SESSION_JSON.");
  }

  const close = async () => {
    await persistCookies(context, session);
    await browser.close();
  };

  return { browser, context, page, close };
}

export async function xactListAssignments(args: {
  status?: "in_progress" | "returned" | "all";
  max_results?: number;
  since_date?: string;   // YYYY-MM-DD — show assignments received on/after this date
  include_all?: boolean; // remove date window entirely (shows all time)
}): Promise<CallToolResult> {
  const { browser, page, close } = await getPage();

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
    await close();
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

  const { browser, page, close } = await getPage();

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
    await close();
  }
}

async function updateWorkflowStatus(
  context: BrowserContext,
  page: Page,
  mfn: string,
  statusCode: number,
  date: string,       // YYYY-MM-DD
  time = "09:00:00",
  note = "",
  dryRun = false,     // when true, dismiss dialog without submit and return debug
): Promise<{ ok: boolean; submitted: boolean; message: string; debug?: any }> {
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

  // Discover all form fields in the dialog frame. id="dateupdated" came back null
  // last iteration — the input is identified by name= or has been renamed entirely.
  // Dump everything so we can map id→name→type fingerprints reliably.
  type Discovered = {
    inputs: { id: string; name: string; type: string; value: string; placeholder: string; className: string; outer_html: string }[];
    textareas: { id: string; name: string; value: string }[];
    selects: { id: string; name: string; value: string }[];
    nested_iframes: { src: string; id: string; name: string }[];
    body_html_preview: string;
    frame_url: string;
  };
  const discovery: Discovered = await dlgFrame.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input")).map(el => {
      const i = el as HTMLInputElement;
      return {
        id: i.id, name: i.name, type: i.type, value: i.value,
        placeholder: i.placeholder, className: i.className,
        outer_html: i.outerHTML.substring(0, 400),
      };
    });
    const textareas = Array.from(document.querySelectorAll("textarea")).map(el => {
      const t = el as HTMLTextAreaElement;
      return { id: t.id, name: t.name, value: t.value };
    });
    const selects = Array.from(document.querySelectorAll("select")).map(el => {
      const s = el as HTMLSelectElement;
      return { id: s.id, name: s.name, value: s.value };
    });
    const nested_iframes = Array.from(document.querySelectorAll("iframe")).map(el => {
      const f = el as HTMLIFrameElement;
      return { src: f.src, id: f.id, name: f.name };
    });
    return {
      inputs, textareas, selects, nested_iframes,
      body_html_preview: document.body.innerHTML.substring(0, 4000),
      frame_url: location.href,
    };
  });

  // Pick the date / time / notes elements by id, name, type, or substring.
  const findInput = (...keys: string[]) => {
    for (const key of keys) {
      const lower = key.toLowerCase();
      const exact = discovery.inputs.find(i => i.id === key || i.name === key);
      if (exact) return exact;
      const partial = discovery.inputs.find(i =>
        i.id.toLowerCase().includes(lower) || i.name.toLowerCase().includes(lower)
      );
      if (partial) return partial;
    }
    return undefined;
  };
  const dateField = findInput("dateupdated", "date") ?? discovery.inputs.find(i => i.type === "date");
  const timeField = findInput("timeupdated", "time") ?? discovery.inputs.find(i => i.type === "time");
  const notesField = discovery.textareas.find(t => /note|comment/i.test(t.id) || /note|comment/i.test(t.name))
    ?? (discovery.textareas[0]);

  if (!dateField) {
    // Dialog opened but no date input is anywhere we can see. Dump everything
    // and bail without saving.
    await page.goto(`${BASE}/cxa/detail.jsp?mfn=${mfn}&src=ip`).catch(() => {});
    await page.waitForTimeout(1500);

    const all_frames_info = page.frames().map(f => ({
      url: f.url(), name: f.name(),
      parent_url: f.parentFrame()?.url() ?? null,
    }));
    const err: any = new Error(`updateStatus(${statusCode}): no date input found in dialog frame.`);
    err.debug = {
      target_date: date,
      target_time: time,
      status_code: statusCode,
      dlg_frame_url: dlgFrame.url(),
      all_frames: all_frames_info,
      discovery,
      reason: "no input element matched id/name/type='date*'; dialog dismissed without save",
    };
    throw err;
  }

  // Build the locator key for the discovered date input. Prefer id, fall back to name.
  const dateKey = dateField.id || dateField.name;
  const dateByIdOrName = dateField.id ? "id" : "name";
  const timeKey = timeField ? (timeField.id || timeField.name) : null;
  const timeByIdOrName = timeField ? (timeField.id ? "id" : "name") : null;
  const notesKey = notesField ? (notesField.id || notesField.name) : null;
  const notesByIdOrName = notesField ? (notesField.id ? "id" : "name") : null;

  // Selector strings for Playwright locators (used in fill/focus/pressSequentially)
  const dateSel = dateByIdOrName === "id" ? `#${dateKey}` : `[name="${dateKey}"]`;
  const timeSel = timeKey ? (timeByIdOrName === "id" ? `#${timeKey}` : `[name="${timeKey}"]`) : null;

  // Three write strategies, with a readback gate. Only submit if the date
  // input actually equals our target — otherwise dismiss without saving.
  type WriteResult = { strategy: string; date_after: string | null; time_after: string | null };
  const results: WriteResult[] = [];

  const readback = async (): Promise<{ date: string | null; time: string | null }> =>
    await dlgFrame.evaluate((args: { dKey: string; dBy: string; tKey: string | null; tBy: string | null }) => {
      const get = (key: string, by: string) =>
        by === "id" ? document.getElementById(key) : document.querySelector(`[name="${key}"]`);
      const d = get(args.dKey, args.dBy) as HTMLInputElement | null;
      const t = args.tKey && args.tBy ? get(args.tKey, args.tBy) as HTMLInputElement | null : null;
      return { date: d?.value ?? null, time: t?.value ?? null };
    }, { dKey: dateKey, dBy: dateByIdOrName, tKey: timeKey, tBy: timeByIdOrName });

  // Strategy A: drive flatpickr if present (keeps visible+hidden inputs in
  // lockstep), else native setter + input/change/blur. Dispatch's discovery
  // confirmed the date field is class="flatpickr-input" with type="hidden",
  // and an unnamed visible <input type="text"> exists alongside — flatpickr
  // resyncs the hidden from the visible at submit time, so we MUST drive its
  // API rather than poking the inputs directly.
  await dlgFrame.evaluate((args: {
    dKey: string; dBy: string; tKey: string | null; tBy: string | null; nKey: string | null; nBy: string | null;
    date: string; time: string; note: string;
  }) => {
    const get = (key: string, by: string): HTMLElement | null =>
      (by === "id" ? document.getElementById(key) : document.querySelector(`[name="${key}"]`)) as HTMLElement | null;

    const setVal = (el: HTMLElement | null, value: string) => {
      if (!el) return;
      // Flatpickr-first: el._flatpickr.setDate(value, true) updates the visible
      // text input AND the hidden form field together and fires the proper
      // change events. Without this, our write to the hidden field gets
      // overwritten by flatpickr's internal resync from the visible input.
      const fp = (el as any)._flatpickr;
      if (fp && typeof fp.setDate === "function") {
        try { fp.setDate(value, true); return; } catch {}
      }
      // Native setter fallback for plain inputs
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else (el as any).value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    };

    setVal(get(args.dKey, args.dBy), args.date);
    if (args.tKey && args.tBy) setVal(get(args.tKey, args.tBy), args.time);
    if (args.note && args.nKey && args.nBy) setVal(get(args.nKey, args.nBy), args.note);
  }, {
    dKey: dateKey, dBy: dateByIdOrName,
    tKey: timeKey, tBy: timeByIdOrName,
    nKey: notesKey, nBy: notesByIdOrName,
    date, time, note,
  });
  let r = await readback();
  results.push({ strategy: "native_setter+events", date_after: r.date, time_after: r.time });

  // Strategy B: Playwright fill on the discovered selector
  if (r.date !== date) {
    try {
      await dlgFrame.locator(dateSel).fill(date);
      if (timeSel) await dlgFrame.locator(timeSel).fill(time).catch(() => {});
      r = await readback();
      results.push({ strategy: "playwright_fill", date_after: r.date, time_after: r.time });
    } catch (e: any) {
      results.push({ strategy: "playwright_fill", date_after: `error: ${e?.message ?? e}`, time_after: null });
    }
  }

  // Strategy C: focus → clear → pressSequentially
  if (r.date !== date) {
    try {
      await dlgFrame.locator(dateSel).focus();
      await dlgFrame.evaluate((args: { key: string; by: string }) => {
        const el = (args.by === "id" ? document.getElementById(args.key) : document.querySelector(`[name="${args.key}"]`)) as HTMLInputElement | null;
        if (!el) return;
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, "");
        else el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, { key: dateKey, by: dateByIdOrName });
      await dlgFrame.locator(dateSel).pressSequentially(date, { delay: 30 });
      r = await readback();
      results.push({ strategy: "focus+clear+pressSequentially", date_after: r.date, time_after: r.time });
    } catch (e: any) {
      results.push({ strategy: "focus+clear+pressSequentially", date_after: `error: ${e?.message ?? e}`, time_after: null });
    }
  }

  // Capture the FULL form state right before submit/dismiss decision. The previous
  // iteration showed update_error: null (gate passed) but the row still got
  // corrupted with "now" — meaning a hidden field or picker-state holds the
  // canonical value the form actually posts. This dumps every form field so we
  // can identify the real culprit.
  const formState = await dlgFrame.evaluate(() => {
    const forms = Array.from(document.querySelectorAll("form"));
    if (forms.length === 0) {
      // No <form>: still dump every input/textarea/select on the page
      const all = Array.from(document.querySelectorAll("input, textarea, select")).map(el => {
        const e = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        return { id: e.id, name: e.name, type: (e as HTMLInputElement).type ?? e.tagName, value: (e as HTMLInputElement).value };
      });
      return { has_form: false, all_inputs: all, form_data_entries: [] as { key: string; value: string }[] };
    }
    const form = forms[0] as HTMLFormElement;
    const fd = new FormData(form);
    const form_data_entries: { key: string; value: string }[] = [];
    fd.forEach((v, k) => form_data_entries.push({ key: k, value: typeof v === "string" ? v : "(file)" }));
    const all_inputs = Array.from(form.querySelectorAll("input, textarea, select")).map(el => {
      const e = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      return { id: e.id, name: e.name, type: (e as HTMLInputElement).type ?? e.tagName, value: (e as HTMLInputElement).value };
    });
    return {
      has_form: true,
      form_action: form.action,
      form_method: form.method,
      form_data_entries,   // what new FormData(form) would actually post
      all_inputs,          // every input including hidden, in DOM order
    };
  });

  const debug = {
    target_date: date,
    target_time: time,
    status_code: statusCode,
    discovered_date_field: dateField,
    discovered_time_field: timeField ?? null,
    discovered_notes_field: notesField ?? null,
    attempts: results,
    form_state_before_submit: formState,
  };

  // GATE: only submit if date stuck AND we're not in dry_run mode.
  const dateStuck = r.date === date;
  if (!dateStuck || dryRun) {
    await page.goto(`${BASE}/cxa/detail.jsp?mfn=${mfn}&src=ip`).catch(() => {});
    await page.waitForTimeout(1500);
    return {
      ok: dateStuck,   // ok=true if value stuck, even when not submitted
      submitted: false,
      message: dryRun
        ? `Dry run for status ${statusCode}: form state captured, dialog dismissed without submit.`
        : `updateStatus(${statusCode}): date input rejected override (${date}). All three write strategies failed.`,
      debug,
    };
  }

  // Date stuck and not dry_run — safe to submit. Discover the submit button.
  const submitButton = discovery.inputs.find(i =>
    /update.*status|^updatestatus|update_button/i.test(i.id) ||
    /update.*status|^updatestatus|update_button/i.test(i.name)
  );
  if (submitButton) {
    const sel = submitButton.id ? `#${submitButton.id}` : `[name="${submitButton.name}"]`;
    await dlgFrame.locator(sel).click().catch(() => {});
  } else {
    await dlgFrame.locator('button:has-text("Update"), input[value*="Update" i], button:has-text("Save"), input[value*="Save" i]').first().click().catch(() => {});
  }
  await page.waitForTimeout(4000);

  return {
    ok: true,
    submitted: true,
    message: `Status ${statusCode} updated to ${date}`,
    debug,
  };
}

export async function xactUpdateDates(args: {
  mfn: string;
  customer_contacted_date?: string;  // YYYY-MM-DD or M/D/YYYY
  site_inspected_date?: string;
  note?: string;
}): Promise<CallToolResult> {
  const { browser, context, page, close } = await getPage();

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
    await close();
  }
}

export async function xactUpdateWorkflowStatus(args: {
  mfn: string;
  status: "customer_contacted" | "site_inspected" | "job_sold" | "job_started" | "job_not_sold";
  date: string;  // YYYY-MM-DD or M/D/YYYY
  time?: string; // HH:MM (24h), defaults to 09:00
  note?: string;
}): Promise<CallToolResult> {
  const { browser, context, page, close } = await getPage();

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
    await close();
  }
}

export async function xactAddNote(args: {
  mfn: string;
  note: string;
}): Promise<CallToolResult> {
  const { browser, page, close } = await getPage();

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
    await close();
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
  const { browser, page, close } = await getPage();

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
    await close();
  }
}

export async function xactFindAssignmentByName(args: {
  name_query: string;
}): Promise<CallToolResult> {
  const { browser, page, close } = await getPage();

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
    await close();
  }
}

export async function xactGetNotes(args: {
  mfn: string;
}): Promise<CallToolResult> {
  const { browser, page, close } = await getPage();

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
    await close();
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

  const { browser, page, close } = await getPage();

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
    await close();
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
  const months = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];
  const monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mn = months[m - 1];
  const ms = monthsShort[m - 1];
  const candidates = [
    `${m}/${d}/${y}`,
    `${m.toString().padStart(2, "0")}/${d.toString().padStart(2, "0")}/${y}`,
    isoDate,
    `${m}/${d}/${y.toString().slice(-2)}`,
    `${m.toString().padStart(2, "0")}/${d.toString().padStart(2, "0")}/${y.toString().slice(-2)}`,
    `${mn} ${d}, ${y}`,
    `${mn} ${d.toString().padStart(2, "0")}, ${y}`,
    `${ms} ${d}, ${y}`,
    `${ms} ${d.toString().padStart(2, "0")}, ${y}`,
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
  dry_run?: boolean;  // when true, capture form state + dismiss without submit (no XA writes)
}): Promise<CallToolResult> {
  const dateIso = fmt(args.date);
  const { browser, context, page, close } = await getPage();

  try {
    // Idempotency guard: read the current value first. If XA already shows
    // the target date, skip the submit. Without this, retries (Cloud
    // Dispatch network blips, multiple pipeline invocations) each append a
    // fresh timeline entry, leaving 5x duplicate "Planned Inspection Date"
    // rows in the XA status history.
    const existing = await readPlannedDate(page, args.mfn).catch(() => "");
    if (existing && dateMatchesAny(existing, dateIso)) {
      return ok(JSON.stringify({
        ok: true,
        submitted: false,
        skipped: "already set",
        value_read: existing,
        target_iso: dateIso,
        message: "Planned Inspection Date already matches target — no submit (idempotent skip).",
      }, null, 2));
    }

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

    let result: { ok: boolean; submitted: boolean; message: string; debug?: any };
    let updateError: string | null = null;
    try {
      result = await updateWorkflowStatus(
        context, page, args.mfn, found.code, dateIso, "09:00:00", "",
        args.dry_run === true
      );
    } catch (e: any) {
      updateError = String(e?.message || e);
      result = { ok: false, submitted: false, message: updateError, debug: e?.debug ?? null };
    }

    const verified = result.submitted ? await readPlannedDate(page, args.mfn) : "(not submitted)";
    const success = result.ok && result.submitted && dateMatchesAny(verified, dateIso);

    return ok(JSON.stringify({
      ok: success,
      submitted: result.submitted,
      value_read: verified,
      target_iso: dateIso,
      extracted_workflow_code: found.code,
      update_error: updateError,
      message: result.message,
      // form_state_before_submit dumps every form field (including hidden) so we
      // can see what the form would actually post — vs what the visible input shows.
      // Most likely culprit on prior failures: a hidden picker-state field that
      // holds the canonical "now" value while the visible text input shows our override.
      debug_snapshot: {
        row_html: found.row_html,
        update_debug: result.debug,
      },
    }, null, 2));
  } finally {
    await close();
  }
}
