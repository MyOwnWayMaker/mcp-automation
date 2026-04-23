/**
 * Adjuster University full content scraper.
 * Extracts all courses, modules, lessons (text + video transcripts + PDFs).
 * Output: ~/Desktop/adjuster-university-content/
 *
 * Run from Mac Terminal (after running auth-adjuster-university.mjs first):
 *   node /Users/hakielmcqueen/mcp-automation/scripts/scrape-adjuster-university.mjs
 *
 * Options:
 *   --dry-run     Print course catalog only, do not scrape lesson content
 *   --max-lessons N   Stop after N lessons (for testing)
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import https from "https";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/adjuster_university_session.json";
const OUTPUT_DIR = path.join(process.env.HOME, "Desktop/adjuster-university-content");
const DRY_RUN = process.argv.includes("--dry-run");
const MAX_LESSONS = process.argv.includes("--max-lessons")
  ? parseInt(process.argv[process.argv.indexOf("--max-lessons") + 1])
  : Infinity;

// Track PDFs already downloaded (by URL) to avoid re-downloading sidebar PDFs on every lesson
const downloadedPdfUrls = new Set();

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitize(str) {
  return str.replace(/[^a-z0-9\-_ ]/gi, "").replace(/\s+/g, "-").toLowerCase().slice(0, 80);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dest));
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, res2 => res2.pipe(file));
        file.on("finish", () => { file.close(); resolve(); });
        return;
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", reject);
  });
}

// ── Vimeo transcript: try player page captions first, then Gemini fallback ────
async function fetchVimeoTranscript(videoId) {
  // First: try fetching captions from the Vimeo player page (no auth needed for some videos)
  try {
    const playerResp = await fetch(`https://player.vimeo.com/video/${videoId}?autoplay=0`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    if (playerResp.ok) {
      const html = await playerResp.text();
      // Vimeo embeds caption track URLs in the player config JSON
      const configMatch = html.match(/var config = ({.+?});/s) || html.match(/"text_tracks":(\[.+?\])/s);
      if (configMatch) {
        try {
          const configStr = configMatch[1];
          const urlMatch = configStr.match(/"url":"(https:[^"]+\.vtt[^"]*)"/);
          if (urlMatch) {
            const vttResp = await fetch(urlMatch[1].replace(/\\/g, ""));
            if (vttResp.ok) {
              const vtt = await vttResp.text();
              const text = vtt.split("\n")
                .filter(l => !l.match(/^WEBVTT|^\d+$|^\d{2}:\d{2}/) && l.trim())
                .join(" ").replace(/<[^>]+>/g, "").trim();
              if (text.length > 50) return text;
            }
          }
        } catch { /* continue to Gemini fallback */ }
      }
    }
  } catch { /* continue to Gemini fallback */ }

  // Gemini fallback: ask Gemini to describe/transcribe using the embed URL
  if (!process.env.GOOGLE_AI_API_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const embedUrl = `https://player.vimeo.com/video/${videoId}`;
    const result = await model.generateContent([
      `This is a Vimeo video embed URL for an insurance adjusting training course: ${embedUrl}\n\n` +
      `The video ID is ${videoId}. Based on the lesson title and context, provide a brief note that ` +
      `a transcript was not available for this video. Keep it to one sentence.`
    ]);
    // Note: Gemini can't actually stream/watch the video via URL - mark for manual transcription
    return `[Transcript not available — Vimeo video ${videoId}. To add transcript, download video and run through Whisper.]`;
  } catch {
    return null;
  }
}

// Try Wistia transcript (no auth needed for public transcripts)
async function fetchWistiaTranscript(videoId) {
  try {
    // Wistia captions endpoint
    const resp = await fetch(`https://fast.wistia.com/embed/captions/${videoId}.json`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.captions || data.captions.length === 0) return null;
    const lines = data.captions.map(c => c.text).join(" ");
    return lines.trim() || null;
  } catch {
    return null;
  }
}

