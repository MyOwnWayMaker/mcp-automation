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
    permissions: ["clipboard-read", "clipboard-write"],
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
        // The user-visible details live in .thread-details. The outer textContent
        // also includes Material icon names ("check", "person") which we don't want.
        const detailsEl = item.querySelector<HTMLElement>(".thread-details, .thread-info");
        let detailsText = (detailsEl?.innerText || item.innerText || "")
          .replace(/[‪‬‫‭‮]/g, "")          // strip Unicode directional marks
          .replace(/ | /g, " ")     // narrow no-break space, nbsp → space
          .replace(/\s+/g, " ")
          .trim();

        // Voice's accessible label spells out digits for screen readers:
        //   "(407) 310-2679 4 0 7 3 1 0 2 6 7 9"
        // The spelled run must NOT start mid-phone-number. The lookbehind ensures
        // the first digit of the run is not preceded by another digit (otherwise
        // the trailing digit of the visible phone number gets consumed).
        const detailsClean = detailsText
          .replace(/(?<!\d)(?:\d\s){4,}\d/g, "")  // strip spelled-digit runs (4+ pairs covers 5-digit codes too)
          .replace(/\s+/g, " ")
          .replace(/,\s*\./g, ".")                // ", ." → "."
          .replace(/\s+\./g, ".")
          .replace(/\s+,/g, ",")
          .trim();

        // Unread marker is appended at the end of the accessible label as " . Unread ."
        const unread = / Unread\s*\.?\s*$/i.test(detailsText) ||
                       !!item.querySelector('[class*="unread"]');

        // Full timestamp pattern Voice uses: "Wednesday, April 29 2026, 8:15 AM"
        const fullTsRe = /(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\s+\d{4},?\s+\d{1,2}:\d{2}\s?(AM|PM)/i;
        const fullTs = detailsClean.match(fullTsRe)?.[0] || null;
        // Short timestamp at the head of the row: "8:15 AM", "Tue", "Yesterday", "4/27"
        const shortTsRe = /(?:^|\s)((?:\d{1,2}:\d{2}\s?[AP]M)|(?:Yesterday|Today)|(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)|(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?))\s+/;
        const shortTsMatch = detailsClean.match(shortTsRe);
        const shortTs = shortTsMatch?.[1] || null;

        // The contact display is everything BEFORE the short timestamp marker.
        const contact = ((shortTsMatch && shortTsMatch.index !== undefined)
          ? detailsClean.slice(0, shortTsMatch.index).trim()
          : detailsClean.split(".")[0].trim()
        ).replace(/[,\s.]+$/, "");

        // The preview text sits between the short timestamp and the full timestamp:
        //   <contact> <shortTs> <preview text> <fullTs> [Unread]
        let preview: string | null = null;
        if (shortTsMatch && shortTsMatch.index !== undefined) {
          const afterShort = detailsClean.slice(shortTsMatch.index + shortTsMatch[0].length);
          const stop = fullTs ? afterShort.indexOf(fullTs) : -1;
          preview = (stop >= 0 ? afterShort.slice(0, stop) : afterShort)
            .replace(/\s*\.\s*$/, "")
            .replace(/^\s*\.\s*/, "")
            .trim() || null;
        }

        // Synthesize thread_id from the FIRST phone number in the contact display.
        // Voice's thread URL pattern is ?itemId=t.+<E164>. For US numbers (10 digits)
        // we prepend +1. Group threads have a UUID instead — those will be null here
        // and need click-based navigation.
        const firstPhone = (contact || "").match(/\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/)?.[0] ?? null;
        const phoneDigits = firstPhone ? firstPhone.replace(/\D/g, "") : null;
        const threadId = phoneDigits
          ? `t.+${phoneDigits.length === 10 ? "1" + phoneDigits : phoneDigits}`
          : null;

        return {
          thread_id: threadId,              // synthesized for direct ?itemId= navigation
          index: idx,
          contact: contact || null,
          last_activity: fullTs,            // ISO-style full timestamp
          last_activity_short: shortTs,     // Voice's short format ("Tue", "8:15 AM", etc.)
          preview,
          unread,
          raw: detailsClean.slice(0, 400),  // keep raw for fallback / debugging
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
    // Prefer direct thread URL when we have it. Voice uses ?itemId=<id>
    // where id is typically "t.+<E164phone>" (e.g. "t.+19097092452") for SMS
    // threads, or a UUID for group threads. Caller can pass either.
    if (args.thread_id) {
      const itemId = args.thread_id.startsWith("t.") ? args.thread_id : `t.${args.thread_id}`;
      await page.goto(
        `https://voice.google.com/messages?itemId=${encodeURIComponent(itemId)}`,
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

    // Voice's per-thread markup uses <gv-message-list> wrapping <gv-message-item>
    // entries inside a cdk-virtual-scroll-viewport. (Confirmed via diag dump:
    // custom_element_tags = gv-message-list, gv-message-item, gv-message-entry, ...)
    const messageSelector = "gv-message-item";
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

      // Voice's per-message text concats:
      //   "[date_hdr?] Message from [you|<phone>], <body>, <full_timestamp>. <icon> <body> <icon>"
      // The body appears twice (aria-label + visible). The full timestamp is
      // always "DAY, MONTH DD YYYY, HH:MM AM/PM".
      const tsRe = /(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\s+\d{4},?\s+\d{1,2}:\d{2}\s?(AM|PM)/i;
      // Lazy zero-or-more — must allow empty capture, since stripping the spelled-digit
      // run leaves inbound senders blank: "Message from , <body>".
      const fromRe = /Message from ([^,]*?),/;
      // Inbound messages are prefixed with a header like "(909) 709-2452 • Mar 4, 10:32 AM"
      // OR "(909) 709-2452 • Tue 3:01 PM" (relative dates this week) OR "• 8:24 AM" (today).
      // Match phone + bullet + arbitrary date/time text, stopping at "Message from".
      const inboundHeaderRe = /^(\(?\d{3}\)?\s*\d{3}[\s-]\d{4})\s*[•·][^]{1,80}?(?=Message from)/;

      for (const el of els.slice(0, args.max)) {
        let text = (el.innerText || el.textContent || "")
          .replace(/[‪‬‫‭‮]/g, "")
          .replace(/ | /g, " ")
          .replace(/(?<!\d)(?:\d\s){4,}\d/g, "")  // strip spelled-digit runs (screen-reader sequences)
          .replace(/\s+/g, " ")
          .trim();

        // Inbound messages have a leading "PHONE • DATE TIME " header — capture
        // the phone (the actual sender) and strip the header from the text.
        const inboundHeaderMatch = text.match(inboundHeaderRe);
        const inboundSenderPhone = inboundHeaderMatch?.[1] || null;
        if (inboundHeaderMatch) {
          text = text.slice(inboundHeaderMatch[0].length);
        }

        const fromMatch = text.match(fromRe);
        const fromText = (fromMatch?.[1] || "").trim();
        const direction = fromMatch
          ? (/^you$/i.test(fromText) ? "outbound" : "inbound")
          : (inboundSenderPhone ? "inbound" : null);

        const tsMatch = text.match(tsRe);
        const timestampText = tsMatch?.[0] || null;
        const tsParsed = timestampText ? Date.parse(timestampText) : NaN;
        const timestampIso = Number.isNaN(tsParsed) ? null : new Date(tsParsed).toISOString();

        // Body sits between "Message from X, " and the long timestamp.
        let body = "";
        if (fromMatch && fromMatch.index !== undefined) {
          const after = text.slice(fromMatch.index + fromMatch[0].length).trim();
          const stop = timestampText ? after.indexOf(timestampText) : -1;
          body = (stop >= 0 ? after.slice(0, stop) : after)
            .replace(/,\s*$/, "")
            .trim();
        } else {
          body = text;
        }

        // Detect non-emoji media: real images (alt non-empty AND not just emoji),
        // audio, video, or explicit attachment containers. Pure emoji messages are
        // text — Voice still wraps them in <img> for some platforms but with empty alt.
        const realMediaEl = el.querySelector(
          'img[alt]:not([alt=""]):not([alt~="emoji"]), video, audio, [class*="attachment"]:not([class*="media-icon"])'
        );
        const hasMedia = !!realMediaEl;

        const senderResolved = direction === "outbound" ? "you" : (inboundSenderPhone || fromText || null);

        out.push({
          direction,
          sender: senderResolved,
          timestamp_text: timestampText,
          timestamp_iso: timestampIso,
          body: body.slice(0, 4000),
          has_media: hasMedia,
        });
      }
      return out;
    }, { sel: messageSelector, max: maxMessages });

    const normalized = messages;

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

export async function voiceSendSms(args: {
  thread_id?: string;
  number?: string;
  body: string;
  force?: boolean;
  skip_verify?: boolean;
  manual_recipient?: boolean;
}): Promise<CallToolResult> {
  const body = (args.body ?? "").trim();
  if (!body) {
    return ok(JSON.stringify({ ok: false, error: "body is required" }, null, 2));
  }
  if (!args.thread_id && !args.number) {
    return ok(JSON.stringify({ ok: false, error: "Provide thread_id or number" }, null, 2));
  }

  const { browser, page } = await getVoicePage();

  try {
    // Navigate to thread (existing) or new-conversation page
    if (args.thread_id) {
      const itemId = args.thread_id.startsWith("t.") ? args.thread_id : `t.${args.thread_id}`;
      await page.goto(
        `https://voice.google.com/messages?itemId=${encodeURIComponent(itemId)}`,
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      );
    } else {
      await page.goto("https://voice.google.com/messages?action=new", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    await page.waitForTimeout(2500);

    const auth = await ensureSignedIn(page);
    if (!auth.ok) {
      return ok(JSON.stringify({
        ok: false,
        error: `unauthenticated: ${auth.reason}`,
        url: auth.url,
      }, null, 2));
    }

    // For new conversations: find the messages-pane "To"/recipient field,
    // type the number, click the dropdown option Voice surfaces, then wait
    // for a recipient chip to appear (proof the recipient committed).
    //
    // Critical: Voice has separate inputs for messages-recipient, calls-dial,
    // and search. The placeholder/phone hint matches the dial input, which
    // would call the number on Enter. Match the messages "To" field SPECIFICALLY
    // by aria-label, and never press Enter as fallback (Tab is safer).
    if (!args.thread_id && args.number) {
      // The visible recipient input on Voice's web UI lives in the right-side
      // dial-pad widget (`<gv-make-call-panel>`), which serves BOTH calls and
      // messages. Typing a number opens a dropdown with two options: "Call"
      // (default — Enter/Tab triggers it) and "Send message". We type into
      // that input, then click the message option explicitly. The "Send new
      // message" FAB / `?action=new` URL flips the route but doesn't render a
      // separate compose input — the dial pad IS the entry point.
      const fabClicked = false; // Vestigial, kept in debug payload for back-compat.
      const pickResult = await page.evaluate(() => {
        const isVisible = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
          'input[placeholder*="Enter a name" i], input#il1'
        )).filter(isVisible);

        const ancestry = (el: HTMLElement) => {
          const chain: string[] = [];
          let cur: HTMLElement | null = el;
          for (let i = 0; i < 12 && cur; i++) {
            const tag = cur.tagName.toLowerCase();
            const cls = (cur.getAttribute("class") || "").substring(0, 60);
            chain.push(`${tag}${cls ? `.${cls.replace(/\s+/g, ".")}` : ""}`);
            cur = cur.parentElement;
          }
          return chain;
        };

        // Tag each candidate with tokens from its ancestry chain
        const annotated = inputs.map((input, idx) => {
          const chain = ancestry(input);
          const chainStr = chain.join(" > ").toLowerCase();
          const isDial =
            /(\bdial\b|make-call|new-call|gv-call|click-to-call|phone-input|placeCall|call-widget|call-pane)/.test(chainStr);
          const isMessage =
            /(message|compose|new-conversation|recipient|conversation-input)/.test(chainStr);
          const r = input.getBoundingClientRect();
          // Mark the input so we can target it via Playwright
          input.setAttribute("data-mcp-pick", String(idx));
          return {
            idx,
            isDial,
            isMessage,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            chain,
          };
        });

        // Prefer message-flavored, then non-dial, then anything visible
        const messageMatch = annotated.find(a => a.isMessage && !a.isDial);
        const nonDial = annotated.find(a => !a.isDial);
        const picked = messageMatch ?? nonDial ?? annotated[0] ?? null;

        return {
          url: location.href,
          totalVisible: annotated.length,
          candidates: annotated,
          pickedIdx: picked?.idx ?? null,
        };
      });

      let recipientSel: string | null = null;
      if (pickResult.pickedIdx !== null) {
        recipientSel = `[data-mcp-pick="${pickResult.pickedIdx}"]`;
      }

      if (!recipientSel) {
        const debug = await page.evaluate(() => {
          const isVisible = (el: Element) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          return {
            url: location.href,
            dialog_open: !!document.querySelector('[role="dialog"], mat-dialog-container, gv-new-call'),
            overlay_panes: Array.from(document.querySelectorAll(".cdk-overlay-pane")).map(p => ({
              visible: isVisible(p),
              has_input: !!p.querySelector("input"),
              first_input_html: (p.querySelector("input") as HTMLInputElement | null)?.outerHTML.substring(0, 250) ?? null,
              outerHTML_head: (p as HTMLElement).outerHTML.substring(0, 200),
            })),
            il1_count: document.querySelectorAll("#il1").length,
            il1_visible_count: Array.from(document.querySelectorAll("#il1")).filter(isVisible).length,
            inputs: Array.from(document.querySelectorAll("input")).slice(0, 12).map(i => ({
              ariaLabel: i.getAttribute("aria-label"),
              placeholder: (i as HTMLInputElement).placeholder,
              role: i.getAttribute("role"),
              visible: isVisible(i),
              outerHTML: (i as HTMLInputElement).outerHTML.substring(0, 250),
            })),
            contenteditables: Array.from(document.querySelectorAll('[contenteditable="true"]')).slice(0, 6).map(t => ({
              ariaLabel: t.getAttribute("aria-label"),
              role: t.getAttribute("role"),
              visible: isVisible(t),
              outerHTML: (t as HTMLElement).outerHTML.substring(0, 250),
            })),
            comboboxes: Array.from(document.querySelectorAll('[role="combobox"]')).slice(0, 6).map(t => ({
              ariaLabel: t.getAttribute("aria-label"),
              visible: isVisible(t),
              outerHTML: (t as HTMLElement).outerHTML.substring(0, 250),
            })),
          };
        });
        return ok(JSON.stringify({
          ok: false,
          error: "Could not find messages-recipient input on /messages?action=new — none of the To/Send-to/recipient selectors matched",
          fab_clicked: fabClicked,
          pick_result: pickResult,
          debug,
        }, null, 2));
      }

      // Use the first VISIBLE match, not .first() (which may grab a hidden
      // Angular duplicate).
      const candidates = page.locator(recipientSel);
      const candidateCount = await candidates.count();
      let recipientLoc = candidates.first();
      for (let i = 0; i < candidateCount; i++) {
        const c = candidates.nth(i);
        if (await c.isVisible().catch(() => false)) {
          recipientLoc = c;
          break;
        }
      }

      // Voice opens an Angular Material contact-list overlay with a backdrop
      // (`cdk-overlay-backdrop contact-list-backdrop`) that intercepts pointer
      // events on the recipient input. Use `.focus()` directly — it bypasses
      // the pointer-event check entirely. Fall back to a forced click if focus
      // didn't take.
      try {
        await recipientLoc.focus({ timeout: 5000 });
      } catch {
        await recipientLoc.click({ force: true, timeout: 5000 });
      }
      await page.waitForTimeout(300);
      await page.keyboard.type(args.number, { delay: 20 });
      await page.waitForTimeout(2000);

      // The visible recipient input is `gv-make-call-panel` — Voice's
      // dial-pad widget that handles BOTH calls and messages. After typing
      // a number it shows a dropdown with two actions: "Call" and "Send a
      // message". Pressing Enter or Tab triggers Call (the default), which
      // is why earlier attempts dialed the number. We must explicitly click
      // the message option.
      //
      // Try a wide net of selectors — Voice has shipped this dropdown with
      // various role/text combinations. Capture all candidates for debug if
      // none match.
      const messageOptionLocators = [
        page.getByRole("menuitem", { name: /message/i }),
        page.getByRole("option", { name: /message/i }),
        page.getByRole("button", { name: /message/i }),
        page.locator('[aria-label*="message" i]:visible:has-text("message")'),
        page.locator('mat-option:has-text("message")'),
        page.locator(':is(li, [role="option"], [role="menuitem"], button):has-text("Send message")'),
        page.locator(':is(li, [role="option"], [role="menuitem"], button):has-text("Send a message")'),
      ];
      let messageClicked = false;
      for (const loc of messageOptionLocators) {
        const first = loc.first();
        if ((await first.count()) > 0 && await first.isVisible().catch(() => false)) {
          await first.click({ timeout: 5000 }).catch(() => {});
          messageClicked = true;
          break;
        }
      }

      if (!messageClicked) {
        // Capture every visible option/button with text so we can pinpoint
        // the right selector. NEVER fall back to Tab/Enter here — both
        // trigger Call on this input.
        const dropdownDebug = await page.evaluate(() => {
          const isVisible = (el: Element) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const sel = '[role="option"], [role="menuitem"], [role="button"], button, mat-option, li';
          return Array.from(document.querySelectorAll(sel))
            .filter(isVisible)
            .filter(el => {
              const t = (el as HTMLElement).innerText || "";
              return t.length > 0 && t.length < 80;
            })
            .slice(0, 30)
            .map(el => ({
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute("role"),
              ariaLabel: el.getAttribute("aria-label"),
              text: ((el as HTMLElement).innerText || "").trim().substring(0, 80),
              outerHTML_head: (el as HTMLElement).outerHTML.substring(0, 200),
            }));
        });
        return ok(JSON.stringify({
          ok: false,
          error: "Typed number but couldn't find the 'Send message' option in the dial-pad dropdown. Voice may have shipped new markup — see dropdown_debug to add a matching selector.",
          dropdown_debug: dropdownDebug,
          pick_result: pickResult,
        }, null, 2));
      }
      // Wait for compose to render. Clicking "Send a message" in the dial-pad
      // dropdown transitions to the messages compose dialog, which renders a
      // NEW empty "To" input. Voice does NOT auto-fill from the dial pad — we
      // have to retype the number into the compose To field and then click the
      // autocomplete option to commit a chip.
      await page.waitForTimeout(2500);

      const composeRecipient = await page.evaluate(() => {
        const isVisible = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        // Find inputs that look like a To/recipient: text inputs with
        // empty value, NOT inside the dial-pad widget, NOT search box.
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
          'input[type="text"], input:not([type])'
        )).filter(isVisible);

        const annotated = inputs.map((input, idx) => {
          const chain: string[] = [];
          let cur: HTMLElement | null = input;
          for (let i = 0; i < 12 && cur; i++) {
            chain.push(cur.tagName.toLowerCase());
            cur = cur.parentElement;
          }
          const chainStr = chain.join(" > ");
          const isDial = /gv-make-call-panel|gv-call-sidebar/.test(chainStr);
          const isSearch = (input.getAttribute("aria-label") || "")
            .toLowerCase()
            .includes("search");
          const r = input.getBoundingClientRect();
          input.setAttribute("data-mcp-pick2", String(idx));
          return {
            idx,
            isDial,
            isSearch,
            placeholder: input.placeholder,
            ariaLabel: input.getAttribute("aria-label"),
            value: input.value,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            chain,
          };
        });

        // The compose To field is the visible text input that is NOT the dial
        // pad and NOT search. Should be empty (no value yet).
        const composeInput = annotated.find(a => !a.isDial && !a.isSearch);
        return { candidates: annotated, pickedIdx: composeInput?.idx ?? null };
      });

      if (composeRecipient.pickedIdx === null) {
        return ok(JSON.stringify({
          ok: false,
          error: "Clicked 'Send a message' option but could not find the compose-dialog 'To' input afterwards. Compose may not have rendered.",
          stage: "post_message_option_click",
          compose_recipient_debug: composeRecipient,
          pick_result: pickResult,
        }, null, 2));
      }

      // Focus the compose To field, type the number, and click the autocomplete
      // option Voice surfaces (a contact card or "Send to <number>" tile).
      const composeToLoc = page.locator(`[data-mcp-pick2="${composeRecipient.pickedIdx}"]`);

      // Hoisted state used by the chip-verify failure-debug payload below.
      // Auto mode populates these; manual mode leaves them at defaults.
      let autocompleteClicked = false;
      let suggestionDebug: any = null;
      let nativeSetResult: { ok: boolean; valueAfter: string | null; reason?: string } = {
        ok: true,
        valueAfter: null,
      };

      // MANUAL MODE: pause and let the human commit the recipient chip
      // themselves. Useful for diagnosing a stuck picker — once the chip is
      // visible in the browser, press Enter in the calling terminal and the
      // script takes over to type the body and click Send.
      if (args.manual_recipient) {
        // Click into the field so the human knows where to type.
        await composeToLoc.click({ force: true, timeout: 5000 }).catch(() => {});
        process.stdout.write(
          "\n=== MANUAL MODE ===\n" +
          "Browser is open. Type/commit the recipient chip yourself in the compose To field.\n" +
          "Once you see the recipient chip rendered (number is in a pill, To input is empty),\n" +
          "press Enter in THIS terminal to continue with body + Send.\n" +
          "(Press Ctrl+C to abort.)\n> "
        );
        await new Promise<void>((resolve) => {
          process.stdin.resume();
          process.stdin.once("data", () => resolve());
        });
        process.stdout.write("Resuming — typing body and clicking Send...\n");
        // Skip the auto-commit logic below.
      } else {
        // Click first (not just focus) — Voice's gv-message-party-picker may
        // require a real pointer event to arm its input handlers.
        await composeToLoc.click({ force: true, timeout: 5000 }).catch(async () => {
          await composeToLoc.focus({ timeout: 5000 }).catch(() => {});
        });
        await page.waitForTimeout(500);

        // PASTE the number rather than typing keystrokes. Manual testing
        // (2026-05-01) showed Voice's `gv-message-party-picker` only renders
        // a "Send to <number>" suggestion tile when the input arrives via a
        // real paste event — typing keystrokes (slow OR fast) and native
        // value-setter both leave the input visually populated but the
        // picker never surfaces the tile. Clipboard paste with granted
        // permissions emits a trusted ClipboardEvent that the picker
        // listens for.
        await page.evaluate((num) => navigator.clipboard.writeText(num), args.number);
        await page.keyboard.press("Control+V");
        await page.waitForTimeout(500);

        const valueAfterType = await page.evaluate((sel) => {
          const input = document.querySelector(sel) as HTMLInputElement | null;
          return input ? input.value : null;
        }, `[data-mcp-pick2="${composeRecipient.pickedIdx}"]`);
        nativeSetResult = { ok: true, valueAfter: valueAfterType };

        // Poll for the "Send to <number>" suggestion tile. Voice's picker
        // surfaces it ~500-1500ms after the paste event. Match by visible
        // text starting with "Send to" — that's the gesture the user
        // confirmed works (clicking that tile commits a chip).
        const numDigitsForLookup = args.number.replace(/\D/g, "").slice(-10);
        for (let i = 0; i < 12; i++) {
          const found = await page.evaluate((last10) => {
            const isVisible = (el: Element) => {
              const r = (el as HTMLElement).getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            };
            const candidates: any[] = [];
            // Cast a wide net — Voice's tile may live inside a CDK overlay
            // pane, gv-contact-suggestion-list, or just a plain button.
            const all = document.querySelectorAll(
              'gv-contact-card, gv-contact-suggestion-list *, [role="option"], mat-option, button, [role="button"], li'
            );
            let pickEl: HTMLElement | null = null;
            for (const el of Array.from(all)) {
              if (!isVisible(el)) continue;
              const text = ((el as HTMLElement).innerText || "").trim();
              if (!text) continue;
              // Either: explicit "Send to" prefix, OR contains the number's
              // last 10 digits in any format.
              const digits = text.replace(/\D/g, "");
              const isSendToTile = /^send to\b/i.test(text);
              const containsNumber = digits.includes(last10);
              if (isSendToTile || containsNumber) {
                candidates.push({
                  tag: el.tagName.toLowerCase(),
                  text: text.substring(0, 80),
                });
                // Prefer the "Send to" tile over generic number-containing
                // elements — that's the explicit commit gesture.
                if (!pickEl || (isSendToTile && !/^send to\b/i.test(pickEl.innerText || ""))) {
                  pickEl = el as HTMLElement;
                }
              }
            }
            if (pickEl) pickEl.setAttribute("data-mcp-suggest", "1");
            return { candidates, picked: !!pickEl };
          }, numDigitsForLookup);

          if (found.picked) {
            await page.locator('[data-mcp-suggest="1"]').first().click({ timeout: 3000 }).catch(() => {});
            autocompleteClicked = true;
            suggestionDebug = found.candidates;
            break;
          }
          if (i === 11) suggestionDebug = found.candidates;
          await page.waitForTimeout(500);
        }
      } // close else (auto mode)
      await page.waitForTimeout(1500);

      // Verify a recipient chip / pill appeared. Voice renders chips with
      // formatted numbers like "(424) 466-3685" or "‪+1 424-466-3685‬", so
      // strip non-digits before comparing — substring match on the raw text
      // misses formatted variants.
      const numDigitsLast10 = args.number.replace(/\D/g, "").slice(-10);
      const chipExists = await page.evaluate((last10) => {
        const digits = (document.body.innerText || "").replace(/\D/g, "");
        return digits.includes(last10);
      }, numDigitsLast10).catch(() => false);

      if (!chipExists) {
        if (args.manual_recipient) {
          // In manual mode, trust the user — they already confirmed the chip
          // is committed before pressing Enter. Continue to body+send and let
          // the post-send verification be the source of truth.
          process.stdout.write(
            "WARNING: chip not detected via body-text scan, but manual mode " +
            "trusts the user. Continuing to body + Send.\n"
          );
        } else {
          const debug = await page.evaluate(() => ({
            url: location.href,
            body_preview: (document.body.innerText || "").substring(0, 1500),
          }));
          return ok(JSON.stringify({
            ok: false,
            error: "Compose To field accepted the number but no recipient chip committed.",
            stage: "compose_chip_verify",
            autocomplete_clicked: autocompleteClicked,
            native_set_result: nativeSetResult,
            suggestion_candidates_seen: suggestionDebug,
            debug: {
              recipient_selector_used: recipientSel,
              compose_recipient_debug: composeRecipient,
              pick_result: pickResult,
              ...debug,
            },
          }, null, 2));
        }
      }
    }

    // Pre-read: snapshot the last few message bodies so we can detect ours after send.
    const skipVerify = args.skip_verify === true;
    const beforeBodies: string[] = skipVerify ? [] : await page.evaluate(() =>
      Array.from(document.querySelectorAll("gv-message-item"))
        .slice(-6)
        .map(m => (m as HTMLElement).innerText.replace(/\s+/g, " ").trim())
    );

    // Find the compose field. Voice's compose is typically a contenteditable
    // div (not a textarea), so fill() doesn't always work — we have to click
    // to focus, then keyboard.type(). Selectors widen from "must mention
    // message" to any visible textbox in the thread region.
    const composeSelectors = [
      'div[contenteditable="true"][aria-label*="message" i]',
      'div[contenteditable="true"][role="textbox"]',
      'gv-thread-input [contenteditable="true"]',
      'gv-message-input [contenteditable="true"]',
      'textarea[aria-label*="message" i]',
      'textarea[placeholder*="message" i]',
      'input[aria-label*="message" i]',
      '[role="textbox"][aria-label*="message" i]',
      'gv-text-input-control textarea',
      '[contenteditable="true"]',
    ];
    let composeSel: string | null = null;
    for (const sel of composeSelectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && await loc.isVisible().catch(() => false)) {
        composeSel = sel;
        break;
      }
    }

    if (!composeSel) {
      const debug = await page.evaluate(() => ({
        url: location.href,
        textareas: Array.from(document.querySelectorAll("textarea")).map(t => ({
          ariaLabel: t.getAttribute("aria-label"),
          placeholder: t.placeholder,
          outerHTML: (t as HTMLTextAreaElement).outerHTML.substring(0, 300),
        })),
        textboxes: Array.from(document.querySelectorAll('[role="textbox"]')).slice(0, 5).map(t => ({
          ariaLabel: t.getAttribute("aria-label"),
          outerHTML: (t as HTMLElement).outerHTML.substring(0, 300),
        })),
        contenteditables: Array.from(document.querySelectorAll('[contenteditable="true"]')).slice(0, 5).map(t => ({
          ariaLabel: t.getAttribute("aria-label"),
          role: t.getAttribute("role"),
          outerHTML: (t as HTMLElement).outerHTML.substring(0, 300),
        })),
      }));
      return ok(JSON.stringify({
        ok: false,
        error: "Could not locate compose field",
        debug,
      }, null, 2));
    }

    // Focus to type. fill() doesn't reliably work on contenteditable divs —
    // keyboard.type with a small delay simulates real keypresses, which any
    // framework binding will respect.
    //
    // Use .focus() instead of .click() because Voice may have a residual
    // `cdk-overlay-backdrop contact-list-backdrop` over the page from the
    // recipient picker autocomplete — that backdrop intercepts pointer events
    // even after the chip is committed. Focus bypasses the pointer-event check.
    const compose = page.locator(composeSel).first();
    try {
      await compose.focus({ timeout: 5000 });
    } catch {
      await compose.click({ force: true, timeout: 5000 });
    }
    await page.waitForTimeout(400);

    const isContentEditable = await compose.evaluate(el =>
      (el as HTMLElement).isContentEditable === true
    ).catch(() => false);

    if (isContentEditable) {
      await page.keyboard.type(body, { delay: 15 });
    } else {
      await compose.fill(body);
    }
    await page.waitForTimeout(600);

    // Verify the body actually appeared in the compose. If not, dump debug
    // and bail BEFORE clicking Send (otherwise we'd send an empty message).
    const composeValue = await compose.evaluate(el => {
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea" || tag === "input") return (el as HTMLInputElement).value || "";
      return (el as HTMLElement).innerText || (el as HTMLElement).textContent || "";
    });
    const probeStart = body.substring(0, Math.min(20, body.length));
    if (!composeValue.includes(probeStart)) {
      return ok(JSON.stringify({
        ok: false,
        error: "Compose did not accept the body — value mismatch after type/fill",
        debug: {
          compose_selector: composeSel,
          compose_is_contenteditable: isContentEditable,
          compose_value_after_type: composeValue.substring(0, 200),
          target_body_prefix: probeStart,
          url: page.url(),
        },
      }, null, 2));
    }

    // Snapshot every Send-ish element so we can see what state Voice's UI
    // is in when we go to click. This catches cases where the button is
    // rendered but disabled (aria-disabled="true" or the matDisabled class).
    const sendStateBefore = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[aria-label*="Send" i], button:has(mat-icon)'))
        .slice(0, 12)
        .map(el => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return {
            tagName: el.tagName,
            ariaLabel: el.getAttribute("aria-label"),
            ariaDisabled: el.getAttribute("aria-disabled"),
            disabledAttr: (el as HTMLButtonElement).disabled,
            classList: (el.getAttribute("class") || "").substring(0, 120),
            visible: r.width > 0 && r.height > 0,
            outerHTML: (el as HTMLElement).outerHTML.substring(0, 250),
          };
        });
    });

    // MANUAL MODE: pause again so the user can verify body + chip + Send
    // button state is correct, and either let the script click Send or click
    // Send themselves.
    if (args.manual_recipient) {
      process.stdout.write(
        "\n=== MANUAL MODE — STAGE 2 ===\n" +
        "Body typed. About to click Send.\n" +
        "Send button state captured (see send_state_before in result if this fails).\n" +
        "Either click Send YOURSELF in the browser, OR let the script click it.\n" +
        "Press Enter in this terminal when ready (script will then click Send and verify).\n> "
      );
      await new Promise<void>((resolve) => {
        process.stdin.resume();
        process.stdin.once("data", () => resolve());
      });
    }

    // Find Send. Voice has TWO "Send"-flavored elements on the page:
    //   - `<div role="button" aria-label="Send new message">` — the FAB that
    //     opens a new compose dialog. Clicking this DOES NOT send anything;
    //     it just resets the compose pane.
    //   - `<button class="send-button" mattooltip="Send message">` — the
    //     actual Send button inside the compose dialog. THIS is what we want.
    //
    // Prefer the `.send-button` class (specific) over generic aria-label
    // matchers (which match the FAB first via DOM order).
    const sendButton = page.locator(
      'button.send-button:not([disabled]):not([aria-disabled="true"]):not(.mat-mdc-button-disabled), ' +
      'button[mattooltip*="Send message" i]:not([disabled]):not([aria-disabled="true"]):not(.mat-mdc-button-disabled), ' +
      'button[aria-label*="Send message" i]:not([disabled]):not([aria-disabled="true"]):not(.mat-mdc-button-disabled)'
    ).first();

    if ((await sendButton.count()) === 0) {
      return ok(JSON.stringify({
        ok: false,
        error: "Compose filled but no enabled Send button found",
        debug: { send_state_before: sendStateBefore, url: page.url() },
      }, null, 2));
    }

    // Send button can sit under the residual contact-list-backdrop — force
    // the click so the pointer-event check doesn't block it.
    await sendButton.click({ force: true, timeout: 10_000 });
    // Capture state immediately after the click so we can diagnose whether
    // Voice actually accepted the submission.
    await page.waitForTimeout(800);
    const sendStateAfter = await page.evaluate(() => ({
      url: location.href,
      urlChanged: !location.href.includes("?itemId=draft"),
      composeBodyValue: (() => {
        const ta = document.querySelector(".message-input, textarea[placeholder*='message' i]") as HTMLTextAreaElement | null;
        return ta?.value ?? null;
      })(),
    }));
    await page.waitForTimeout(1700);

    if (skipVerify) {
      return ok(JSON.stringify({
        ok: true,
        verified: false,
        message: "Send clicked (verification skipped)",
        url: page.url(),
      }, null, 2));
    }

    // Post-read: poll for up to 12s for a new message bubble whose body
    // contains the first ~50 chars of what we sent.
    const probe = body.substring(0, 50);
    const probeShort = body.substring(0, Math.min(20, body.length));
    let landed = false;
    let lastSnapshot: any = {};
    for (let i = 0; i < 24; i++) {
      const verify = await page.evaluate((shortProbe) => {
        const url = location.href;
        // Wider net: check several candidate message-bubble selectors plus
        // whole-body innerText. Voice's compose-after-send may render the
        // first message via a transient element name.
        const items = Array.from(document.querySelectorAll(
          'gv-message-item, gv-text-message-item, [role="article"], [aria-roledescription*="message" i]'
        )).slice(-8).map(m => (m as HTMLElement).innerText.replace(/\s+/g, " ").trim());
        const bodyText = (document.body.innerText || "").replace(/\s+/g, " ");
        const bodyHasProbe = bodyText.includes(shortProbe);
        return { url, items, bodyHasProbe, urlChanged: !url.includes("?itemId=draft") };
      }, probeShort);
      lastSnapshot = verify;
      const fresh = verify.items.filter((b: string) => !beforeBodies.includes(b));
      // Three signals that the send went through:
      // 1. A message bubble containing the body text
      // 2. The URL transitioned away from ?itemId=draft to a real thread
      // 3. The body text appears anywhere on the page in a fresh bubble
      if (fresh.some((b: string) => b.includes(probe)) ||
          (verify.urlChanged && verify.bodyHasProbe)) {
        landed = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    if (!landed) {
      return ok(JSON.stringify({
        ok: false,
        verified: false,
        error: "Send fired but the new message did not appear in the thread within 12s. " +
               "Check the recipient phone — the message may have actually been sent " +
               "(Voice's UI sometimes doesn't refresh draft view) or the Send click was a no-op.",
        before_count: beforeBodies.length,
        send_state_before: sendStateBefore,
        send_state_after: sendStateAfter,
        last_snapshot: lastSnapshot,
        url: page.url(),
      }, null, 2));
    }

    return ok(JSON.stringify({
      ok: true,
      verified: true,
      message: "Sent and verified in thread",
      url: page.url(),
    }, null, 2));
  } finally {
    await browser.close();
  }
}
