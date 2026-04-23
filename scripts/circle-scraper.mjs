/**
 * Circle.so community scraper — Adjuster University community.
 * Member-only access via Playwright browser automation (no API key needed).
 *
 * Modes:
 *   --historical     Scrape ALL historical posts + comments (run once)
 *   --monitor        Check for NEW posts since last run (run on schedule)
 *   --dry-run        List spaces only, do not scrape posts
 *   --max-posts N    Stop after N posts (for testing)
 *
 * Run from Mac Terminal:
 *   node /Users/hakielmcqueen/mcp-automation/scripts/circle-scraper.mjs --historical
 *   node /Users/hakielmcqueen/mcp-automation/scripts/circle-scraper.mjs --monitor
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/circle_session.json";
const STATE_PATH = "/Users/hakielmcqueen/mcp-automation/circle_state.json";
const OUTPUT_DIR = path.join(process.env.HOME, "Desktop/circle-content");
const COMMUNITY_URL = process.env.CIRCLE_COMMUNITY_URL || "https://adjuster-university.circle.so";
const EMAIL = process.env.CIRCLE_EMAIL;
const PASSWORD = process.env.CIRCLE_PASSWORD;

const IS_HISTORICAL = process.argv.includes("--historical");
const IS_MONITOR = process.argv.includes("--monitor");
const DRY_RUN = process.argv.includes("--dry-run");
const MAX_POSTS = process.argv.includes("--max-posts")
  ? parseInt(process.argv[process.argv.indexOf("--max-posts") + 1])
  : Infinity;

if (!IS_HISTORICAL && !IS_MONITOR && !DRY_RUN) {
  console.log("Usage: node circle-scraper.mjs [--historical | --monitor | --dry-run] [--max-posts N]");
  process.exit(1);
}
if (!EMAIL || !PASSWORD) {
  console.error("Missing CIRCLE_EMAIL or CIRCLE_PASSWORD in .env");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitize(str) {
  return (str || "").replace(/[^a-z0-9\-_ ]/gi, "").replace(/\s+/g, "-").toLowerCase().slice(0, 80);
}
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function writeFile(p, c) { ensureDir(path.dirname(p)); fs.writeFileSync(p, c, "utf8"); }

function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  return { lastRunAt: null, scrapedPostUrls: [], repliedPostUrls: [] };
}
function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }

// ── Login + restore session ───────────────────────────────────────────────────
async function loginAndSaveSession(context) {
  const page = await context.newPage();
  console.log("Logging in to Circle.so...");
  await page.goto(`${COMMUNITY_URL}/sign_in`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  try {
    await page.fill('input[name="email"], input[type="email"]', EMAIL);
    await page.fill('input[name="password"], input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    console.log("Credentials submitted.");
  } catch {
    console.log("Auto-fill failed. Please log in manually.");
  }

  try {
    await page.waitForURL(url => !url.href.includes("/sign_in") && !url.href.includes("/login"), { timeout: 30000 });
    console.log("Logged in. URL:", page.url());
  } catch {
    console.log("Could not confirm login. Continuing with current session.");
  }

  await page.waitForTimeout(2000);
  const cookies = await context.cookies();
  const localStorage = await page.evaluate(() => {
    const d = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      d[k] = window.localStorage.getItem(k);
    }
    return d;
  });
  fs.writeFileSync(SESSION_PATH, JSON.stringify({ cookies, localStorage, savedAt: new Date().toISOString() }, null, 2));
  console.log("Session saved.");
  await page.close();
}

async function restoreSession(context) {
  if (!fs.existsSync(SESSION_PATH)) return false;
  const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
  if (session.cookies?.length) await context.addCookies(session.cookies);
  return true;
}

// ── Space discovery ───────────────────────────────────────────────────────────
async function discoverSpaces(page) {
  // Already on COMMUNITY_URL — just wait for React to hydrate
  await page.waitForTimeout(4000);

  // Scroll sidebar to trigger lazy-loaded nav items
  await page.evaluate(() => {
    const sidebar = document.querySelector("nav, aside, [class*='sidebar'], [class*='Sidebar'], [class*='navigation']");
    if (sidebar) sidebar.scrollTop = sidebar.scrollHeight;
  });
  await page.waitForTimeout(1000);

  const spaces = await page.evaluate((communityUrl) => {
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      const text = (a.textContent || a.innerText || "").trim();
      if (!text || text.length < 2) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      // Circle.so space patterns (various URL structures observed):
      // /c/space-slug, /spaces/slug, /community/slug, direct subpaths on custom domains
      const isSpace =
        href.match(/\/c\/[^\/\?#]+$/) ||
        href.match(/\/spaces\/[^\/\?#]+/) ||
        (href.startsWith(communityUrl) &&
          !href.includes("/posts/") &&
          !href.includes("/sign") &&
          !href.includes("/settings") &&
          !href.includes("/notifications") &&
          !href.includes("/members") &&
          !href.includes("/search") &&
          href !== communityUrl &&
          href !== communityUrl + "/");

      if (isSpace) {
        links.push({
          href: href.startsWith("http") ? href : communityUrl + href,
          text,
        });
      }
    }
    return links;
  }, COMMUNITY_URL);

  // Deduplicate by href
  const seen = new Set();
  return spaces.filter(s => {
    if (seen.has(s.href)) return false;
    seen.add(s.href);
    return true;
  });
}

// ── Scrape posts in a space ───────────────────────────────────────────────────
async function scrapePostsInSpace(page, spaceUrl, maxPosts = Infinity) {
  const posts = [];
  await page.goto(spaceUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  let loadMore = true;
  let attempts = 0;
  const maxScrolls = 50;

  while (loadMore && posts.length < maxPosts && attempts < maxScrolls) {
    attempts++;

    // Collect post links on current page view
    const newLinks = await page.evaluate((communityUrl) => {
      const links = [];
      const seen = new Set();
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.href;
        const text = a.textContent.trim();
        if (seen.has(href)) continue;
        seen.add(href);
        // Circle post URLs: /c/space/posts/post-id or /posts/post-id
        if (href.match(/\/posts\/\d+/) && text.length > 0) {
          links.push({ href: href.startsWith("http") ? href : communityUrl + href, text });
        }
      }
      return links;
    }, COMMUNITY_URL);

    for (const link of newLinks) {
      if (!posts.find(p => p.href === link.href)) {
        posts.push(link);
      }
    }

    // Try to scroll or click "Load more"
    const loadMoreBtn = await page.$('button:has-text("Load more"), a:has-text("Load more"), [data-testid="load-more"]');
    if (loadMoreBtn) {
      await loadMoreBtn.click();
      await page.waitForTimeout(2000);
    } else {
      // Scroll to bottom
      const prevHeight = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight === prevHeight) loadMore = false;
    }
  }

  return posts.slice(0, maxPosts);
}

// ── Scrape a single post + all comments ──────────────────────────────────────
async function scrapePost(page, postUrl) {
  await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Expand all comments by clicking "Load more" comment buttons
  let loadMoreComments = true;
  let iterations = 0;
  while (loadMoreComments && iterations < 20) {
    iterations++;
    const btn = await page.$('button:has-text("Load more comments"), button:has-text("Show more"), [data-testid="load-more-comments"]');
    if (btn) {
      await btn.click();
      await page.waitForTimeout(1500);
    } else {
      loadMoreComments = false;
    }
  }

  return await page.evaluate(() => {
    // Post title
    const title = (
      document.querySelector("h1, .post-title, [data-testid='post-title']")?.textContent?.trim() ||
      document.title || "Untitled Post"
    );

    // Post author + date
    const authorEl = document.querySelector(".post-author, .author-name, [data-testid='post-author']");
    const dateEl = document.querySelector("time, .post-date, [data-testid='post-date']");
    const author = authorEl?.textContent?.trim() || "Unknown";
    const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim() || "";

    // Post body
    const bodyEl = document.querySelector(".post-body, .trix-content, .content-body, article .content, [data-testid='post-body']");
    const body = bodyEl?.innerText?.trim() || "";

    // Comments
    const commentEls = document.querySelectorAll(".comment, [data-testid='comment'], .reply, .discussion-comment");
    const comments = Array.from(commentEls).map(el => {
      const cAuthor = el.querySelector(".author-name, .comment-author")?.textContent?.trim() || "";
      const cDate = el.querySelector("time")?.getAttribute("datetime") || el.querySelector("time")?.textContent?.trim() || "";
      const cBody = el.querySelector(".comment-body, .trix-content, .content")?.innerText?.trim() || el.innerText?.trim() || "";
      return { author: cAuthor, date: cDate, body: cBody };
    });

    // Check for embedded video
    const vimeoFrame = document.querySelector('iframe[src*="vimeo"]');
    const wistiaEl = document.querySelector('.wistia_embed, [class*="wistia_async"]');
    const ytFrame = document.querySelector('iframe[src*="youtube"]');
    let video = null;
    if (vimeoFrame) video = { provider: "vimeo", src: vimeoFrame.src };
    else if (wistiaEl) video = { provider: "wistia", className: wistiaEl.className };
    else if (ytFrame) video = { provider: "youtube", src: ytFrame.src };

    return { title, author, date, body, comments, video, url: window.location.href };
  });
}

// ── Format post as markdown ───────────────────────────────────────────────────
function postToMarkdown(post) {
  const lines = [
    `# ${post.title}`,
    `**Author:** ${post.author}  **Date:** ${post.date}`,
    `**URL:** ${post.url}`,
    "",
    "## Post",
    "",
    post.body || "(no content)",
    "",
  ];

  if (post.comments.length > 0) {
    lines.push(`## Comments (${post.comments.length})`);
    lines.push("");
    for (const c of post.comments) {
      lines.push(`### ${c.author} — ${c.date}`);
      lines.push(c.body || "(empty)");
      lines.push("");
    }
  }

  if (post.video) {
    lines.push("## Embedded Video");
    lines.push(`Provider: ${post.video.provider}`);
    lines.push(post.video.src || post.video.className || "");
    lines.push("");
  }

  return lines.join("\n");
}

// ── Entry point ───────────────────────────────────────────────────────────────

ensureDir(OUTPUT_DIR);
const state = loadState();

const browser = await chromium.launch({
  headless: false,
  slowMo: 100,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
  locale: "en-US",
  timezoneId: "America/New_York",
});

// Hide webdriver flag
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

const sessionRestored = await restoreSession(context);
const page = await context.newPage();

// Verify session is valid — wait longer for React hydration
await page.goto(COMMUNITY_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(5000);
const currentUrl = page.url();
const needsLogin = currentUrl.includes("/sign_in") || currentUrl.includes("/login");
const isCloudflare = (await page.title()).toLowerCase().includes("moment") ||
  (await page.content()).includes("Verifying you are human");

if (isCloudflare) {
  console.log("⚠️  Cloudflare challenge detected. Please complete it in the browser window.");
  console.log("    Waiting up to 60 seconds for you to pass it...");
  try {
    await page.waitForFunction(
      () => !document.title.toLowerCase().includes("moment") && !document.body.innerText.includes("Verifying you are human"),
      { timeout: 60000 }
    );
    await page.waitForTimeout(3000);
    console.log("    Cloudflare passed. Continuing...");
  } catch {
    console.log("    Cloudflare timeout — saving whatever session we have.");
  }
}

if (needsLogin || !sessionRestored) {
  console.log("Session expired or missing — logging in...");
  await loginAndSaveSession(context);
  await page.goto(COMMUNITY_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);
}

// Always save updated cookies (captures cf_clearance from Cloudflare)
const freshCookies = await context.cookies();
const savedSession = fs.existsSync(SESSION_PATH)
  ? JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"))
  : {};
fs.writeFileSync(SESSION_PATH, JSON.stringify({ ...savedSession, cookies: freshCookies, savedAt: new Date().toISOString() }, null, 2));

console.log("Logged in. Community URL:", page.url());

// Dump logged-in page for inspection (always, not just on failure)
writeFile(path.join(OUTPUT_DIR, "debug-loggedin.html"), await page.content());
console.log("Debug HTML saved to debug-loggedin.html");

// ── Discover spaces ───────────────────────────────────────────────────────────
const spaces = await discoverSpaces(page);
console.log(`\nDiscovered ${spaces.length} spaces:`);
spaces.forEach((s, i) => console.log(`  ${i + 1}. ${s.text} → ${s.href}`));

if (spaces.length === 0) {
  console.log("\nNo spaces found. Check ~/Desktop/circle-content/debug-loggedin.html to inspect the page.");
  await browser.close();
  process.exit(0);
}

if (DRY_RUN) {
  console.log("\n[DRY RUN] Space list complete. Remove --dry-run to scrape posts.");
  await browser.close();
  process.exit(0);
}

// ── Historical or monitor mode ────────────────────────────────────────────────
let totalPosts = 0;
const newPostsForReview = []; // For monitor mode: questions to potentially auto-reply

for (const space of spaces) {
  if (totalPosts >= MAX_POSTS) break;

  const spaceSlug = sanitize(space.text);
  const spaceDir = path.join(OUTPUT_DIR, "spaces", spaceSlug);
  ensureDir(spaceDir);

  console.log(`\n${"─".repeat(50)}\nSpace: ${space.text}`);

  const postLinks = await scrapePostsInSpace(page, space.href, MAX_POSTS - totalPosts);
  console.log(`  ${postLinks.length} posts found.`);

  for (const postLink of postLinks) {
    if (totalPosts >= MAX_POSTS) break;

    // In monitor mode, skip already-scraped posts
    if (IS_MONITOR && state.scrapedPostUrls.includes(postLink.href)) {
      continue;
    }

    totalPosts++;
    console.log(`  [${totalPosts}] ${postLink.text.slice(0, 60)}`);

    try {
      const post = await scrapePost(page, postLink.href);
      const postSlug = sanitize(post.title) || `post-${totalPosts}`;
      const outPath = path.join(spaceDir, `${postSlug}.md`);
      writeFile(outPath, postToMarkdown(post));
      console.log(`    Saved (${post.comments.length} comments)`);

      state.scrapedPostUrls.push(postLink.href);

      // Flag questions for monitor mode review
      if (IS_MONITOR) {
        const isQuestion = post.title.includes("?") || post.body.includes("?");
        if (isQuestion) {
          newPostsForReview.push({ title: post.title, url: postLink.href, body: post.body.slice(0, 500) });
        }
      }
    } catch (e) {
      console.log(`    ERROR: ${e.message}`);
    }

    await page.waitForTimeout(800);
  }
}

// ── Save state + summary ──────────────────────────────────────────────────────
state.lastRunAt = new Date().toISOString();
saveState(state);

if (IS_MONITOR && newPostsForReview.length > 0) {
  const reviewPath = path.join(OUTPUT_DIR, "pending-replies.json");
  let pending = [];
  if (fs.existsSync(reviewPath)) pending = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  pending.push(...newPostsForReview);
  fs.writeFileSync(reviewPath, JSON.stringify(pending, null, 2));
  console.log(`\n${newPostsForReview.length} new question(s) added to pending-replies.json`);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`CIRCLE SCRAPE COMPLETE`);
console.log(`Mode: ${IS_HISTORICAL ? "historical" : "monitor"}`);
console.log(`Posts scraped: ${totalPosts}`);
console.log(`Output: ${OUTPUT_DIR}`);

await page.waitForTimeout(1000);
await browser.close();