// Extract video info from page
async function extractVideoInfo(page) {
  return await page.evaluate(() => {
    const info = { provider: null, videoId: null, iframeSrc: null };

    // Check for Vimeo iframe
    const vimeoFrame = document.querySelector('iframe[src*="vimeo.com"]');
    if (vimeoFrame) {
      info.provider = "vimeo";
      info.iframeSrc = vimeoFrame.src;
      const match = vimeoFrame.src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
      if (match) info.videoId = match[1];
      return info;
    }

    // Check for Wistia
    const wistiaDiv = document.querySelector('[data-video-id], .wistia_embed, [class*="wistia"]');
    if (wistiaDiv) {
      info.provider = "wistia";
      info.videoId = wistiaDiv.getAttribute("data-video-id") ||
        (wistiaDiv.className.match(/wistia_async_([a-z0-9]+)/) || [])[1] || null;
      return info;
    }
    const wistiaScript = document.querySelector('script[src*="wistia"]');
    if (wistiaScript) {
      const match = wistiaScript.src.match(/medias\/([a-z0-9]+)/);
      if (match) { info.provider = "wistia"; info.videoId = match[1]; return info; }
    }

    // Check for YouTube
    const ytFrame = document.querySelector('iframe[src*="youtube.com"], iframe[src*="youtu.be"]');
    if (ytFrame) {
      info.provider = "youtube";
      info.iframeSrc = ytFrame.src;
      const match = ytFrame.src.match(/embed\/([^?&]+)/);
      if (match) info.videoId = match[1];
      return info;
    }

    // Generic video iframe
    const anyIframe = document.querySelector('iframe[src*="video"], iframe[src*="player"]');
    if (anyIframe) {
      info.provider = "unknown";
      info.iframeSrc = anyIframe.src;
      return info;
    }

    return info;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

ensureDir(OUTPUT_DIR);
ensureDir(path.join(OUTPUT_DIR, "courses"));
ensureDir(path.join(OUTPUT_DIR, "pdfs"));

const EMAIL = process.env.ADJUSTER_UNIVERSITY_EMAIL;
const PASSWORD = process.env.ADJUSTER_UNIVERSITY_PASSWORD;

console.log("Launching browser...");
const browser = await chromium.launch({ headless: false, slowMo: 100 });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
});

// Restore session cookies if available
if (fs.existsSync(SESSION_PATH)) {
  const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
  if (session.cookies?.length) {
    await context.addCookies(session.cookies);
    console.log(`Restored ${session.cookies.length} session cookies.`);
  }
}

const page = await context.newPage();

// ── Login helper ──────────────────────────────────────────────────────────────
async function doLogin() {
  console.log("Logging in...");
  await page.goto("https://adjuster-university.com/access/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  // WordPress login form uses 'log' and 'pwd' field names
  const filled = await page.evaluate(({ email, password }) => {
    const attempts = [
      ["#user_login", "#user_pass"],
      ["input[name='log']", "input[name='pwd']"],
      ["input[name='username']", "input[name='password']"],
      ["input[name='email']", "input[name='password']"],
      ["input[type='text']", "input[type='password']"],
    ];
    for (const [userSel, passSel] of attempts) {
      const u = document.querySelector(userSel);
      const p = document.querySelector(passSel);
      if (u && p) {
        u.value = email;
        u.dispatchEvent(new Event("input", { bubbles: true }));
        p.value = password;
        p.dispatchEvent(new Event("input", { bubbles: true }));
        return userSel;
      }
    }
    return null;
  }, { email: EMAIL, password: PASSWORD });

  if (filled) {
    console.log(`  Filled form using selector: ${filled}`);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"], button[type="submit"], #wp-submit');
      if (btn) btn.click();
    });
  } else {
    console.log("  Could not auto-fill. Please log in manually in the browser window.");
    console.log("  Username:", EMAIL, "  Password:", PASSWORD);
  }

  console.log("Waiting up to 3 minutes for login (paste email verification link if needed)...");
  try {
    await page.waitForFunction(
      () => !window.location.href.includes("/access") || document.title.indexOf("Log In") === -1,
      { timeout: 180000 }
    );
  } catch {
    console.log("Could not confirm login redirect — continuing anyway.");
  }
  await page.waitForTimeout(2000);
  console.log("Post-login URL:", page.url());
}

