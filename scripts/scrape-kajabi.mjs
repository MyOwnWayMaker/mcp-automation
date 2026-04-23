/**
 * Kajabi full content scraper — Tax Wealth Tips course.
 * Extracts all modules/lessons: written content + video transcripts.
 * Output: ~/Desktop/kajabi-content/
 *
 * Run from Mac Terminal (after running auth-kajabi.mjs first):
 *   node /Users/hakielmcqueen/mcp-automation/scripts/scrape-kajabi.mjs
 *
 * Options:
 *   --dry-run       Print course catalog only, do not scrape lessons
 *   --max-lessons N Stop after N lessons (for testing)
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/kajabi_session.json";
const OUTPUT_DIR = path.join(process.env.HOME, "Desktop/kajabi-content");
const DRY_RUN = process.argv.includes("--dry-run");
const MAX_LESSONS = process.argv.includes("--max-lessons")
  ? parseInt(process.argv[process.argv.indexOf("--max-lessons") + 1])
  : Infinity;

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

async function fetchWistiaTranscript(videoId) {
  try {
    const resp = await fetch(`https://fast.wistia.com/embed/captions/${videoId}.json`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.captions || data.captions.length === 0) return null;
    return data.captions.map(c => c.text).join(" ").trim() || null;
  } catch {
    return null;
  }
}

async function fetchVimeoTranscript(videoId) {
  try {
    const resp = await fetch(`https://api.vimeo.com/videos/${videoId}/texttracks`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.data || data.data.length === 0) return null;
    const track = data.data.find(t => t.language === "en") || data.data[0];
    const vttResp = await fetch(`https://vimeo.com${track.link}`);
    if (!vttResp.ok) return null;
    const vtt = await vttResp.text();
    return vtt.split("\n")
      .filter(l => !l.match(/^WEBVTT|^\d+$|^\d{2}:\d{2}/) && l.trim())
      .join(" ").replace(/<[^>]+>/g, "").trim() || null;
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!fs.existsSync(SESSION_PATH)) {
  console.error("No session found. Run auth-kajabi.mjs first.");
  process.exit(1);
}

ensureDir(OUTPUT_DIR);
const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));

const browser = await chromium.launch({ headless: false, slowMo: 100 });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
});

if (session.cookies?.length) await context.addCookies(session.cookies);
const page = await context.newPage();

// Restore localStorage
if (session.localStorage && Object.keys(session.localStorage).length > 0) {
  await page.goto("https://tax-free-wealth-challenge.mykajabi.com", { waitUntil: "domcontentloaded" });
  await page.evaluate(data => {
    for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
  }, session.localStorage);
}

console.log("Navigating to Kajabi member portal...");
// Kajabi library page
await page.goto("https://tax-free-wealth-challenge.mykajabi.com/library", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);
console.log("Current URL:", page.url());
console.log("Title:", await page.title());

// ── Discover products/courses ─────────────────────────────────────────────────
let productLinks = await page.evaluate(() => {
  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    const text = a.textContent.trim();
    if (seen.has(href)) continue;
    seen.add(href);
    if (href.match(/\/products\/|\/courses\//) && text.length > 2) {
      links.push({ href, text });
    }
  }
  return links;
});

if (productLinks.length === 0) {
  // Try the dashboard
  await page.goto("https://tax-free-wealth-challenge.mykajabi.com/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  productLinks = await page.evaluate(() => {
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      const text = a.textContent.trim();
      if (seen.has(href)) continue;
      seen.add(href);
      if (href.match(/\/products\/|\/courses\/|\/p\//) && text.length > 2) {
        links.push({ href, text });
      }
    }
    return links;
  });
}

console.log(`\nFound ${productLinks.length} product/course links:`);
productLinks.forEach((l, i) => console.log(`  ${i + 1}. ${l.text} → ${l.href}`));

if (productLinks.length === 0) {
  const html = await page.content();
  writeFile(path.join(OUTPUT_DIR, "debug-portal.html"), html);
  console.log("Saved debug HTML. Could not auto-discover courses.");
  await browser.close();
  process.exit(0);
}

if (DRY_RUN) {
  console.log("\n[DRY RUN] Stopping here.");
  await browser.close();
  process.exit(0);
}

// ── Scrape each product ───────────────────────────────────────────────────────
const index = { courses: [], scrapedAt: new Date().toISOString() };
let totalLessons = 0;

for (const product of productLinks) {
  if (totalLessons >= MAX_LESSONS) break;
  console.log(`\n${"=".repeat(60)}\nScraping: ${product.text}`);

  await page.goto(product.href, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  const productSlug = sanitize(product.text) || "course-" + index.courses.length;
  const courseDir = path.join(OUTPUT_DIR, "courses", productSlug);
  ensureDir(courseDir);

  // Kajabi posts lessons as /posts/* within a product
  const lessonLinks = await page.evaluate(() => {
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      const text = a.textContent.trim();
      if (seen.has(href)) continue;
      seen.add(href);
      if (href.match(/\/posts\//) && text.length > 2) {
        links.push({ href, text });
      }
    }
    return links;
  });

  if (lessonLinks.length === 0) {
    lessonLinks.push({ href: product.href, text: product.text });
  }
  console.log(`  ${lessonLinks.length} lessons found.`);

  const courseEntry = { title: product.text, url: product.href, slug: productSlug, lessons: [] };

  for (const lesson of lessonLinks) {
    if (totalLessons >= MAX_LESSONS) break;
    totalLessons++;
    const lessonSlug = sanitize(lesson.text) || `lesson-${totalLessons}`;
    console.log(`\n  [${totalLessons}] ${lesson.text}`);

    try {
      await page.goto(lesson.href, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);

      // Extract main content
      const content = await page.evaluate(() => {
        document.querySelectorAll("nav, header, footer, aside, .sidebar, script, style, .navigation").forEach(el => el.remove());
        for (const sel of [".kjb-post-content", ".post-content", ".lecture-content", "article", "main", ".content"]) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim().length > 50) return el.innerText.trim();
        }
        return document.body.innerText.trim();
      });

      // Detect video
      const videoInfo = await page.evaluate(() => {
        // Wistia (Kajabi's primary video host)
        const wistiaEmbed = document.querySelector(".wistia_embed, [class*='wistia_async']");
        if (wistiaEmbed) {
          const match = (wistiaEmbed.className || "").match(/wistia_async_([a-z0-9]+)/i);
          return { provider: "wistia", videoId: match ? match[1] : null };
        }
        // Wistia via data attribute
        const wistiaEl = document.querySelector("[data-wistia-id]");
        if (wistiaEl) return { provider: "wistia", videoId: wistiaEl.getAttribute("data-wistia-id") };
        // Wistia script
        const wistiaScript = document.querySelector('script[src*="wistia"]');
        if (wistiaScript) {
          const m = wistiaScript.src.match(/medias\/([a-z0-9]+)/);
          return { provider: "wistia", videoId: m ? m[1] : null };
        }
        // Vimeo
        const vimeoFrame = document.querySelector('iframe[src*="vimeo"]');
        if (vimeoFrame) {
          const m = vimeoFrame.src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
          return { provider: "vimeo", videoId: m ? m[1] : null };
        }
        return { provider: null, videoId: null };
      });

      let transcript = null;
      if (videoInfo.provider === "wistia" && videoInfo.videoId) {
        console.log(`     Wistia video ${videoInfo.videoId} — fetching transcript...`);
        transcript = await fetchWistiaTranscript(videoInfo.videoId);
        if (!transcript) console.log("     (no Wistia transcript)");
        else console.log(`     Got transcript (${transcript.length} chars)`);
      } else if (videoInfo.provider === "vimeo" && videoInfo.videoId) {
        console.log(`     Vimeo video ${videoInfo.videoId} — fetching transcript...`);
        transcript = await fetchVimeoTranscript(videoInfo.videoId);
      } else if (videoInfo.provider) {
        console.log(`     Video provider: ${videoInfo.provider}`);
      }

      const md = [
        `# ${lesson.text}`,
        `**URL:** ${lesson.href}`,
        `**Course:** ${product.text}`,
        "",
        "## Lesson Content",
        "",
        content || "(No text content found)",
        "",
        ...(videoInfo.provider ? [
          "## Video",
          `Provider: ${videoInfo.provider}`,
          videoInfo.videoId ? `ID: ${videoInfo.videoId}` : "",
          "",
        ] : []),
        ...(transcript ? [
          "## Video Transcript",
          "",
          transcript,
          "",
        ] : []),
      ].join("\n");

      const outPath = path.join(courseDir, `${lessonSlug}.md`);
      writeFile(outPath, md);
      console.log(`     Saved: ${outPath}`);

      courseEntry.lessons.push({
        title: lesson.text,
        url: lesson.href,
        slug: lessonSlug,
        file: `courses/${productSlug}/${lessonSlug}.md`,
        videoProvider: videoInfo.provider,
        hasTranscript: !!transcript,
      });
    } catch (e) {
      console.log(`     ERROR: ${e.message}`);
      courseEntry.lessons.push({ title: lesson.text, url: lesson.href, error: e.message });
    }

    await page.waitForTimeout(500);
  }

  index.courses.push(courseEntry);
}

writeFile(path.join(OUTPUT_DIR, "index.json"), JSON.stringify(index, null, 2));
console.log(`\n${"=".repeat(60)}`);
console.log(`KAJABI SCRAPE COMPLETE`);
console.log(`Courses: ${index.courses.length} | Lessons: ${totalLessons}`);
console.log(`Output: ${OUTPUT_DIR}`);

await page.waitForTimeout(2000);
await browser.close();
