/**
 * Discovers ALL lessons for a given course by clicking through
 * all pages of the AJAX-driven course curriculum, then scrapes
 * all lessons and topic sub-pages not yet in index.json.
 *
 * Run: node scripts/discover-all-lessons.mjs --course <slug>
 *
 * Course slugs:
 *   field-property       → field-property-mastery
 *   coaching-calls       → beyond-90-coaching-calls
 *   xactimate            → xactimate-gold-training-suite
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

// Course config map: index slug → { courseUrlSlug, courseName }
const COURSE_CONFIG = {
  "field-property": {
    courseUrlSlug: "field-property-mastery",
    courseName: "Field Property Mastery",
  },
  "coaching-calls": {
    courseUrlSlug: "beyond-90-coaching-calls",
    courseName: "Beyond 90 Coaching Calls",
  },
  "xactimate": {
    courseUrlSlug: "xactimate-gold-training-suite",
    courseName: "Xactimate Gold Training Suite",
  },
  "independent-adjuster-resume": {
    courseUrlSlug: "building-a-6-figure-independent-adjuster-resume",
    courseName: "Building a 6-Figure Independent Adjuster Resume",
  },
  "residential-hail": {
    courseUrlSlug: "residential-hail-certification",
    courseName: "Residential Hail Certification",
  },
};

const courseArg = process.argv.includes("--course")
  ? process.argv[process.argv.indexOf("--course") + 1] : null;

if (!courseArg || !COURSE_CONFIG[courseArg]) {
  console.error(`Usage: node scripts/discover-all-lessons.mjs --course <slug>`);
  console.error(`Available: ${Object.keys(COURSE_CONFIG).join(", ")}`);
  process.exit(1);
}

const { courseUrlSlug, courseName } = COURSE_CONFIG[courseArg];
const COURSE_SLUG = courseArg;
const COURSE_URL = `https://adjuster-university.com/courses/${courseUrlSlug}/`;
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
    `**Course:** ${courseName}`,
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

// ── Setup ──────────────────────────────────────────────────────────────────────
ensureDir(COURSE_DIR);
ensureDir(path.join(OUTPUT_DIR, "downloads", COURSE_SLUG));

const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
let course = index.courses.find(c => c.slug === COURSE_SLUG);
if (!course) {
  console.log(`Course "${COURSE_SLUG}" not found in index — creating entry.`);
  course = { slug: COURSE_SLUG, name: courseName, lessons: [] };
  index.courses.push(course);
}

// Only count URLs that belong to THIS course's URL slug
const indexedUrls = new Set(
  course.lessons
    .map(l => l.url)
    .filter(u => u && u.includes(courseUrlSlug))
);
console.log(`Already indexed for ${courseUrlSlug}: ${indexedUrls.size} URLs`);

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
console.log(`\nNavigating to: ${COURSE_URL}`);
await page.goto(COURSE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);

for (let i = 0; i < 10; i++) {
  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(300);
}
await page.waitForTimeout(1000);

const collectLinks = async () => {
  return await page.evaluate((slug) => {
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      if (seen.has(href)) continue;
      seen.add(href);
      if (
        href.includes(slug) &&
        href.includes("/lessons/") &&
        !href.includes("/topic/") &&
        !href.includes("/quizzes/")
      ) {
        const text = a.textContent.trim().replace(/\s+/g, " ").trim();
        if (text.length > 0) links.push({ href, text });
      }
    }
    return links;
  }, courseUrlSlug);
};

const allLessonLinks = [];
const seenHrefs = new Set();
let pageNum = 1;

while (true) {
  const pageLinks = await collectLinks();
  let newCount = 0;
  for (const link of pageLinks) {
    if (!seenHrefs.has(link.href)) {
      seenHrefs.add(link.href);
      allLessonLinks.push(link);
      newCount++;
    }
  }
  console.log(`  Page ${pageNum}: ${pageLinks.length} links, ${newCount} new unique`);
  pageLinks.forEach(l => console.log(`    ${l.text}`));

  const nextBtn = page.locator('a.next[data-context="course_content_shortcode"]').first();
  const nextCount = await nextBtn.count();
  if (nextCount === 0) { console.log(`  No more pages.`); break; }
  const nextClass = await nextBtn.getAttribute("class").catch(() => "");
  if (nextClass.includes("disabled")) { console.log(`  Last page.`); break; }

  console.log(`  Clicking Next...`);
  await nextBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await nextBtn.click({ force: true });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1000);

  pageNum++;
  if (pageNum > 15) { console.log("  Safety limit: 15 pages max"); break; }
}

console.log(`\nTotal unique lessons discovered: ${allLessonLinks.length}`);
const newLessons = allLessonLinks.filter(l => !indexedUrls.has(l.href));
console.log(`  Already indexed: ${allLessonLinks.length - newLessons.length}`);
console.log(`  NEW: ${newLessons.length}`);

// ── Step 2: Scrape new lessons + find topics ───────────────────────────────────
const newEntries = [];
let scraped = 0, failed = 0, topicsScraped = 0, topicsFailed = 0;
let keepaliveCounter = 0;

for (const lessonLink of allLessonLinks) {
  if (scraped + topicsScraped >= MAX) break;

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
      const result = await scrapePage(page, browserContext, lessonLink.href, lessonLink.text);
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

  const ownTopics = topicLinks.filter(t => t.href.includes(courseUrlSlug));
  const newTopics = ownTopics.filter(t => !indexedUrls.has(t.href));
  if (ownTopics.length > 0) console.log(`  ${ownTopics.length} topic(s) — ${newTopics.length} new`);
  else if (!isNew) console.log(`  No topics`);

  for (const topic of ownTopics) {
    if (scraped + topicsScraped >= MAX) break;
    if (indexedUrls.has(topic.href)) { console.log(`    [SKIP] ${topic.text}`); continue; }

    const topicSlug = sanitize(topic.text) || `topic-${topicsScraped + 1}`;
    const fileName = `${lessonSlug}--${topicSlug}.md`;
    const filePath = path.join(COURSE_DIR, fileName);

    console.log(`    Scraping: ${topic.text}`);
    try {
      const result = await scrapePage(page, browserContext, topic.href, topic.text, lessonLink.text);
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
  course.lessons.push(...newEntries);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
  console.log(`\nIndex updated: ${newEntries.length} new entries added.`);
} else {
  console.log(`\nNo new entries.`);
}

await browser.close();

console.log(`\n${"=".repeat(60)}`);
console.log(`COMPLETE — ${COURSE_SLUG}`);
console.log(`New lessons: ${scraped} | New topics: ${topicsScraped} | Failures: ${failed + topicsFailed}`);
if (newEntries.length > 0) {
  console.log(`\nNext — run transcript scraper:`);
  console.log(`  node scripts/scrape-transcripts.mjs --course ${COURSE_SLUG}`);
}
