/**
 * Discovers ALL Xactimate Gold Training Suite lessons by clicking through
 * all 5 pages of the AJAX-driven course curriculum (100 lessons total, 20 per page).
 * Then scrapes all lessons and their topic sub-pages not yet in index.json.
 *
 * Run: node scripts/discover-practical-lessons.mjs
 *
 * Options:
 *   --max N    Stop after N scraped items (for testing)
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
const COURSE_SLUG = "xactimate";
const COURSE_DIR = path.join(OUTPUT_DIR, "courses", COURSE_SLUG);
const COURSE_URL = "https://adjuster-university.com/courses/xactimate-gold-training-suite/";

const MAX = process.argv.includes("--max")
  ? parseInt(process.argv[process.argv.indexOf("--max") + 1]) : Infinity;

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

async function scrapePage(page, url, title, parentTitle = null) {
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
    iframeData.length > 1 ? `Additional: ${iframeData.length - 1} more video(s)` : "",
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

// ── Helper: collect lesson links currently visible on course page ───────────────
async function collectCurrentPageLinks(page) {
  return await page.evaluate(() => {
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      if (seen.has(href)) continue;
      seen.add(href);
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
}

// ── Setup ──────────────────────────────────────────────────────────────────────
ensureDir(COURSE_DIR);
ensureDir(path.join(OUTPUT_DIR, "downloads", COURSE_SLUG));

const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
const xactimateCourse = index.courses.find(c => c.slug === COURSE_SLUG);
if (!xactimateCourse) { console.error("Xactimate course not found in index"); process.exit(1); }

// Only count URLs that belong to xactimate-gold-training-suite
const indexedUrls = new Set(
  xactimateCourse.lessons
    .map(l => l.url)
    .filter(u => u && u.includes("xactimate-gold-training-suite"))
);
console.log(`Already indexed for xactimate-gold-training-suite: ${indexedUrls.size} URLs`);

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

// ── Step 1: Navigate to course page and click through all pagination pages ─────
console.log(`\nNavigating to course page: ${COURSE_URL}`);
await page.goto(COURSE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);

// Scroll to load curriculum
for (let i = 0; i < 10; i++) {
  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(300);
}
await page.waitForTimeout(1000);

const allLessonLinks = [];
const seenHrefs = new Set();
let currentPageNum = 1;

while (true) {
  const pageLinks = await collectCurrentPageLinks(page);
  let newCount = 0;
  for (const link of pageLinks) {
    if (!seenHrefs.has(link.href)) {
      seenHrefs.add(link.href);
      allLessonLinks.push(link);
      newCount++;
    }
  }
  console.log(`  Page ${currentPageNum}: ${pageLinks.length} links found, ${newCount} new unique`);
  pageLinks.forEach(l => console.log(`    ${l.text}`));

  // Try to find and click the Next button for the FIRST pagination block (course_id 5391)
  const nextBtn = page.locator('a.next[data-context="course_content_shortcode"]').first();
  const nextCount = await nextBtn.count();
  const isDisabled = nextCount > 0 && await nextBtn.getAttribute("disabled").catch(() => null);

  if (nextCount === 0 || isDisabled !== null) {
    console.log(`  No more pages (page ${currentPageNum} is last).`);
    break;
  }

  // Check if button is actually "disabled" by class
  const nextClass = await nextBtn.getAttribute("class").catch(() => "");
  if (nextClass.includes("disabled")) {
    console.log(`  Next button is disabled — last page.`);
    break;
  }

  console.log(`  Clicking Next...`);
  await nextBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await nextBtn.click({ force: true });
  await page.waitForTimeout(3000);

  // Scroll after AJAX load
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1000);

  currentPageNum++;
  if (currentPageNum > 10) {
    console.log("  Safety limit: 10 pages max");
    break;
  }
}

console.log(`\nTotal unique lesson links discovered: ${allLessonLinks.length}`);
const newLessonLinks = allLessonLinks.filter(l => !indexedUrls.has(l.href));
console.log(`  Already in index: ${allLessonLinks.length - newLessonLinks.length}`);
console.log(`  NEW (missing from index): ${newLessonLinks.length}`);
if (newLessonLinks.length > 0) {
  console.log("\nNew lessons to scrape:");
  newLessonLinks.forEach(l => console.log(`  ${l.text} → ${l.href}`));
}

// ── Step 2: Scrape new lessons + discover topics in all lessons ────────────────
const newEntries = [];
let scraped = 0, failed = 0, topicsScraped = 0, topicsFailed = 0;

for (const lessonLink of allLessonLinks) {
  if (scraped + topicsScraped >= MAX) break;

  const isNew = !indexedUrls.has(lessonLink.href);
  const lessonSlug = sanitize(lessonLink.text) || `lesson-${scraped + 1}`;
  console.log(`\n${isNew ? "[NEW]" : "[CHECK]"} ${lessonLink.text}`);

  let topicLinks = [];

  try {
    if (isNew) {
      const result = await scrapePage(page, lessonLink.href, lessonLink.text);
      topicLinks = result.topicLinks;

      const fileName = `${lessonSlug}.md`;
      const filePath = path.join(COURSE_DIR, fileName);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, result.md, "utf8");
        console.log(`  Saved: ${fileName} (${result.iframeCount} videos, ${result.downloads.length} downloads)`);
      }

      for (const dl of result.downloads) {
        const ext = dl.href.match(/\.(zip|pdf|docx|xlsx)$/i)?.[0] || ".bin";
        const dlName = sanitize(dl.text || lessonSlug).slice(0, 60) + ext;
        const dlPath = path.join(OUTPUT_DIR, "downloads", COURSE_SLUG, dlName);
        try { await downloadFile(dl.href, dlPath, cookies); } catch { /* non-fatal */ }
      }

      newEntries.push({
        title: lessonLink.text,
        url: lessonLink.href,
        slug: lessonSlug,
        file: `courses/${COURSE_SLUG}/${lessonSlug}.md`,
        hasVideo: result.hasVideo,
        videoProvider: result.videoProvider,
        hasTranscript: false,
        isTopic: false,
      });
      indexedUrls.add(lessonLink.href);
      scraped++;
    } else {
      // Existing lesson — visit to find topics
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
    console.log(`  ERROR: ${e.message}`);
    failed++;
    continue;
  }

  // Only process topics belonging to xactimate-gold-training-suite
  const xactTopics = topicLinks.filter(t => t.href.includes("xactimate-gold-training-suite"));
  const newTopics = xactTopics.filter(t => !indexedUrls.has(t.href));
  if (xactTopics.length > 0) {
    console.log(`  ${xactTopics.length} topic(s) — ${newTopics.length} new`);
  } else if (!isNew) {
    console.log(`  No topics`);
  }

  for (const topic of xactTopics) {
    if (scraped + topicsScraped >= MAX) break;
    if (indexedUrls.has(topic.href)) {
      console.log(`    [SKIP] ${topic.text}`);
      continue;
    }

    const topicSlug = sanitize(topic.text) || `topic-${topicsScraped + 1}`;
    const fileName = `${lessonSlug}--${topicSlug}.md`;
    const filePath = path.join(COURSE_DIR, fileName);

    console.log(`    Scraping: ${topic.text}`);
    try {
      const result = await scrapePage(page, topic.href, topic.text, lessonLink.text);
      fs.writeFileSync(filePath, result.md, "utf8");
      console.log(`      Saved: ${fileName} (${result.iframeCount} video(s), ${result.downloads.length} dl(s))`);

      for (const dl of result.downloads) {
        const ext = dl.href.match(/\.(zip|pdf|docx|xlsx)$/i)?.[0] || ".bin";
        const dlName = sanitize(dl.text || topicSlug).slice(0, 60) + ext;
        const dlPath = path.join(OUTPUT_DIR, "downloads", COURSE_SLUG, dlName);
        try { await downloadFile(dl.href, dlPath, cookies); } catch { /* non-fatal */ }
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

// ── Update index ───────────────────────────────────────────────────────────────
if (newEntries.length > 0) {
  xactimateCourse.lessons.push(...newEntries);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
  console.log(`\nIndex updated: ${newEntries.length} new entries added.`);
} else {
  console.log(`\nNo new entries to add.`);
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
