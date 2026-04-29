/**
 * Diagnostic: open Voice headed, wait for threads to render visually,
 * then deep-inspect the DOM (including shadow roots and iframes) to find
 * where the thread elements actually live. Writes a findings report to
 * scripts/diag-voice-dom-output.txt.
 *
 * Run from repo root:
 *   $env:VOICE_HEADLESS = "false"; node scripts/diag-voice-dom.mjs
 *
 * Watch the browser window. Once you see your threads in the inbox,
 * the script will start inspecting and exit ~10 seconds later.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SESSION_PATH = path.join(REPO_ROOT, "voice_session.json");
const OUT_PATH = path.join(REPO_ROOT, "scripts", "diag-voice-dom-output.txt");

const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));

const browser = await chromium.launch({
  headless: false,
  slowMo: 50,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
});
const context = await browser.newContext({
  storageState: session.storageState,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
});
const page = await context.newPage();

console.log("Opening Voice (headed). Watch the browser window.");
await page.goto("https://voice.google.com/u/0/messages", { waitUntil: "domcontentloaded", timeout: 30_000 });

console.log("Waiting 25 seconds for threads to render visually...");
await page.waitForTimeout(25_000);
console.log("Inspecting DOM now (don't close the window — script will close it)...");

// Deep inspect: walk all shadow roots, list iframes, find thread-like markers.
const findings = await page.evaluate(() => {
  const out = {};

  // 1. Iframes
  const iframes = Array.from(document.querySelectorAll("iframe"));
  out.iframes = iframes.map(f => ({ src: f.src, name: f.name, id: f.id }));

  // 2. Top-level anchor count (no shadow piercing)
  out.top_level = {
    a_total: document.querySelectorAll("a").length,
    a_to_messages_t: document.querySelectorAll('a[href*="/messages/t/"]').length,
    role_listitem: document.querySelectorAll('[role="listitem"]').length,
    role_list: document.querySelectorAll('[role="list"]').length,
    gv_thread_item: document.querySelectorAll("gv-thread-item").length,
    custom_elements: Array.from(new Set(
      Array.from(document.querySelectorAll("*"))
        .map(el => el.tagName.toLowerCase())
        .filter(t => t.includes("-"))
    )).slice(0, 60),
  };

  // 3. Recursive shadow DOM walk
  const allShadowHosts = [];
  function walkShadow(root, depth = 0) {
    if (depth > 8) return;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        allShadowHosts.push({
          tag: el.tagName.toLowerCase(),
          shadow_anchors: el.shadowRoot.querySelectorAll('a[href*="/messages/t/"]').length,
          shadow_listitems: el.shadowRoot.querySelectorAll('[role="listitem"]').length,
        });
        walkShadow(el.shadowRoot, depth + 1);
      }
    }
  }
  walkShadow(document, 0);
  out.shadow_hosts = allShadowHosts.filter(h => h.shadow_anchors > 0 || h.shadow_listitems > 0).slice(0, 30);
  out.total_shadow_hosts_with_threads = allShadowHosts.filter(h => h.shadow_anchors > 0 || h.shadow_listitems > 0).length;
  out.total_shadow_hosts = allShadowHosts.length;

  // 4. Deep text-content search for any element containing common thread markers
  const allElements = Array.from(document.querySelectorAll("*"));
  const phoneRe = /\(\d{3}\)\s*\d{3}[-\s]\d{4}/;
  const matchingByText = [];
  for (const el of allElements.slice(0, 5000)) {
    const txt = el.textContent || "";
    if (txt.length > 200) continue; // skip whole containers
    if (phoneRe.test(txt) || /^[A-Z][a-z]+\s+[A-Z][a-z]+/.test(txt.trim().split("\n")[0] || "")) {
      matchingByText.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className?.toString().slice(0, 80) || "",
        role: el.getAttribute("role") || "",
        text: txt.trim().slice(0, 100),
      });
      if (matchingByText.length >= 15) break;
    }
  }
  out.text_matches_top10 = matchingByText;

  return out;
});

const report = JSON.stringify(findings, null, 2);
fs.writeFileSync(OUT_PATH, report);
console.log(`\n─── Findings (also saved to ${OUT_PATH}) ───`);
console.log(report);
console.log("─── End ───\n");

await browser.close();