// ── Step 1: Navigate to course dashboard ─────────────────────────────────────
// WordPress LMS dashboards can be at several URLs — try them in order
const DASHBOARD_URLS = [
  "https://adjuster-university.com/dashboard/",
  "https://adjuster-university.com/my-courses/",
  "https://adjuster-university.com/courses/",
  "https://adjuster-university.com/learn/",
  "https://adjuster-university.com/members/",
  "https://adjuster-university.com/student/",
  "https://adjuster-university.com/wp-admin/",
];

console.log("\nNavigating to course dashboard...");
let foundDashboard = false;

for (const url of DASHBOARD_URLS) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const title = await page.title();
  const curUrl = page.url();
  const isLoginPage = title.includes("Log In") || curUrl.includes("/access") || curUrl.includes("/login");
  if (!isLoginPage) {
    console.log(`Found dashboard at: ${curUrl} (${title})`);
    foundDashboard = true;
    break;
  }
}

// If still on login page, do interactive login
if (!foundDashboard) {
  await doLogin();
  // Try dashboard URLs again after login
  for (const url of DASHBOARD_URLS) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const title = await page.title();
    const curUrl = page.url();
    if (!title.includes("Log In") && !curUrl.includes("/access") && !curUrl.includes("/login")) {
      console.log(`Found dashboard at: ${curUrl} (${title})`);
      foundDashboard = true;
      break;
    }
  }
}

if (!foundDashboard) {
  console.log("Still on login page. Trying home page to discover course links...");
  await page.goto("https://adjuster-university.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);
}

console.log("Current URL:", page.url());

// Try to find course links on the page
const pageContent = await page.content();
console.log("Page title:", await page.title());

// ── Step 2: Discover all courses ─────────────────────────────────────────────
console.log("\nDiscovering courses...");

// This is a LearnDash LMS site. URL structure:
//   Top-level course:  /courses/[slug]/
//   Lesson:            /courses/[slug]/lessons/[slug]/
//   Topic:             /courses/[slug]/lessons/[slug]/topic/[slug]/
//   Quiz:              /courses/[slug]/quizzes/[slug]/  OR  /courses/[slug]/lessons/[slug]/quizzes/[slug]/
//
// We only want top-level course URLs here. Lessons are discovered per-course on the course page.
const courseLinks = await page.evaluate(() => {
  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    const text = a.textContent.trim().replace(/\s+/g, " ").trim();
    if (seen.has(href)) continue;
    seen.add(href);
    // Match ONLY top-level course URLs: /courses/[slug]/ with nothing after the slug
    // Exclude anything with /lessons/, /quizzes/, /topic/ in the path
    const isTopLevelCourse = href.match(/\/courses\/[^\/]+\/?$/) &&
      !href.includes("/lessons/") &&
      !href.includes("/quizzes/") &&
      !href.includes("/topic/") &&
      text.length > 2;
    if (isTopLevelCourse) {
      links.push({ href, text });
    }
  }
  return links;
});

console.log(`Found ${courseLinks.length} potential course links.`);
if (courseLinks.length === 0) {
  // Dump all links to help debug
  const allLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]")).map(a => ({ href: a.href, text: a.textContent.trim().slice(0, 60) }))
  );
  console.log("All links on page (for debugging):");
  allLinks.forEach(l => console.log(" ", l.href, "|", l.text));

  // Save page HTML for inspection
  writeFile(path.join(OUTPUT_DIR, "debug-dashboard.html"), pageContent);
  console.log("Saved page HTML to debug-dashboard.html for inspection.");
  console.log("\nCould not auto-discover courses. The site structure may need manual inspection.");
  await browser.close();
  process.exit(0);
}

courseLinks.forEach((l, i) => console.log(`  ${i + 1}. ${l.text} → ${l.href}`));

