/**
 * Aggressive full scrape of all ~446 ideas from ProfessorCEWard's TradingView
 * profile. Uses Playwright to navigate the paginated ideas list and walk
 * every page until none remain.
 *
 * Strategy: load /u/ProfessorCEWard/#published-charts, scroll exhaustively
 * (scroll → wait → check count growth → repeat until stable for N rounds).
 * On stable-count termination, try the explicit pagination URL
 * /u/<user>/ideas/page-N/ to pick up older pages the lazy-load skipped.
 *
 * Dedupes against any existing files in ~/CornyWardTradingView/ideas/.
 * New ideas go in numbered 050+.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const COOKIES_PATH = path.join(HOME, "Downloads", "www.tradingview.com_cookies.txt");
const OUT = path.join(HOME, "CornyWardTradingView");
const IDEAS_DIR = path.join(OUT, "ideas");
const PROFILE_URL = "https://www.tradingview.com/u/ProfessorCEWard/";

fs.mkdirSync(IDEAS_DIR, { recursive: true });

function readNetscapeCookies(file) {
  const raw = fs.readFileSync(file, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domain, _flag, p, secure, expires, name, value] = parts;
    out.push({
      name, value, domain, path: p,
      expires: expires === "0" ? -1 : parseInt(expires, 10),
      httpOnly: false, secure: secure.toUpperCase() === "TRUE", sameSite: "Lax",
    });
  }
  return out;
}

function slugify(s) {
  return (s || "untitled").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

// Build the set of URLs we already have from the prior scrape.
const haveUrls = new Set();
const haveSlugs = new Set();
for (const f of fs.readdirSync(IDEAS_DIR)) {
  if (!f.endsWith(".md")) continue;
  const content = fs.readFileSync(path.join(IDEAS_DIR, f), "utf8");
  const m = content.match(/^url:\s*"([^"]+)"/m);
  if (m) {
    const baseUrl = m[1].split("#")[0].replace(/\/$/, "");
    haveUrls.add(baseUrl);
  }
  haveSlugs.add(f.replace(/^\d+-/, "").replace(/\.md$/, ""));
}
console.log(`[scrape-full] starting with ${haveUrls.size} existing idea URLs in cache`);

const cookies = readNetscapeCookies(COOKIES_PATH);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1440, height: 900 },
});
await context.addCookies(cookies);
const page = await context.newPage();

// ── Aggressive scroll on /u/<user>/#published-charts ──────────────────────
console.log("[scrape-full] → profile, aggressive scroll for ideas");
await page.goto(`${PROFILE_URL}#published-charts`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);

const allUrlsByPage = new Set();
let stableRounds = 0;
let prevCount = 0;
for (let i = 0; i < 200; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1800);
  // Also scroll the main content area in case body isn't the scrolling element
  await page.evaluate(() => {
    const main = document.querySelector('main, [data-name="ideas-feed"], .tv-idea-feed');
    if (main) main.scrollTo?.(0, main.scrollHeight);
  });
  await page.waitForTimeout(700);
  const current = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="/chart/"]'))
      .map(a => a.href.split("#")[0].replace(/\/$/, ""))
      .filter(h => /\/chart\/[^/]+\/[A-Za-z0-9]/.test(h));
  });
  current.forEach(u => allUrlsByPage.add(u));
  if (allUrlsByPage.size === prevCount) {
    stableRounds++;
    if (stableRounds >= 8) {
      console.log(`[scrape-full]   stable at ${allUrlsByPage.size} after ${i + 1} scrolls`);
      break;
    }
  } else {
    stableRounds = 0;
    prevCount = allUrlsByPage.size;
  }
  if ((i + 1) % 10 === 0) {
    console.log(`[scrape-full]   scroll ${i + 1}: ${allUrlsByPage.size} unique URLs`);
  }
}

// ── Also try TradingView's explicit pagination URLs ──────────────────────
// /u/<user>/ideas/page-N/ — try pages 1..30 (covers up to ~600 ideas).
console.log("\n[scrape-full] → /u/.../ideas/page-N/ pagination sweep");
for (let p = 1; p <= 30; p++) {
  const pageUrl = `${PROFILE_URL}ideas/page-${p}/`;
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    const beforeCount = allUrlsByPage.size;
    const pageUrls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="/chart/"]'))
        .map(a => a.href.split("#")[0].replace(/\/$/, ""))
        .filter(h => /\/chart\/[^/]+\/[A-Za-z0-9]/.test(h));
    });
    pageUrls.forEach(u => allUrlsByPage.add(u));
    const added = allUrlsByPage.size - beforeCount;
    console.log(`[scrape-full]   page ${p}: +${added} new (total: ${allUrlsByPage.size})`);
    if (added === 0 && p > 3) break;
  } catch (e) {
    console.log(`[scrape-full]   page ${p}: failed (${e.message?.slice(0, 50)})`);
    if (p > 3) break;
  }
}

const allUrls = Array.from(allUrlsByPage);
console.log(`\n[scrape-full] total unique idea URLs found: ${allUrls.length}`);
fs.writeFileSync(path.join(OUT, "_all-idea-urls.json"), JSON.stringify(allUrls.sort(), null, 2));

const toScrape = allUrls.filter(u => !haveUrls.has(u));
console.log(`[scrape-full] new (not already scraped): ${toScrape.length}`);

// ── Visit each new idea and scrape body ─────────────────────────────────
let scrapedCount = 0;
let startIdx = 50; // continue numbering after the existing 49
for (const url of toScrape) {
  scrapedCount++;
  if (scrapedCount % 20 === 0) {
    console.log(`[scrape-full]   [${scrapedCount}/${toScrape.length}] ${url}`);
  }
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2200);
    const data = await page.evaluate(() => {
      const trim = (s) => (s || "").replace(/\s+/g, " ").trim();
      const title = trim(document.querySelector("h1")?.textContent);
      // Find symbol — first chart-pair link, not the Apple chrome one
      const symLinks = Array.from(document.querySelectorAll('a[href*="/symbols/"]'))
        .map(a => trim(a.textContent))
        .filter(t => t && !["Apple Inc"].includes(t));
      const symbol = symLinks[0] || "";
      // Date — TradingView shows "Mon DD, YYYY" or "Mon DD" in the article
      const dateText = trim(document.querySelector("time")?.textContent) ||
                       trim(document.querySelector('[class*="date"]')?.textContent);
      const main = document.querySelector("main") || document.body;
      const bodyText = (main.innerText || "").slice(0, 20000);
      return { title, symbol, dateText, bodyText: trim(bodyText) };
    });
    const slug = slugify(data.title || url.split("/").filter(Boolean).pop());
    const filename = `${(startIdx + scrapedCount).toString().padStart(3, "0")}-${slug}.md`;
    const fm = [
      `url: ${JSON.stringify(url)}`,
      `title: ${JSON.stringify(data.title)}`,
      `symbol: ${JSON.stringify(data.symbol)}`,
      `date: ${JSON.stringify(data.dateText)}`,
    ].join("\n");
    fs.writeFileSync(path.join(IDEAS_DIR, filename),
      `---\n${fm}\n---\n\n${data.bodyText || "(no body)"}\n`);
  } catch (e) {
    console.error(`    error: ${e?.message?.slice(0, 100)}`);
  }
}

await browser.close();
console.log(`\n[scrape-full] ✅ done. Added ${scrapedCount} new ideas. Total now: ${haveUrls.size + scrapedCount}`);
