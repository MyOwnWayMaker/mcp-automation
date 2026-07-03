/**
 * Scrape Professor Cornelius Ward's TradingView profile using his cookies.
 * Outputs:
 *   ~/CornyWardTradingView/profile.json
 *   ~/CornyWardTradingView/ideas/<slug>.md  (one per chart idea)
 *   ~/CornyWardTradingView/indicators/<slug>.md  (one per published indicator)
 *   ~/CornyWardTradingView/_index.json
 *
 * Cookies are read from a Netscape-format file (the same kind "Get
 * cookies.txt LOCALLY" exports). We translate to Playwright cookie format
 * and load into a context so the scraper appears as Hakiel's logged-in
 * session — gives access to any subscriber-gated content.
 *
 * Run:
 *   node scripts/scrape-ward-tradingview.mjs
 *
 * Optional env:
 *   TV_COOKIES_PATH       Path to Netscape cookies.txt (default:
 *                         ~/Downloads/www.tradingview.com_cookies.txt)
 *   TV_OUT_DIR            Output directory (default: ~/CornyWardTradingView)
 *   TV_PROFILE_URL        Override profile URL (default:
 *                         https://www.tradingview.com/u/ProfessorCEWard/)
 *   TV_MAX_IDEAS          Cap on ideas to scrape (default: unlimited)
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const COOKIES_PATH = process.env.TV_COOKIES_PATH
  ?? path.join(HOME, "Downloads", "www.tradingview.com_cookies.txt");
const OUT = process.env.TV_OUT_DIR ?? path.join(HOME, "CornyWardTradingView");
const PROFILE_URL = process.env.TV_PROFILE_URL ?? "https://www.tradingview.com/u/ProfessorCEWard/";
const MAX_IDEAS = parseInt(process.env.TV_MAX_IDEAS || "0", 10) || Infinity;

const IDEAS_DIR = path.join(OUT, "ideas");
const INDICATORS_DIR = path.join(OUT, "indicators");
const VIDEOS_DIR = path.join(OUT, "videos");
fs.mkdirSync(IDEAS_DIR, { recursive: true });
fs.mkdirSync(INDICATORS_DIR, { recursive: true });
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// ── Netscape cookies.txt → Playwright cookie objects ─────────────────────
// Each non-comment line: domain \t flag \t path \t secure \t expires \t name \t value
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
      name,
      value,
      domain,
      path: p,
      expires: expires === "0" ? -1 : parseInt(expires, 10),
      httpOnly: false,
      secure: secure.toUpperCase() === "TRUE",
      sameSite: "Lax",
    });
  }
  return out;
}

function slugify(s) {
  return (s || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function writeMd(dir, slug, frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const md = `---\n${fm}\n---\n\n${body || "(no body)"}\n`;
  fs.writeFileSync(path.join(dir, `${slug}.md`), md);
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`[scrape-tv] cookies: ${COOKIES_PATH}`);
console.log(`[scrape-tv] output:  ${OUT}`);
console.log(`[scrape-tv] profile: ${PROFILE_URL}`);

const cookies = readNetscapeCookies(COOKIES_PATH);
console.log(`[scrape-tv] loaded ${cookies.length} cookies`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1440, height: 900 },
});
await context.addCookies(cookies);
const page = await context.newPage();

// ── Profile page ──────────────────────────────────────────────────────────
console.log("\n[scrape-tv] → profile page");
await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

const loggedIn = await page.evaluate(() => {
  // TradingView shows "Sign in" if not authenticated. If we see a sign-in
  // anywhere in the chrome, we're not logged in.
  const bodyText = (document.body.innerText || "").slice(0, 5000).toLowerCase();
  return !/^sign in$/m.test(bodyText) && !bodyText.includes("sign in to tradingview");
});
console.log(`[scrape-tv] logged in? ${loggedIn}`);

const profileData = await page.evaluate(() => {
  const trim = (s) => (s || "").replace(/\s+/g, " ").trim();
  const text = (sel) => trim(document.querySelector(sel)?.textContent);
  return {
    url: location.href,
    title: text("h1") || document.title,
    bodyText: trim((document.body.innerText || "").slice(0, 5000)),
    metaDescription: document.querySelector('meta[name="description"]')?.content || "",
  };
});
fs.writeFileSync(path.join(OUT, "profile.json"), JSON.stringify(profileData, null, 2));
fs.writeFileSync(path.join(OUT, "profile.md"),
  `---\nurl: ${JSON.stringify(profileData.url)}\ntitle: ${JSON.stringify(profileData.title)}\n---\n\n` +
  `${profileData.bodyText}\n`);
console.log(`[scrape-tv] saved profile.md (${profileData.bodyText.length} chars)`);

// ── Ideas (chart analyses) ────────────────────────────────────────────────
// TradingView profile tab "Ideas" URL: /u/ProfessorCEWard/#published-charts
console.log("\n[scrape-tv] → ideas list");
const ideasUrl = `${PROFILE_URL.replace(/\/$/, "")}/#published-charts`;
await page.goto(ideasUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);

// Auto-scroll to load all ideas (TradingView lazy-loads on scroll).
for (let i = 0; i < 30; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
}

const ideaLinks = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('a[href*="/chart/"]'))
    .map((a) => ({ href: a.href, title: (a.innerText || "").trim().slice(0, 200) }))
    .filter((x) => /\/chart\/[^/]+\/[A-Za-z0-9]/.test(x.href));
});
const uniqIdeas = Array.from(new Map(ideaLinks.map((i) => [i.href, i])).values()).slice(0, MAX_IDEAS);
console.log(`[scrape-tv] found ${uniqIdeas.length} unique idea URLs`);
fs.writeFileSync(path.join(OUT, "_idea-urls.json"), JSON.stringify(uniqIdeas, null, 2));

// Visit each idea page and grab body
let ideaIndex = 0;
for (const idea of uniqIdeas) {
  ideaIndex++;
  console.log(`[scrape-tv]   [${ideaIndex}/${uniqIdeas.length}] ${idea.href}`);
  try {
    await page.goto(idea.href, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    const data = await page.evaluate(() => {
      const trim = (s) => (s || "").replace(/\s+/g, " ").trim();
      // Idea title usually in h1
      const title = trim(document.querySelector("h1")?.textContent);
      // Chart symbol — look for breadcrumb / nav text
      const symbol = trim(document.querySelector('a[href*="/symbols/"]')?.textContent);
      // Body — main idea description. TradingView uses various class names.
      // Fallback: grab everything in main minus chrome.
      const main = document.querySelector("main") || document.body;
      const bodyText = (main.innerText || "").slice(0, 20000);
      const dateTime = document.querySelector("time")?.dateTime || "";
      const tags = Array.from(document.querySelectorAll('a[href*="/tags/"]'))
        .map((a) => trim(a.textContent))
        .filter(Boolean);
      return { title, symbol, dateTime, tags, bodyText: trim(bodyText) };
    });
    const slug = slugify(data.title || idea.title || idea.href.split("/").filter(Boolean).pop());
    writeMd(IDEAS_DIR, `${ideaIndex.toString().padStart(3, "0")}-${slug}`, {
      url: idea.href,
      title: data.title,
      symbol: data.symbol,
      date: data.dateTime,
      tags: data.tags,
    }, data.bodyText);
  } catch (e) {
    console.error(`    error: ${e?.message || e}`);
  }
}

// ── Indicators / Scripts ──────────────────────────────────────────────────
console.log("\n[scrape-tv] → indicators list");
const scriptsUrl = `${PROFILE_URL.replace(/\/$/, "")}/#published-scripts`;
await page.goto(scriptsUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);
for (let i = 0; i < 15; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
}

const scriptLinks = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('a[href*="/script/"]'))
    .map((a) => ({ href: a.href, title: (a.innerText || "").trim().slice(0, 200) }))
    .filter((x) => /\/script\//.test(x.href));
});
const uniqScripts = Array.from(new Map(scriptLinks.map((s) => [s.href, s])).values());
console.log(`[scrape-tv] found ${uniqScripts.length} unique indicator URLs`);
fs.writeFileSync(path.join(OUT, "_script-urls.json"), JSON.stringify(uniqScripts, null, 2));

let scriptIndex = 0;
for (const sc of uniqScripts) {
  scriptIndex++;
  console.log(`[scrape-tv]   [${scriptIndex}/${uniqScripts.length}] ${sc.href}`);
  try {
    await page.goto(sc.href, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    const data = await page.evaluate(() => {
      const trim = (s) => (s || "").replace(/\s+/g, " ").trim();
      const title = trim(document.querySelector("h1")?.textContent);
      const main = document.querySelector("main") || document.body;
      const bodyText = (main.innerText || "").slice(0, 30000);
      return { title, bodyText: trim(bodyText) };
    });
    const slug = slugify(data.title || sc.title || sc.href.split("/").filter(Boolean).pop());
    writeMd(INDICATORS_DIR, `${scriptIndex.toString().padStart(3, "0")}-${slug}`, {
      url: sc.href,
      title: data.title,
    }, data.bodyText);
  } catch (e) {
    console.error(`    error: ${e?.message || e}`);
  }
}

// ── Videos ────────────────────────────────────────────────────────────────
console.log("\n[scrape-tv] → videos tab");
const videosUrl = `${PROFILE_URL.replace(/\/$/, "")}/#videos`;
try {
  await page.goto(videosUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);
  const videosData = await page.evaluate(() => {
    const trim = (s) => (s || "").replace(/\s+/g, " ").trim();
    const links = Array.from(document.querySelectorAll('a[href*="/v/"]'))
      .map((a) => ({ href: a.href, title: trim(a.innerText) }));
    return { links };
  });
  fs.writeFileSync(path.join(VIDEOS_DIR, "_video-list.json"), JSON.stringify(videosData, null, 2));
  console.log(`[scrape-tv] found ${videosData.links.length} video links`);
} catch (e) {
  console.error(`[scrape-tv] videos tab failed: ${e?.message || e}`);
}

// ── Index ─────────────────────────────────────────────────────────────────
const summary = {
  scrapedAt: new Date().toISOString(),
  profileUrl: PROFILE_URL,
  loggedIn,
  ideasCount: uniqIdeas.length,
  indicatorsCount: uniqScripts.length,
};
fs.writeFileSync(path.join(OUT, "_index.json"), JSON.stringify(summary, null, 2));

await browser.close();
console.log("\n[scrape-tv] ✅ done");
console.log(JSON.stringify(summary, null, 2));
