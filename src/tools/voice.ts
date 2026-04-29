/**
 * Google Voice MCP module.
 *
 * Two paths planned:
 *   1. Playwright fast-loop (this file, today). Drives voice.google.com with
 *      a saved storageState, no LLM-in-the-loop. ~10–20× faster than
 *      Chrome-MCP-driven scraping but still slower than direct RPC.
 *   2. Direct RPC (future). Hits Voice's internal /RpcUi/data/batchexecute
 *      endpoints with cookie + SAPISIDHASH auth. Tool surface stays identical.
 *
 * Auth: voice_session.json (or VOICE_SESSION_JSON env var) — produced by
 * scripts/auth-voice.mjs. Tied to a single Google account at a time
 * (hdynamo217@gmail.com today; account-pluggable for future).
 *
 * Note: voice.google.com is blocked on Workspace accounts unless the admin
 * enables it, which is why the personal Gmail is the only working option
 * for Hakiel right now.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "fs";
import path from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SESSION_PATH = process.env.VOICE_SESSION_PATH ||
  path.resolve(process.cwd(), "voice_session.json");

interface VoiceSession {
  account: string;
  savedAt: string;
  cookies: unknown[];
  localStorage: Record<string, string>;
  sessionStorage?: Record<string, string>;
  storageState: Parameters<BrowserContext["storageState"]>[0] extends infer _ ? unknown : never;
  googleCookieHeader?: string;
  sapisid?: string | null;
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function loadVoiceSession(): VoiceSession {
  // VOICE_SESSION_JSON is supposed to be the file CONTENTS (a JSON blob),
  // but it's an easy footgun to paste a path into the Railway dashboard
  // by mistake. Detect that case and fail loud with a useful message
  // instead of letting JSON.parse blow up on backslashes.
  const fromEnv = process.env.VOICE_SESSION_JSON;
  if (fromEnv) {
    // Strip BOM that PowerShell pipelines sometimes prepend, then trim.
    const trimmed = fromEnv.replace(/^﻿/, "").trim();
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed);
    }
    // Looks like a filesystem path — try to read it (works locally, not on Railway)
    if (fs.existsSync(trimmed)) {
      return JSON.parse(fs.readFileSync(trimmed, "utf-8"));
    }
    throw new Error(
      `VOICE_SESSION_JSON is set but doesn't look like JSON (it starts with "${trimmed.slice(0, 20)}…"). ` +
      `Expected: the full CONTENTS of voice_session.json (which begins with "{"). ` +
      `If you pasted a Windows path like C:\\Users\\... into the Railway dashboard, that won't work — ` +
      `Railway runs Linux and can't read your local filesystem. Re-paste the file contents instead.`,
    );
  }
  if (fs.existsSync(SESSION_PATH)) {
    return JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
  }
  throw new Error(
    "Google Voice session not found. Run `node scripts/auth-voice.mjs` to capture one, " +
    "or set the VOICE_SESSION_JSON env var (Railway) to the FILE CONTENTS (not a path).",
  );
}

/**
 * Open a Chromium context preloaded with the saved Voice session. Caller is
 * responsible for closing the browser.
 */
async function getVoicePage(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const session = loadVoiceSession();
  if (!session.storageState) {
    throw new Error("voice_session.json missing `storageState`. Re-run scripts/auth-voice.mjs.");
  }
  // Apply the same anti-detection flags that auth-voice.mjs uses, otherwise
  // Google flags the headless Chromium as automation and the Voice long-poll
  // (signaler-pa.clients6.google.com) silently refuses to deliver thread data.
  // The page hydrates but never populates → after a timeout, Voice's app
  // redirects to workspace.google.com/products/voice as a fallback.
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const context = await browser.newContext({
    storageState: session.storageState as any,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", {
      get: () => [{ name: "Chrome PDF Plugin" }, { name: "Chrome PDF Viewer" }, { name: "Native Client" }],
    });
  });
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Confirm we are on a logged-in Voice page. Returns a structured result so
 * callers can surface WHY they think we're not signed in (URL pattern,
 * visible sign-in CTA, etc.).
 */
