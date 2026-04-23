/**
 * Discovers and scrapes ALL missing Xactimate Gold Training Suite lessons and
 * their topic sub-pages. The main scraper missed the practical case study
 * sections (small losses, medium losses, large losses, etc.).
 *
 * This script:
 *   1. Navigates to the Xactimate course page and scrolls through the full curriculum
 *   2. Collects every lesson URL listed there
 *   3. For each lesson NOT yet in the index: scrapes it
 *   4. For each lesson (new or existing): visits it to discover /topic/ sub-pages
 *   5. Scrapes every topic page found
 *   6. Updates index.json with all new entries
 *
 * Run: node scripts/scrape-xactimate-topics.mjs
 *
 * Options:
 *   --max N    Stop after N topic pages (for testing)
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import https from "https";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/adjuster_university_session.json";
const OUTPUT_DIR = path.join(process.env.HOME, "Desktop/adjuster-university-content");
const INDEX_PATH = path.join(OUTPUT_DIR, "index.json");
const COURSE_URL = "https://adjuster-university.com/courses/xactimate-gold-training-suite/";
const COURSE_SLUG = "xactimate";
const COURSE_DIR = path.join(OUTPUT_DIR, "courses", COURSE_SLUG);

const MAX = process.argv.includes("--max")
  ? parseInt(process.argv[process.argv.indexOf("--max") + 1]) : Infinity;

const LOGIN_URL = process.env.ADJUSTER_UNIVERSITY_URL || "https://adjuster-university.com/access/";

async function reAuthenticate(page, browserContext) {
  console.log("  [AUTH] Session expired — re-authenticating...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.evaluate(({ email, password }) => {
    const emailField = document.querySelector('input[type="email"], input[name="email"], input[name="username"]');
    const passField = document.querySelector('input[type="password"], input[name="password"]');
    if (emailField) { emailField.value = email; emailField.dispatchEvent(new Event("input", { bubbles: true })); emailField.dispatchEvent(new Event("change", { bubbles: true })); }
    if (passField) { passField.value = password; passField.dispatchEvent(new Event("input", { bubbles: true })); passField.dispatchEvent(new Event("change", { bubbles: true })); }
  }, { email: process.env.ADJUSTER_UNIVERSITY_EMAIL, password: process.env.ADJUSTER_UNIVERSITY_PASSWORD });
  await page.waitForTimeout(500);
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"], button');
    if (btn) { btn.click(); return true; } return false;
  });
  if (!clicked) console.log("  [AUTH] Warning: could not find submit button");
  try {
    await page.waitForURL(u => !u.includes("/access") && !u.includes("/login"), { timeout: 30000 });
    console.log("  [AUTH] Re-authenticated successfully.");
  } catch {
    console.log("  [AUTH] Warning: URL did not change after login attempt");
  }
  const newCookies = await browserContext.cookies();
  fs.writeFileSync(SESSION_PATH, JSON.stringify({ cookies: newCookies, savedAt: new Date().toISOString() }, null, 2));
  return newCookies;
}

function sanitize(str) {
  return str.replace(/[^a-z0-9\-_ ]/gi, "").replace(/\s+/g, "-").toLowerCase().slice(0, 80);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function downloadFile(fileUrl, destPath, cookies) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath)) { resolve(destPath); return; }
    ensureDir(path.dirname(destPath));
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const req = https.get(fileUrl, {
      headers: {
        "Cookie": cookieHeader,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://adjuster-university.com/",
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadFile(res.headers.location, destPath, cookies).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on("finish", () => resolve(destPath));
      stream.on("error", reject);
    });
    req.on("error", reject);
  });
}

// ── Scrape a lesson or topic page ─────────────────────────────────────────────
async function scrapePage(page, browserContext, url, title, parentTitle = null, retried = false) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  const content = await page.evaluate(() => {
    document.querySelectorAll("nav, header, footer, aside, .sidebar, .navigation, script, style").forEach(el => el.remove());
    const containers = [
      ".learndash-topic-content", ".topic-content", ".learndash-lesson-content",
      ".lesson-content", ".content-body", "article", "main", "#content",
    ];
    for (const sel of containers) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 30) return el.innerText.trim();
    }
    return document.body.innerText.trim();
  });

  // Detect auth failure and retry once after re-login
  if (!retried && content.includes("You don't currently have access")) {
    console.log("  [AUTH] Access denied — refreshing session...");
    await reAuthenticate(page, browserContext);
    return scrapePage(page, browserContext, url, title, parentTitle, true);
  }

  const iframeData = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map(f => ({
      src: f.src,
      isVimeo: f.src.includes("player.vimeo.com") || f.src.includes("vimeo.com/video"),
      isYouTube: f.src.includes("youtube.com/embed") || f.src.includes("youtube-nocookie.com/embed"),
    })).filter(f => f.isVimeo || f.isYouTube)
  );

  const downloads = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/download/"], a[href$=".pdf"], a[href$=".zip"], a[href$=".docx"], a[href$=".xlsx"]'))
      .map(a => ({ href: a.href, text: a.innerText?.trim() || a.href.split("/").pop() }))
      .filter((v, i, arr) => arr.findIndex(x => x.href === v.href) === i)
  );

  // Find topic sub-pages linked from this lesson
  const topicLinks = await page.evaluate(() => {
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/topic/"]')) {
      if (!seen.has(a.href)) {
        seen.add(a.href);
        const text = a.textContent.trim().replace(/\s+/g, " ").trim();
        if (text.length > 0) links.push({ href: a.href, text });
      }
    }
    return links;
  });

  // Primary video info
  let videoProvider = null, videoId = null, embedSrc = null;
  if (iframeData.length > 0) {
    const first = iframeData[0];
    videoProvider = first.isVimeo ? "vimeo" : "youtube";
    const m = first.isVimeo
      ? first.src.match(/vimeo\.com\/(?:video\/)?(\d+)/)
      : first.src.match(/embed\/([^?&/]+)/);
    videoId = m?.[1] || null;
    embedSrc = first.src;
  }

  const videoSection = iframeData.length > 0 ? [
    "## Video",
    `Provider: ${videoProvider}`,
    videoId ? `ID: ${videoId}` : "",
    embedSrc ? `Embed: ${embedSrc}` : "",
    iframeData.length > 1 ? `Additional: ${iframeData.length - 1} more video(s) on this page` : "",
    "",
  ].filter(l => l !== "") : [];

  const attachSection = downloads.length > 0 ? [
    "## Attachments",
    ...downloads.map(d => `- [${d.text}](${d.href})`),
    "",
  ] : [];

  const md = [
    `# ${title}`,
    `**URL:** ${url}`,
    `**Course:** Xactimate Gold Training Suite`,
    parentTitle ? `**Lesson:** ${parentTitle}` : "",
    "",
    "## Content",
    "",
    content || "(No text content found)",
    "",
    ...videoSection,
    ...attachSection,
  ].filter(l => l !== null).join("\n");

  return {
    md, content, topicLinks, downloads,
    hasVideo: iframeData.length > 0,
    videoProvider, videoId, embedSrc,
    iframeCount: iframeData.length,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
ensureDir(COURSE_DIR);
ensureDir(path.join(OUTPUT_DIR, "downloads", COURSE_SLUG));

const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
const xactimateCourse = index.courses.find(c => c.slug === COURSE_SLUG);
if (!xactimateCourse) { console.error("Xactimate course not found in index"); process.exit(1); }

// Build set of URLs already in index
const indexedUrls = new Set(xactimateCourse.lessons.map(l => l.url).filter(Boolean));

const browser = await chromium.launch({ headless: false, slowMo: 50 });
const browserContext = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
});

let cookies = [];
if (fs.existsSync(SESSION_PATH)) {
  const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
  if (session.cookies?.length) {
    cookies = session.cookies;
    await browserContext.addCookies(cookies);
    console.log(`Restored ${cookies.length} session cookies.`);
  }
}

const page = await browserContext.newPage();

// ── Step 1: Discover all lessons from the course page ─────────────────────────
console.log(`\nNavigating to course page: ${COURSE_URL}`);
await page.goto(COURSE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);

// Scroll through the full course curriculum to trigger lazy-loading
console.log("Scrolling through full curriculum...");
let lastHeight = 0;
for (let i = 0; i < 20; i++) {
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(500);
  const newHeight = await page.evaluate(() => document.body.scrollHeight);
  if (newHeight === lastHeight) break;
  lastHeight = newHeight;
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(1000);

// Collect all lesson links from the course page
const allLessonLinks = await page.evaluate(() => {
  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    if (seen.has(href)) continue;
    seen.add(href);
    // Only lesson-level URLs from xactimate-gold-training-suite (not /topic/, not /quizzes/)
    if (
      href.includes("xactimate-gold-training-suite") &&
      href.includes("/lessons/") &&
      !href.includes("/topic/") &&
      !href.includes("/quizzes/")
    ) {
      const text = a.textContent.trim().replace(/\s+/g, " ").trim();
      if (text.length > 0) links.push({ href, text });
    }
  }
  return links;
});

console.log(`\nFound ${allLessonLinks.length} lesson links on course page.`);
const newLessonLinks = allLessonLinks.filter(l => !indexedUrls.has(l.href));
const existingLessonLinks = allLessonLinks.filter(l => indexedUrls.has(l.href));
console.log(`  Already in index: ${existingLessonLinks.length}`);
console.log(`  NEW (missing from index): ${newLessonLinks.length}`);
if (newLessonLinks.length > 0) {
  console.log("\nNew lessons to scrape:");
  newLessonLinks.forEach(l => console.log(`  ${l.text}`));
}

// ── Step 2: Scrape new lessons + discover topics in all lessons ───────────────
const newEntries = [];
let scraped = 0, failed = 0, topicsScraped = 0, topicsFailed = 0;
let keepaliveCounter = 0;

// Process ALL lesson links (new ones get full scrape, existing ones get topic check)
for (const lessonLink of allLessonLinks) {
  if (scraped + topicsScraped + failed + topicsFailed >= MAX) break;

  // Keepalive ping every 20 lessons to prevent session timeout
  keepaliveCounter++;
  if (keepaliveCounter % 20 === 0) {
    console.log(`  [KEEPALIVE] Pinging course page to maintain session...`);
    await page.goto(COURSE_URL, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  const isNew = !indexedUrls.has(lessonLink.href);
  const lessonSlug = sanitize(lessonLink.text) || `lesson-${scraped + 1}`;
  console.log(`\n${isNew ? "[NEW]" : "[CHECK]"} ${lessonLink.text}`);

  let topicLinks = [];

  try {
    if (isNew) {
      // Full scrape of new lesson
      const result = await scrapePage(page, browserContext, lessonLink.href, lessonLink.text);
      topicLinks = result.topicLinks;

      const fileName = `${lessonSlug}.md`;
      const filePath = path.join(COURSE_DIR, fileName);

      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, result.md, "utf8");
        console.log(`  Saved lesson (${result.iframeCount} video(s), ${result.downloads.length} dl(s))`);
      }

      // Download attachments
      for (const dl of result.downloads) {
        const ext = dl.href.match(/\.(zip|pdf|docx|xlsx)$/i)?.[0] || ".bin";
        const dlName = sanitize(dl.text || lessonSlug).slice(0, 60) + ext;
        const dlPath = path.join(OUTPUT_DIR, "downloads", COURSE_SLUG, dlName);
        try {
          await downloadFile(dl.href, dlPath, cookies);
        } catch { /* non-fatal */ }
      }

      newEntries.push({
        title: lessonLink.text,
        url: lessonLink.href,
        slug: lessonSlug,
        file: `courses/${COURSE_SLUG}/${fileName}`,
        hasVideo: result.hasVideo,
        videoProvider: result.videoProvider,
        hasTranscript: false,
        isTopic: false,
      });
      indexedUrls.add(lessonLink.href);
      scraped++;
    } else {
      // Existing lesson — just visit to find topic links
      await page.goto(lessonLink.href, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(2000);
      topicLinks = await page.evaluate(() => {
        const links = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href*="/topic/"]')) {
          if (!seen.has(a.href)) {
            seen.add(a.href);
            const text = a.textContent.trim().replace(/\s+/g, " ").trim();
            if (text.length > 0) links.push({ href: a.href, text });
          }
        }
        return links;
      });
    }
  } catch (e) {
    console.log(`  ERROR loading lesson: ${e.message}`);
    failed++;
    continue;
  }

  if (topicLinks.length === 0) {
    console.log(`  No topics found`);
    continue;
  }

  const newTopics = topicLinks.filter(t => !indexedUrls.has(t.href));
  console.log(`  ${topicLinks.length} topic(s) found — ${newTopics.length} new`);

  // Scrape each new topic
  for (const topic of topicLinks) {
    if (scraped + topicsScraped + failed + topicsFailed >= MAX) break;
    if (indexedUrls.has(topic.href)) {
      console.log(`    [SKIP] Already indexed: ${topic.text}`);
      continue;
    }

    const topicSlug = sanitize(topic.text) || `topic-${topicsScraped + 1}`;
    const fileName = `${lessonSlug}--${topicSlug}.md`;
    const filePath = path.join(COURSE_DIR, fileName);

    console.log(`    Scraping topic: ${topic.text}`);

    try {
      const result = await scrapePage(page, browserContext, topic.href, topic.text, lessonLink.text);

      fs.writeFileSync(filePath, result.md, "utf8");
      console.log(`      ✓ Saved (${result.iframeCount} video(s), ${result.downloads.length} dl(s)) → ${fileName}`);

      // Download attachments
      for (const dl of result.downloads) {
        const ext = dl.href.match(/\.(zip|pdf|docx|xlsx)$/i)?.[0] || ".bin";
        const dlName = sanitize(dl.text || topicSlug).slice(0, 60) + ext;
        const dlPath = path.join(OUTPUT_DIR, "downloads", COURSE_SLUG, dlName);
        try {
          await downloadFile(dl.href, dlPath, cookies);
          console.log(`      Downloaded: ${dlName}`);
        } catch (e) {
          console.log(`      Download failed: ${e.message}`);
        }
      }

      newEntries.push({
        title: topic.text,
        url: topic.href,
        slug: topicSlug,
        file: `courses/${COURSE_SLUG}/${fileName}`,
        parentLesson: lessonLink.text,
        parentUrl: lessonLink.href,
        hasVideo: result.hasVideo,
        videoProvider: result.videoProvider,
        hasTranscript: false,
        isTopic: true,
      });
      indexedUrls.add(topic.href);
      topicsScraped++;
    } catch (e) {
      console.log(`      ERROR: ${e.message}`);
      topicsFailed++;
    }

    await page.waitForTimeout(600);
  }
}

// ── Update index ──────────────────────────────────────────────────────────────
if (newEntries.length > 0) {
  xactimateCourse.lessons.push(...newEntries);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
  console.log(`\nIndex updated: ${newEntries.length} new entries added.`);
}

await browser.close();

console.log(`\n${"=".repeat(60)}`);
console.log(`COMPLETE`);
console.log(`New lessons scraped: ${scraped}`);
console.log(`New topics scraped:  ${topicsScraped}`);
console.log(`Failures: ${failed + topicsFailed}`);
if (newEntries.length > 0) {
  console.log(`\nNext — run transcript scraper on new content:`);
  console.log(`  node scripts/scrape-transcripts.mjs --course xactimate`);
}