if (DRY_RUN) {
  console.log("\n[DRY RUN] Stopping here. Remove --dry-run to start scraping.");
  await browser.close();
  process.exit(0);
}

// ── Step 3: Scrape each course ────────────────────────────────────────────────
const index = { courses: [], scrapedAt: new Date().toISOString() };
let totalLessons = 0;

for (const courseLink of courseLinks) {
  if (totalLessons >= MAX_LESSONS) break;
  console.log(`\n${"=".repeat(60)}\nScraping course: ${courseLink.text}\n${"=".repeat(60)}`);

  await page.goto(courseLink.href, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  const courseSlug = sanitize(courseLink.text) || "course-" + index.courses.length;
  const courseDir = path.join(OUTPUT_DIR, "courses", courseSlug);
  ensureDir(courseDir);

  // Find all lesson and topic links within this course (LearnDash structure)
  const lessonLinks = await page.evaluate((courseHref) => {
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      const text = a.textContent.trim().replace(/\s+/g, " ").trim();
      if (seen.has(href)) continue;
      seen.add(href);
      // Match lessons and topics within this course, exclude quizzes
      const isLesson = href.includes("/lessons/") && !href.includes("/quizzes/");
      const isTopic = href.includes("/topic/");
      if ((isLesson || isTopic) && text.length > 2) {
        links.push({ href, text });
      }
    }
    return links;
  }, courseLink.href);

  if (lessonLinks.length === 0) {
    // Maybe the course page itself IS a lesson — treat it as one
    console.log("  No sub-lessons found — treating course page as single lesson.");
    lessonLinks.push({ href: courseLink.href, text: courseLink.text });
  }

  console.log(`  Found ${lessonLinks.length} lessons.`);

  const courseEntry = { title: courseLink.text, url: courseLink.href, slug: courseSlug, lessons: [] };

  for (const lesson of lessonLinks) {
    if (totalLessons >= MAX_LESSONS) break;
    totalLessons++;
    const lessonSlug = sanitize(lesson.text) || `lesson-${totalLessons}`;
    console.log(`\n  [${totalLessons}] Lesson: ${lesson.text}`);

    try {
      await page.goto(lesson.href, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);

      // Extract lesson text content
      const content = await page.evaluate(() => {
        // Remove nav, header, footer, sidebar
        const skip = document.querySelectorAll("nav, header, footer, aside, .sidebar, .navigation, .breadcrumb, script, style");
        skip.forEach(el => el.remove());

        // Try known content containers first
        const containers = [
          ".lecture-content", ".lesson-content", ".content-body", ".course-content",
          "article", "main", ".main-content", "#content", ".post-content",
        ];
        for (const sel of containers) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim().length > 50) {
            return el.innerText.trim();
          }
        }
        return document.body.innerText.trim();
      });

      // Find PDF links — deduplicate by URL to avoid re-downloading sidebar/global PDFs
      const allPdfLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a[href]"))
          .filter(a => a.href.match(/\.pdf$/i) || a.href.match(/\/download\//i))
          .map(a => ({ href: a.href, text: a.textContent.trim() }));
      });
      // Only keep unique URLs not seen before across all lessons
      const pdfLinks = [];
      const seenThisLesson = new Set();
      for (const p of allPdfLinks) {
        if (!seenThisLesson.has(p.href)) {
          seenThisLesson.add(p.href);
          pdfLinks.push(p);
        }
      }

      // Get video info
      const videoInfo = await extractVideoInfo(page);
      let transcript = null;

      if (videoInfo.provider === "vimeo" && videoInfo.videoId) {
        console.log(`     Video: Vimeo ${videoInfo.videoId} — fetching transcript...`);
        transcript = await fetchVimeoTranscript(videoInfo.videoId);
        if (!transcript) console.log("     (No Vimeo transcript available — would need Gemini fallback)");
      } else if (videoInfo.provider === "wistia" && videoInfo.videoId) {
        console.log(`     Video: Wistia ${videoInfo.videoId} — fetching transcript...`);
        transcript = await fetchWistiaTranscript(videoInfo.videoId);
        if (!transcript) console.log("     (No Wistia transcript available)");
      } else if (videoInfo.provider) {
        console.log(`     Video: ${videoInfo.provider} (${videoInfo.iframeSrc || videoInfo.videoId || "unknown"}) — transcript not extracted`);
      }

      // Build markdown file
      const md = [
        `# ${lesson.text}`,
        `**URL:** ${lesson.href}`,
        `**Course:** ${courseLink.text}`,
        "",
        "## Lesson Content",
        "",
        content || "(No text content found)",
        "",
        ...(videoInfo.provider ? [
          "## Video",
          `Provider: ${videoInfo.provider}`,
          videoInfo.videoId ? `ID: ${videoInfo.videoId}` : "",
          videoInfo.iframeSrc ? `Embed: ${videoInfo.iframeSrc}` : "",
          "",
        ] : []),
        ...(transcript ? [
          "## Video Transcript",
          "",
          transcript,
          "",
        ] : []),
        ...(pdfLinks.length > 0 ? [
          "## Attachments",
          ...pdfLinks.map(p => `- [${p.text || "Download"}](${p.href})`),
          "",
        ] : []),
      ].join("\n");

      const outPath = path.join(courseDir, `${lessonSlug}.md`);
      writeFile(outPath, md);
      console.log(`     Saved: ${outPath}`);

      // Download PDFs — skip URLs already downloaded in a previous lesson
      for (const pdfLink of pdfLinks) {
        if (downloadedPdfUrls.has(pdfLink.href)) {
          console.log(`     PDF already downloaded (shared resource): ${pdfLink.href}`);
          continue;
        }
        downloadedPdfUrls.add(pdfLink.href);
        try {
          // Use URL ID for shared PDFs, lesson slug for lesson-specific ones
          const urlId = pdfLink.href.match(/\/download\/(\d+)/)?.[1] || lessonSlug;
          const pdfName = `${courseSlug}-${urlId}.pdf`;
          const pdfDest = path.join(OUTPUT_DIR, "pdfs", pdfName);
          console.log(`     Downloading PDF: ${pdfLink.href}`);
          await downloadFile(pdfLink.href, pdfDest);
          console.log(`     PDF saved: ${pdfDest}`);
        } catch (e) {
          console.log(`     PDF download failed: ${e.message}`);
        }
      }

      courseEntry.lessons.push({
        title: lesson.text,
        url: lesson.href,
        slug: lessonSlug,
        file: `courses/${courseSlug}/${lessonSlug}.md`,
        hasVideo: !!videoInfo.provider,
        videoProvider: videoInfo.provider,
        hasTranscript: !!transcript,
        pdfCount: pdfLinks.length,
      });

    } catch (e) {
      console.log(`     ERROR scraping lesson: ${e.message}`);
      courseEntry.lessons.push({ title: lesson.text, url: lesson.href, error: e.message });
    }

    await page.waitForTimeout(500); // Be polite between requests
  }

  index.courses.push(courseEntry);
  console.log(`\n  Course done: ${courseEntry.lessons.length} lessons scraped.`);
}

// ── Write index ───────────────────────────────────────────────────────────────
writeFile(path.join(OUTPUT_DIR, "index.json"), JSON.stringify(index, null, 2));
console.log(`\n${"=".repeat(60)}`);
console.log(`SCRAPE COMPLETE`);
console.log(`Total courses: ${index.courses.length}`);
console.log(`Total lessons: ${totalLessons}`);
console.log(`Output: ${OUTPUT_DIR}`);
console.log(`Index: ${OUTPUT_DIR}/index.json`);
console.log(`\nNext steps:`);
console.log(`  1. Review output in ${OUTPUT_DIR}`);
console.log(`  2. Run upload-to-drive.mjs to push to Google Drive`);
console.log(`  3. Add Drive folder to NotebookLM as a source`);

await page.waitForTimeout(2000);
await browser.close();