async function ensureSignedIn(page: Page): Promise<{ ok: boolean; reason?: string; url: string }> {
  const url = page.url();
  if (url.includes("accounts.google.com")) {
    return { ok: false, reason: "redirected to accounts.google.com (cookies not accepted)", url };
  }
  if (url.includes("workspace.google.com/products/voice")) {
    return { ok: false, reason: "redirected to workspace.google.com — Voice not enabled for this account", url };
  }
  if (!url.includes("voice.google.com")) {
    return { ok: false, reason: `unexpected URL after navigation`, url };
  }
  // The signed-out landing has a visible Sign-in CTA in the page heading.
  // The signed-in inbox does NOT — it has the actual messages UI. Be specific:
  // role=link or role=button with name "Sign in" (not just any link to accounts.google.com,
  // since the logged-in account-switcher menu also points at accounts.google.com).
  const signInLink = await page.getByRole("link", { name: /^Sign in/i }).first()
    .isVisible({ timeout: 800 }).catch(() => false);
  const signInBtn = await page.getByRole("button", { name: /^Sign in/i }).first()
    .isVisible({ timeout: 800 }).catch(() => false);
  if (signInLink || signInBtn) {
    return { ok: false, reason: "Sign-in CTA visible — session not active on voice.google.com", url };
  }
  return { ok: true, url };
}

/** Normalize a phone number to digits only (drops +, spaces, dashes, parens). */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

// ─── voice_list_threads ────────────────────────────────────────────────────
// Returns recent threads from the inbox. Selectors are best-effort; voice's
// DOM is dynamic and may need adjusting after first run. The diagnostic dump
// embedded in the result helps tune them quickly.

