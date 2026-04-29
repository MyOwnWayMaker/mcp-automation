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
  // Set VOICE_HEADLESS=false to watch the runtime browser locally (debugging)
  const headless = process.env.VOICE_HEADLESS !== "false";
  const browser = await chromium.launch({
    headless,
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

    // Voice is an Angular SPA. Threads render as <gv-thread-list-item> custom
    // elements inside a <cdk-virtual-scroll-viewport>. Navigation is JS-routed,
    // so there are NO <a href="/messages/t/..."> anchors — clicks are handled
    // by Angular Router, and the URL only updates after click.
    let waitErr: string | null = null;
    try {
      await page.waitForSelector("gv-thread-list-item", { timeout: 25_000 });
    } catch (e) {
      waitErr = (e as Error).message;
    }

    const threads: Array<Record<string, unknown>> = await page.evaluate((max) => {
      const items = Array.from(document.querySelectorAll<HTMLElement>("gv-thread-list-item"));
      return items.slice(0, max).map((item, idx) => {
        // The user-visible details live in .thread-details / .thread-info; the
        // outer textContent also includes Material icon names ("check", "person")
        // and a screen-reader pause sequence we don't want.
        const detailsEl = item.querySelector<HTMLElement>(".thread-details, .thread-info");
        const detailsText = (detailsEl?.innerText || item.innerText || "")
          .replace(/‪|‬/g, "") // strip LRE/PDF directional marks
          .replace(/\s+/g, " ").trim();

        // Best signal for the contact name/number: aria-label on the clickable container
        const button = item.querySelector<HTMLElement>('[role="button"]');
        const ariaLabel = button?.getAttribute("aria-label") || item.getAttribute("aria-label") || "";

        // Look for a Material chip indicating unread
        const unread = !!item.querySelector('[class*="unread"]') ||
                       /unread/i.test(item.getAttribute("aria-label") || "");

        // Heuristic split on the details text:
        //   "<contact>  <preview text>  <timestamp>"
        // Last token that looks like a timestamp wins; everything before the timestamp
        // is contact + preview (Voice runs them together with separators).
        const tsMatch = detailsText.match(/((?:\d{1,2}:\d{2}\s?[AP]M)|(?:Yesterday)|(?:[A-Z][a-z]{2}\s\d{1,2})|(?:\d{1,2}\/\d{1,2}\/\d{2,4}))\s*$/);
        const timestamp = tsMatch ? tsMatch[1] : null;
        const beforeTs = tsMatch ? detailsText.slice(0, tsMatch.index).trim() : detailsText;

        return {
          // Voice navigates via Angular Router — there's no stable thread ID in
          // the DOM until you click. For voice_get_thread, callers should pass
          // `contact` (matched by aria_label/details_text) which makes us click.
          thread_id: null,
          index: idx,
          contact: ariaLabel || null,
          details_text: detailsText.slice(0, 300),
          preview_and_contact: beforeTs.slice(0, 200),
          last_activity_text: timestamp,
          unread,
        };
      });
    }, limit * 2);

    const filtered = (sinceTs ? threads.filter(t => {
      const ts = typeof t.last_activity_text === "string" ? Date.parse(t.last_activity_text) : NaN;
      return Number.isNaN(ts) ? true : ts >= sinceTs;
    }) : threads).slice(0, limit);

    const counts = await page.evaluate(() => ({
      gv_thread_list_item: document.querySelectorAll("gv-thread-list-item").length,
      gv_message_thread_list_item: document.querySelectorAll("gv-message-thread-list-item").length,
      virtual_scroll_viewports: document.querySelectorAll("cdk-virtual-scroll-viewport").length,
      thread_buttons: document.querySelectorAll('gv-thread-list-item [role="button"]').length,
    }));

    return ok(JSON.stringify({
      account: loadVoiceSession().account,
      url: page.url(),
      thread_count: filtered.length,
      threads: filtered,
      ...(filtered.length === 0 ? {
        diagnostic_note: waitErr
          ? `Timed out waiting for gv-thread-list-item to appear (${waitErr}). Either Voice didn't deliver thread data within 25s, or the markup changed.`
          : "Selectors found 0 gv-thread-list-item elements despite no wait error. Markup may have changed.",
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
      // Look up by contact: open inbox, wait for thread items, click the matching one.
      // Voice is Angular-routed — there are no <a href> targets; the URL only updates
      // after a click, so we navigate via the click itself.
      await page.goto("https://voice.google.com/messages", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1500);
      const auth0 = await ensureSignedIn(page);
      if (!auth0.ok) {
        return ok(
          `unauthenticated: ${auth0.reason}\nlanded on: ${auth0.url}\nRe-run scripts/auth-voice.mjs.`
        );
      }
      try {
        await page.waitForSelector("gv-thread-list-item", { timeout: 25_000 });
      } catch (e) {
        return ok(
          `Voice did not deliver thread list within 25s. Wait error: ${(e as Error).message}`,
        );
      }

      const needle = args.contact!.trim();
      const digits = digitsOnly(needle);
      const isPhone = /\d{7,}/.test(digits);
      const phoneTail = isPhone ? digits.slice(-7) : null;

      // Click the first gv-thread-list-item whose visible text or aria-label
      // contains our needle (name) or last-7 digits (phone).
      const clicked = await page.evaluate((arg: { needle: string; phoneTail: string | null }) => {
        const items = Array.from(document.querySelectorAll<HTMLElement>("gv-thread-list-item"));
        for (const item of items) {
          const text = (item.innerText || "").replace(/\s+/g, " ");
          const aria = item.querySelector('[role="button"]')?.getAttribute("aria-label") ?? "";
          const haystack = (text + " " + aria).toLowerCase();
          const hit = haystack.includes(arg.needle.toLowerCase()) ||
                      (arg.phoneTail !== null && haystack.replace(/\D/g, "").includes(arg.phoneTail));
          if (hit) {
            const button = item.querySelector<HTMLElement>('[role="button"]') || item;
            button.click();
            return true;
          }
        }
        return false;
      }, { needle, phoneTail });

      if (!clicked) {
        return ok(
          `Could not find a thread matching "${needle}" in the inbox. ` +
          `Use voice_list_threads to see what's currently visible.`,
        );
      }
      // Give Angular Router a moment to navigate
      await page.waitForURL(url => url.href.includes("/messages/t/"), { timeout: 10_000 }).catch(() => null);
      await page.waitForTimeout(1000);
    }

    const auth1 = await ensureSignedIn(page);
    if (!auth1.ok) {
      return ok(
        `unauthenticated: ${auth1.reason}\nlanded on: ${auth1.url}\nRe-run scripts/auth-voice.mjs.`
      );
    }

    // Wait for messages (Voice loads them via long-poll). Voice's per-thread
    // markup uses gv-message-list / gv-text-message inside cdk-virtual-scroll-viewport.
    // We also accept a broader set of likely selectors.
    const messageSelector = "gv-text-message, gv-message-bubble, gv-message-thread-message, [data-test-id='message-item'], [role='article']";
    let getThreadWaitErr: string | null = null;
    try {
      await page.waitForSelector(messageSelector, { timeout: 30_000 });
    } catch (e) {
      getThreadWaitErr = (e as Error).message;
    }

    // Scroll the cdk-virtual-scroll-viewport for the message pane to the top
    // to force-load the full history (Voice lazy-loads as you scroll up).
    if (scrollToStart) {
      let prevCount = -1;
      let stable = 0;
      const maxScrollIterations = 80;
      for (let i = 0; i < maxScrollIterations; i++) {
        await page.evaluate(() => {
          // The thread's message pane is the LAST cdk-virtual-scroll-viewport
          // (the first is the inbox thread list).
          const viewports = Array.from(document.querySelectorAll<HTMLElement>("cdk-virtual-scroll-viewport"));
          for (const vp of viewports) {
            if (vp.scrollHeight > vp.clientHeight) vp.scrollTop = 0;
          }
          // Fallbacks
          document.querySelectorAll<HTMLElement>('[role="log"], [class*="message-list"]').forEach(el => {
            if (el.scrollHeight > el.clientHeight) el.scrollTop = 0;
          });
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(400);
        const count = await page.locator(messageSelector).count().catch(() => 0);
        if (count === prevCount) {
          stable++;
          if (stable >= 3) break;
        } else {
          stable = 0;
        }
        prevCount = count;
      }
    }

    const messages = await page.evaluate((args: { sel: string; max: number }) => {
      const out: Array<Record<string, unknown>> = [];
      const els = Array.from(document.querySelectorAll<HTMLElement>(args.sel));
      for (const el of els.slice(0, args.max)) {
        const text = (el.innerText || el.textContent || "").replace(/‪|‬/g, "").trim();
        const cls = (el.className?.toString() || "");
        const ariaLabel = el.getAttribute("aria-label") || "";
        const tsAttr = el.querySelector("[data-tooltip], time, [datetime], .timestamp, [class*='time']");
        const tsTooltip = tsAttr?.getAttribute("data-tooltip") ||
                          tsAttr?.getAttribute("datetime") ||
                          (tsAttr?.textContent || "").trim();
        const direction = /outbound|sent|outgoing|self|me\b/i.test(cls + " " + ariaLabel) ? "outbound"
                       : /inbound|received|incoming|other|them/i.test(cls + " " + ariaLabel) ? "inbound"
                       : null;
        const hasMedia = !!el.querySelector('img:not([alt=""]), video, audio, [class*="attachment"], [class*="media"]');
        out.push({
          direction,
          timestamp_text: tsTooltip || null,
          aria_label: ariaLabel || null,
          body: text.split(/\n/).filter(Boolean).join(" ").slice(0, 4000),
          class_hint: cls.slice(0, 200) || null,
          has_media: hasMedia,
        });
      }
      return out;
    }, { sel: messageSelector, max: maxMessages });

    const normalized = messages.map(m => {
      const t = typeof m.timestamp_text === "string" ? Date.parse(m.timestamp_text) : NaN;
      return {
        ...m,
        timestamp_iso: Number.isNaN(t) ? null : new Date(t).toISOString(),
      };
    });

    const ordered = order === "newest_first" ? [...normalized].reverse() : normalized;

    const threadCounts = await page.evaluate(() => ({
      gv_text_message: document.querySelectorAll("gv-text-message").length,
      gv_message_bubble: document.querySelectorAll("gv-message-bubble").length,
      gv_message_thread_message: document.querySelectorAll("gv-message-thread-message").length,
      role_article: document.querySelectorAll('[role="article"]').length,
      cdk_virtual_scroll_viewport: document.querySelectorAll("cdk-virtual-scroll-viewport").length,
      // List ALL custom elements present so we can spot the right one if our guesses miss
      custom_element_tags: Array.from(new Set(
        Array.from(document.querySelectorAll("*"))
          .map(el => el.tagName.toLowerCase())
          .filter(t => t.includes("-") && (t.includes("message") || t.includes("thread") || t.includes("text") || t.includes("bubble")))
      )),
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
