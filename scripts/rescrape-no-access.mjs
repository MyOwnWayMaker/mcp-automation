/**
 * Re-scrapes all lesson/topic files that contain "You don't currently have access"
 * — meaning the original scrape ran with an expired session and got no content.
 *
 * This script:
 *   1. Scans all course files for "no access" content
 *   2. Looks up each file's URL from index.json
 *   3. Re-scrapes each one with a fresh authenticated session
 *   4. Overwrites the file with real content
 *   5. Updates index.json hasVideo/videoProvider if they changed
 *
 * Auto-detects session expiry mid-run and re-authenticates automatically.
 *
 * Run: node scripts/rescrape-no-access.mjs
 * Options:
 *   --course xactimate    Only fix one course
 *   --max N               Stop after N pages (for testing)
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/adjuster_university_session.json";
const OUTPUT_DIR = path.join(process.env.HOME, "Desktop/adjuster-university-content");
const INDEX_PATH = path.join(OUTPUT_DIR, "index.json");
const LOGIN_URL = process.env.ADJUSTER_UNIVERSITY_URL || "https://adjuster-university.com/access/";

const FILTER_COURSE = process.argv.includes("--course")
  ? process.argv[process.argv.indexOf("--course") + 1] : null;
const MAX = process.argv.includes("--max")
  ? parseInt(process.argv[process.argv.indexOf("--max") + 1]) : Infinity;

function sanitize(str) {
  return str.replace(/[^a-z0-9\-_ ]/gi, "").replace(/\s+/g, "-").toLowerCase().slice(0, 80);
}

async function reAuthenticate(page, browserContext) {
  console.log("\n[AUTH] Session expired — re-authenticating...");
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
  if (!clicked) console.log("[AUTH] Warning: could not find submit button");
  try {
    await page.waitForURL(u => !u.includes("/access") && !u.includes("/login"), { timeout: 30000 });
    console.log("[AUTH] Re-authenticated successfully.\n");
  } catch {
    console.log("[AUTH] Warning: URL did not change after login attempt\n");
  }
  const newCookies = await browserContext.cookies();
  fs.writeFileSync(SESSION_PATH, JSON.stringify({ cookies: newCookies, savedAt: new Date().toISOString() }, null, 2));
  return newCookies;
}

async function scrapePage(page, browserContext, url, title, courseName, parentTitle = null, retried = false) {
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

  // Detect auth failure and retry once
  if (!retried && content.includes("You don't currently have access")) {
    await reAuthenticate(page, browserContext);
    return scrapePage(page, browserContext, url, title, courseName, parentTitle, true);
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
    md, content, hasVideo: iframeData.length > 0,
    videoProvider, videoId, iframeCount: iframeData.length,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));

// Build a map from file path → lesson entry (for updating index)
const fileToLesson = new Map();
for (const course of index.courses) {
  for (const lesson of course.lessons) {
    if (lesson.file) fileToLesson.set(lesson.file, { lesson, course });
  }
}

// Find all files with "no access" content
console.log("Scanning for files with auth failures...");
const toFix = [];
for (const course of index.courses) {
  if (FILTER_COURSE && course.slug !== FILTER_COURSE) continue;
  const courseDir = path.join(OUTPUT_DIR, "courses", course.slug);
  if (!fs.existsSync(courseDir)) continue;

  for (const lesson of course.lessons) {
    if (!lesson.file || !lesson.url) continue;
    const filePath = path.join(OUTPUT_DIR, lesson.file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    if (content.includes("You don't currently have access")) {
      toFix.push({
        lesson,
        course,
        filePath,
        courseName: course.title || course.name || course.slug,
      });
    }
  }
}

console.log(`Found ${toFix.length} files with auth failures.`);
if (toFix.length === 0) {
  console.log("Nothing to fix!");
  process.exit(0);
}

if (FILTER_COURSE) {
  console.log(`Filtered to course: ${FILTER_COURSE}`);
}

const browser = await chromium.launch({ headless: false, slowMo: 50 });
const browserContext = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
});

if (fs.existsSync(SESSION_PATH)) {
  const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
  if (session.cookies?.length) {
    await browserContext.addCookies(session.cookies);
    console.log(`Restored ${session.cookies.length} session cookies.`);
  }
}

const page = await browserContext.newPage();
let fixed = 0, failed = 0;

for (let i = 0; i < Math.min(toFix.length, MAX); i++) {
  const { lesson, course, filePath, courseName } = toFix[i];

  // Keepalive every 20 lessons
  if (i > 0 && i % 20 === 0) {
    const courseUrl = lesson.url.split("/lessons/")[0] + "/";
    console.log(`  [KEEPALIVE] Pinging course page...`);
    await page.goto(courseUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  console.log(`\n[${i + 1}/${Math.min(toFix.length, MAX)}] ${lesson.title}`);
  console.log(`  URL: ${lesson.url}`);

  try {
    const result = await scrapePage(
      page, browserContext,
      lesson.url, lesson.title, courseName,
      lesson.parentLesson || null
    );

    // Preserve any existing transcript section if one was captured before
    const existing = fs.readFileSync(filePath, "utf8");
    let newMd = result.md;
    if (existing.includes("## Video Transcript")) {
      const transcriptMatch = existing.match(/## Video Transcript[\s\S]*?(?=\n##|$)/);
      if (transcriptMatch) {
        newMd = newMd.includes("## Attachments")
          ? newMd.replace("## Attachments", `${transcriptMatch[0]}\n\n## Attachments`)
          : newMd + `\n\n${transcriptMatch[0]}`;
      }
    }

    fs.writeFileSync(filePath, newMd, "utf8");

    // Update index entry if hasVideo changed
    if (lesson.hasVideo !== result.hasVideo || lesson.videoProvider !== result.videoProvider) {
      lesson.hasVideo = result.hasVideo;
      lesson.videoProvider = result.videoProvider;
    }

    console.log(`  ✓ Fixed (${result.iframeCount} video(s), ${result.content?.length || 0} chars content)`);
    fixed++;
  } catch (e) {
    console.log(`  ✗ Error: ${e.message}`);
    failed++;
  }

  await page.waitForTimeout(600);
}

// Save updated index
fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf8");

await browser.close();

console.log(`\n${"=".repeat(60)}`);
console.log(`RESCRAPE COMPLETE`);
console.log(`Fixed: ${fixed} | Failed: ${failed} | Remaining: ${toFix.length - fixed - failed}`);
if (fixed > 0) {
  console.log(`\nNext steps:`);
  console.log(`  1. Run transcript scraper: node scripts/scrape-transcripts.mjs --course xactimate`);
  console.log(`  2. Re-upload to Drive:     node scripts/upload-to-drive.mjs`);
}