export async function voiceListThreads(args: {
  limit?: number;
  /** ISO 8601; only return threads with last activity at or after this. */
  since?: string;
}): Promise<CallToolResult> {
  const limit = args.limit ?? 20;
  const sinceTs = args.since ? Date.parse(args.since) : 0;

  const { browser, page } = await getVoicePage();
  try {
    await page.goto("https://voice.google.com/messages", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1500);

    const auth = await ensureSignedIn(page);
    if (!auth.ok) {
      return ok(
        `unauthenticated: ${auth.reason}\n` +
        `landed on: ${auth.url}\n` +
        `Re-run scripts/auth-voice.mjs to refresh the session, then push the new compact JSON to Railway:\n` +
        `  Get-Content voice_session.compact.json -Raw | railway variables --set-from-stdin VOICE_SESSION_JSON`
      );
    }

    // Voice's thread list is populated via a long-poll XHR (signaler-pa.clients6.google.com/...)
    // AFTER the static HTML hydrates. Wait for at least one thread anchor to appear before
    // scraping — otherwise we get an empty list.
    const threadAnchorSelector = 'a[href*="/messages/t/"]';
    let waitErr: string | null = null;
    try {
      await page.waitForSelector(threadAnchorSelector, { timeout: 25_000 });
    } catch (e) {
      waitErr = (e as Error).message;
    }

    // Voice renders threads as <gv-thread-item> custom elements (or plain divs
    // with role="listitem"). Try a few selectors and pick whatever returns rows.
    const threadHandles = await page.locator(
      'gv-thread-item, [data-test-id="thread-item"], [role="listitem"]:has(a[href*="/messages/t/"])'
    ).all();

    const threads: Array<Record<string, unknown>> = [];
    for (const h of threadHandles.slice(0, limit * 2)) {
      const text = await h.innerText().catch(() => "");
      const href = await h.locator('a[href*="/messages/t/"]').first().getAttribute("href").catch(() => null);
      const threadId = href?.match(/\/messages\/t\/([^/?#]+)/)?.[1] ?? null;

      // Lines: contact name, preview, timestamp (varies with locale)
      const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
      threads.push({
        thread_id: threadId,
        contact: lines[0] ?? null,
        preview: lines.find(l => l !== lines[0] && !/^\d+([smhdw]| ago| min| hour| day)/i.test(l)) ?? null,
        last_activity_text: lines.find(l => /\d/.test(l) && (/(ago|AM|PM|:|\/)/.test(l))) ?? null,
        unread: text.toLowerCase().includes("unread"),
        raw: text.length > 400 ? text.substring(0, 400) + "…" : text,
      });
      if (threads.length >= limit) break;
    }

    // since-filter (best-effort — relies on parseable timestamps)
    const filtered = sinceTs ? threads.filter(t => {
      const ts = typeof t.last_activity_text === "string" ? Date.parse(t.last_activity_text) : NaN;
      return Number.isNaN(ts) ? true : ts >= sinceTs;
    }) : threads;

    // Diagnostic counts so we can tell apart "long-poll never arrived" vs "selectors are wrong"
    const counts = await page.evaluate(() => ({
      thread_anchors: document.querySelectorAll('a[href*="/messages/t/"]').length,
      gv_thread_items: document.querySelectorAll('gv-thread-item').length,
      role_listitem: document.querySelectorAll('[role="listitem"]').length,
      role_list: document.querySelectorAll('[role="list"]').length,
    }));

    return ok(JSON.stringify({
      account: loadVoiceSession().account,
      url: page.url(),
      thread_count: filtered.length,
      threads: filtered,
      ...(threadHandles.length === 0 ? {
        diagnostic_note: waitErr
          ? `Timed out waiting for thread anchors to appear in DOM (Voice's long-poll XHR didn't deliver thread list within 25s). Check session validity or network. Wait error: ${waitErr}`
          : "No thread elements matched current selectors, but DOM had anchors. Selectors need tuning.",
        dom_counts: counts,
      } : { dom_counts: counts }),
    }, null, 2));
  } finally {
    await browser.close();
  }
}

// ─── voice_get_thread ──────────────────────────────────────────────────────
// THE primary tool. Returns every message in a thread, oldest-first by default.
// Scrolls to the top of the message list to force lazy-loaded history.

export async function voiceGetThread(args: {
  thread_id?: string;
  contact?: string;        // contact name OR phone number
  scroll_to_start?: boolean;
  order?: "oldest_first" | "newest_first";
  max_messages?: number;
}): Promise<CallToolResult> {
  if (!args.thread_id && !args.contact) {
    return ok("voice_get_thread requires thread_id or contact.");
  }

  const order = args.order ?? "oldest_first";
  const scrollToStart = args.scroll_to_start ?? true;
  const maxMessages = args.max_messages ?? 5000;

  const { browser, page } = await getVoicePage();
  try {
    // Prefer direct thread URL when we have it
    if (args.thread_id) {
      await page.goto(
        `https://voice.google.com/messages/t/${encodeURIComponent(args.thread_id)}`,
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      );
    } else {
      // Look up by contact: open inbox and click the matching thread
      await page.goto("https://voice.google.com/messages", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(2000);
      const auth0 = await ensureSignedIn(page);
      if (!auth0.ok) {
        return ok(
          `unauthenticated: ${auth0.reason}\nlanded on: ${auth0.url}\nRe-run scripts/auth-voice.mjs.`
        );
      }
      const needle = args.contact!.trim();
      const isPhone = /\d{7,}/.test(digitsOnly(needle));
      // Strategies: text match, then phone-digit match
      const byText = page.locator(`a[href*="/messages/t/"]:has-text("${needle}")`).first();
      const opened = await byText.click({ timeout: 5000 }).then(() => true).catch(() => false);
      if (!opened && isPhone) {
        const digits = digitsOnly(needle);
        const phoneLink = page.locator(`a[href*="/messages/t/"]`).filter({ hasText: digits.slice(-7) }).first();
        await phoneLink.click({ timeout: 5000 }).catch(() => null);
      }
      await page.waitForTimeout(1500);
    }

    const auth1 = await ensureSignedIn(page);
    if (!auth1.ok) {
      return ok(
        `unauthenticated: ${auth1.reason}\nlanded on: ${auth1.url}\nRe-run scripts/auth-voice.mjs.`
      );
    }

    // Wait for the thread's messages to populate (long-poll XHR, same as inbox)
    const messageSelector = '[role="article"], gv-text-message-item, [data-test-id="message-item"]';
    let getThreadWaitErr: string | null = null;
    try {
      await page.waitForSelector(messageSelector, { timeout: 30_000 });
    } catch (e) {
      getThreadWaitErr = (e as Error).message;
    }

    // Scroll the message list to the top to force-load full history.
    // Voice lazy-loads in batches as you scroll up.
    if (scrollToStart) {
      let prevCount = -1;
      let stable = 0;
      const maxScrollIterations = 80;
      for (let i = 0; i < maxScrollIterations; i++) {
        // Scroll the most likely message-pane scroll container to top
        await page.evaluate(() => {
          const candidates: HTMLElement[] = [];
          document.querySelectorAll<HTMLElement>('[role="log"], [role="list"], gv-thread-list, .gv-message-list, [class*="messages"]').forEach(el => candidates.push(el));
          // Also try the body's main scrollable region
          for (const el of candidates) {
            if (el.scrollHeight > el.clientHeight) el.scrollTop = 0;
          }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(400);
        const count = await page.locator('[role="article"], gv-text-message-item, [data-test-id="message-item"]').count().catch(() => 0);
        if (count === prevCount) {
          stable++;
          if (stable >= 3) break;
        } else {
          stable = 0;
        }
        prevCount = count;
      }
    }

    // Extract messages. Voice marks outbound messages with class names like
    // "outbound" or aria attributes; these are not stable across releases.
    // We grab a generous set of fields and let the caller see what came through.
    const messages = await page.evaluate((max: number) => {
      const sel = '[role="article"], gv-text-message-item, [data-test-id="message-item"]';
      const out: Array<Record<string, unknown>> = [];
      const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
      for (const el of els.slice(0, max)) {
        const text = el.innerText || el.textContent || "";
        const cls = el.className || "";
        const ariaLabel = el.getAttribute("aria-label") || "";
        const tsAttr = el.querySelector("[data-tooltip], time, [datetime]");
        const tsTooltip = tsAttr?.getAttribute("data-tooltip") || tsAttr?.getAttribute("datetime") || tsAttr?.textContent || "";
        const direction = /outbound|sent|outgoing/i.test(cls + " " + ariaLabel) ? "outbound"
                       : /inbound|received|incoming/i.test(cls + " " + ariaLabel) ? "inbound"
                       : null;
        const hasMedia = !!el.querySelector('img:not([alt=""]), video, audio, [class*="attachment"], [class*="media"]');
        out.push({
          direction,
          timestamp_text: tsTooltip || null,
          aria_label: ariaLabel || null,
          body: text.split(/\n/).filter(Boolean).join(" ").slice(0, 4000),
          has_media: hasMedia,
        });
      }
      return out;
    }, maxMessages);

    // Try to ISO-normalize timestamps where possible
    const normalized = messages.map(m => {
      const t = typeof m.timestamp_text === "string" ? Date.parse(m.timestamp_text) : NaN;
      return {
        ...m,
        timestamp_iso: Number.isNaN(t) ? null : new Date(t).toISOString(),
      };
    });

    const ordered = order === "newest_first" ? [...normalized].reverse() : normalized;

    const threadCounts = await page.evaluate(() => ({
      role_article: document.querySelectorAll('[role="article"]').length,
      gv_text_message_item: document.querySelectorAll('gv-text-message-item').length,
      role_log: document.querySelectorAll('[role="log"]').length,
      role_list: document.querySelectorAll('[role="list"]').length,
    }));

    return ok(JSON.stringify({
      account: loadVoiceSession().account,
      thread_url: page.url(),
      message_count: ordered.length,
      order,
      messages: ordered,
      ...(ordered.length === 0 ? {
        diagnostic_note: getThreadWaitErr
          ? `Timed out waiting for messages to appear in DOM (Voice's long-poll XHR didn't deliver message list within 30s). Wait error: ${getThreadWaitErr}`
          : "No messages matched current selectors despite DOM elements present. Selectors need tuning.",
        dom_counts: threadCounts,
      } : { dom_counts: threadCounts }),
    }, null, 2));
  } finally {
    await browser.close();
  }
}

// ─── voice_dump_html (diagnostic) ──────────────────────────────────────────
// Mirror of filetrac_dump_html. Lets us inspect Voice's rendered DOM when a
// parser misses content.

export async function voiceDumpHtml(args: {
  path?: string;       // relative path under voice.google.com or full URL
  search?: string;     // optional substring to slice around
  context_chars?: number;
  max_matches?: number;
  scroll_to_start?: boolean;
  /** Extra ms to wait after navigation, on top of domcontentloaded. Default 3000. */
  wait_ms?: number;
  /** If set, wait for this CSS selector to appear (timeout 30s) before dumping. */
  wait_for_selector?: string;
}): Promise<CallToolResult> {
  const targetUrl = args.path?.startsWith("http")
    ? args.path
    : `https://voice.google.com${args.path?.startsWith("/") ? args.path : `/u/0/${args.path ?? "messages"}`}`;

  const { browser, page } = await getVoicePage();
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (args.wait_for_selector) {
      await page.waitForSelector(args.wait_for_selector, { timeout: 30_000 }).catch(() => null);
    }
    await page.waitForTimeout(args.wait_ms ?? 3000);

    if (args.scroll_to_start) {
      for (let i = 0; i < 30; i++) {
        await page.evaluate(() => {
          document.querySelectorAll<HTMLElement>('[role="log"], [role="list"]').forEach(el => { el.scrollTop = 0; });
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(300);
      }
    }

    const html = await page.content();
    if (!args.search) {
      return ok(`URL: ${page.url()}\nLength: ${html.length}\n\n${html.substring(0, 50_000)}${html.length > 50_000 ? "\n…(truncated)" : ""}`);
    }
    const ctx = args.context_chars ?? 1500;
    const max = args.max_matches ?? 10;
    const matches: string[] = [];
    let from = 0;
    while (matches.length < max) {
      const i = html.indexOf(args.search, from);
      if (i < 0) break;
      const start = Math.max(0, i - ctx);
      const end = Math.min(html.length, i + args.search.length + ctx);
      matches.push(`--- match @${i} ---\n${html.substring(start, end)}`);
      from = i + args.search.length;
    }
    return ok(
      `URL: ${page.url()} | length=${html.length} | matches=${matches.length}\n\n${matches.join("\n\n") || "(no matches)"}`
    );
  } finally {
    await browser.close();
  }
}

// ─── Stubs for tools pending the Dispatch RPC probe ────────────────────────
// These return a clear "not yet implemented" so callers fail loud rather
// than silently returning empty. Once we know which path (RPC or Playwright)
// we're going with, fill these in.

export async function voiceSearchMessages(_args: {
  query: string;
  since?: string;
  until?: string;
}): Promise<CallToolResult> {
  return ok(
    "voice_search_messages: not yet implemented. " +
    "Pending decision between RPC fast-path (preferred — Dispatch is probing endpoints) " +
    "and Playwright fallback. Will be filled in once that decision lands.",
  );
}

export async function voiceGetVoicemails(_args: {
  limit?: number;
  since?: string;
}): Promise<CallToolResult> {
  return ok(
    "voice_get_voicemails: not yet implemented. " +
    "Pending decision between RPC fast-path and Playwright fallback.",
  );
}

export async function voiceSendSms(_args: {
  thread_id?: string;
  number?: string;
  body: string;
  force?: boolean;
  skip_verify?: boolean;
}): Promise<CallToolResult> {
  return ok(
    "voice_send_sms: not yet implemented. " +
    "Will mirror the filetrac_add_note read-write-read sandwich (pre-read thread, send, " +
    "post-read to verify the message ID landed) once we have a working send path.",
  );
}
