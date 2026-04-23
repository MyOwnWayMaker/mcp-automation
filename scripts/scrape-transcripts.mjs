/**
 * Scrapes transcripts from Adjuster University lesson pages.
 * Handles:
 *   - Multiple videos per lesson (Vimeo and YouTube)
 *   - Vimeo: clicks the Transcript button in the player control bar
 *   - YouTube: navigates to watch page and opens the transcript panel
 *   - Virtual scrolling: scrolls through the entire transcript panel
 *   - Tracks Vimeo videos with no Transcript button (for audio transcription later)
 *
 * Run from Mac Terminal:
 *   node scripts/scrape-transcripts.mjs
 *
 * Options:
 *   --course field-property    Only do one course (slug from index.json)
 *   --max N                    Stop after N lessons (testing)
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/adjuster_university_session.json";
const OUTPUT_DIR = path.join(process.env.HOME, "Desktop/adjuster-university-content");
const INDEX_PATH = path.join(OUTPUT_DIR, "index.json");

const FILTER_COURSE = process.argv.includes("--course")
  ? process.argv[process.argv.indexOf("--course") + 1] : null;
const MAX = process.argv.includes("--max")
  ? parseInt(process.argv[process.argv.indexOf("--max") + 1]) : Infinity;

// Courses to skip entirely
const SKIP_COURSES = new Set([
  "residential-hail",
  "adjuster-firms-volume-1",
  "adjuster-firms-volume-2",
  "adjuster-firms-volume-3",
  "adjuster-firms-volume-4",
  "adjuster-firms-volume-5",
  "2x-guarantee-activation",
  "90-day-accelerator-program-diploma-exam",
]);

if (!fs.existsSync(INDEX_PATH)) {
  console.error("index.json not found. Run scrape-adjuster-university.mjs first.");
  process.exit(1);
}

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

// Tracks Vimeo videos with no Transcript button for end-of-run report
const noTranscriptVideos = [];

// ── Strip Vimeo UI chrome ─────────────────────────────────────────────────────
function cleanTranscript(raw) {
  let text = raw
    .replace(/^[\s\S]*?Press space to toggle playback\.\s*/i, "")
    .replace(/^Transcript\s*Settings?\s*Close\s*/i, "")
    .replace(/^Search transcript\s*/i, "")
    .trim();
  if (text.length < 50) {
    const marker = raw.indexOf("toggle playback.");
    if (marker !== -1) text = raw.slice(marker + "toggle playback.".length).trim();
  }
  return text
    .split("\n").map(l => l.trim())
    .filter(l => l.length > 0 && !/^\d+:\d+$/.test(l))
    .join(" ").replace(/\s+/g, " ").trim();
}

// ── Patch markdown file with transcript ───────────────────────────────────────
function patchMarkdown(mdPath, transcript) {
  if (!fs.existsSync(mdPath)) return false;
  let content = fs.readFileSync(mdPath, "utf8");
  const section = `## Video Transcript\n\n${transcript}\n`;
  if (content.includes("## Video Transcript")) {
    content = content.replace(/## Video Transcript[\s\S]*?(?=\n##|$)/, section);
  } else if (content.includes("## Attachments")) {
    content = content.replace("## Attachments", `${section}\n## Attachments`);
  } else {
    content += `\n\n${section}`;
  }
  fs.writeFileSync(mdPath, content, "utf8");
  return true;
}

// ── Format seconds as H:MM:SS ─────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return "unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// ── Scroll + collect lines from a panel ──────────────────────────────────────
async function scrollAndCollect(page, readFn, maxSteps = 600) {
  const allLines = [];
  const seen = new Set();
  let emptyStreak = 0;
  for (let i = 0; i < maxSteps; i++) {
    const lines = await readFn();
    let newCount = 0;
    for (const line of lines) {
      const t = line.trim();
      if (t && t.length > 2 && !/^\d+:\d+$/.test(t) && !seen.has(t)) {
        seen.add(t); allLines.push(t); newCount++;
      }
    }
    emptyStreak = newCount === 0 ? emptyStreak + 1 : 0;
    if (emptyStreak >= 10 && i > 10) break;
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(400);
  }
  return allLines;
}

// ── Get transcript from one Vimeo frame ──────────────────────────────────────
// Returns: { text, duration, hasButton }
async function getVimeoFrameTranscript(page, vimeoFrame, iframeIndex, lessonInfo) {
  // Trigger play (muted) so all control buttons render
  await vimeoFrame.evaluate(() => {
    const v = document.querySelector("video");
    if (v) { v.muted = true; v.play().catch(() => {}); }
  }).catch(() => {});

  await page.locator('iframe[src*="vimeo.com"]').nth(iframeIndex).hover().catch(() => {});
  await page.waitForTimeout(5000);

  // Get video duration regardless of whether transcript button exists
  const duration = await vimeoFrame.evaluate(() => {
    const v = document.querySelector("video");
    return (v && isFinite(v.duration) && v.duration > 0) ? Math.round(v.duration) : 0;
  }).catch(() => 0);

  const transcriptBtn = vimeoFrame.locator("button").filter({ hasText: /^Transcript$/i });
  const count = await transcriptBtn.count();

  if (count === 0) {
    // Log for end-of-run report
    noTranscriptVideos.push({
      course: lessonInfo.course,
      lesson: lessonInfo.title,
      url: lessonInfo.url,
      videoIndex: iframeIndex + 1,
      duration,
      durationStr: formatDuration(duration),
    });
    console.log(`       No Transcript button — video duration: ${formatDuration(duration)} (flagged for audio transcription)`);
    return { text: null, duration, hasButton: false };
  }

  console.log(`       Found Transcript button — clicking...`);
  await transcriptBtn.first().click({ force: true, timeout: 5000 });
  await page.waitForTimeout(3000);

  // Hover over the transcript panel so mouse wheel scrolls it
  try {
    const panel = vimeoFrame.locator('[class*="transcript"], [class*="Transcript"]').first();
    if (await panel.count() > 0) await panel.hover({ timeout: 3000 });
  } catch { /* ok */ }

  const lines = await scrollAndCollect(page, () =>
    vimeoFrame.evaluate(() => {
      const sels = ['[class*="Transcript"]', '[class*="transcript"]', '[data-testid*="transcript"]'];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.innerText?.trim();
          if (t && t.length > 50) return t.split("\n");
        }
      }
      for (const div of Array.from(document.querySelectorAll("div"))) {
        const t = div.innerText?.trim();
        if (t && t.length > 200 && !div.querySelector("button, video, input")) return t.split("\n");
      }
      return [];
    })
  );

  const raw = lines.join("\n");
  const text = raw.length > 50 ? cleanTranscript(raw) : null;
  return { text, duration, hasButton: true };
}

// ── Get transcript from YouTube watch page ────────────────────────────────────
async function getYouTubeTranscript(browserContext, videoId) {
  const ytPage = await browserContext.newPage();
  try {
    await ytPage.goto(`https://www.youtube.com/watch?v=${videoId}`, {
      waitUntil: "domcontentloaded", timeout: 30000,
    });
    await ytPage.waitForTimeout(4000);

    // Scroll down to make the More Actions button visible
    await ytPage.evaluate(() => window.scrollBy(0, 400));
    await ytPage.waitForTimeout(1000);

    const moreBtn = ytPage.locator('button[aria-label="More actions"]').first();
    if (await moreBtn.count() === 0) {
      console.log(`       YouTube: no More Actions button`);
      return null;
    }
    // Scroll button into view then click
    await moreBtn.scrollIntoViewIfNeeded().catch(() => {});
    await ytPage.waitForTimeout(500);
    await moreBtn.click({ force: true, timeout: 8000 });
    await ytPage.waitForTimeout(1500);

    // Click "Show transcript"
    const transcriptItem = ytPage.locator('yt-formatted-string, tp-yt-paper-item')
      .filter({ hasText: /show transcript/i }).first();
    if (await transcriptItem.count() === 0) {
      console.log(`       YouTube: no Show Transcript option in menu`);
      return null;
    }
    await transcriptItem.click({ timeout: 5000 });
    await ytPage.waitForTimeout(3000);

    const panel = ytPage.locator('ytd-transcript-segment-list-renderer, #segments-container').first();
    if (await panel.count() === 0) {
      console.log(`       YouTube: transcript panel did not open`);
      return null;
    }
    await panel.hover().catch(() => {});

    const lines = await scrollAndCollect(ytPage, () =>
      ytPage.evaluate(() => {
        const segs = Array.from(document.querySelectorAll(
          'ytd-transcript-segment-renderer .segment-text, yt-formatted-string.segment-text'
        ));
        if (segs.length > 0) return segs.map(s => s.innerText?.trim()).filter(Boolean);
        const panel = document.querySelector('ytd-transcript-segment-list-renderer, #segments-container');
        if (panel) return (panel.innerText || "").split("\n").map(l => l.trim()).filter(Boolean);
        return [];
      })
    );

    const text = lines.join(" ").replace(/\s+/g, " ").trim();
    return text.length > 50 ? text : null;
  } catch (e) {
    console.log(`       YouTube error: ${e.message}`);
    return null;
  } finally {
    await ytPage.close();
  }
}

// ── Get all transcripts for a lesson (multiple videos, Vimeo + YouTube) ───────
async function getLessonTranscripts(page, lesson, courseName, browserContext) {
  await page.goto(lesson.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Detect auth failure — re-login and retry once
  const pageText = await page.evaluate(() => document.body.innerText || "");
  if (pageText.includes("You don't currently have access")) {
    console.log("     [AUTH] Access denied — refreshing session...");
    await reAuthenticate(page, browserContext);
    await page.goto(lesson.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  const iframeData = await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).map(f => ({
      src: f.src,
      isVimeo: f.src.includes('player.vimeo.com') || f.src.includes('vimeo.com/video'),
      isYouTube: f.src.includes('youtube.com/embed') || f.src.includes('youtube-nocookie.com/embed'),
    })).filter(f => f.isVimeo || f.isYouTube)
  );

  if (iframeData.length === 0) return null;

  const videoSummary = iframeData.map(f => f.isVimeo ? "Vimeo" : "YouTube").join(", ");
  console.log(`     ${iframeData.length} video(s): ${videoSummary}`);

  // Wait for Vimeo frames to register
  const vimeoCount = iframeData.filter(f => f.isVimeo).length;
  if (vimeoCount > 0) {
    const start = Date.now();
    while (Date.now() - start < 12000) {
      const loaded = page.frames().filter(f =>
        f.url().includes("player.vimeo.com") || f.url().includes("vimeo.com/video")
      ).length;
      if (loaded >= vimeoCount) break;
      await page.waitForTimeout(500);
    }
  }

  const transcripts = [];
  const lessonInfo = { course: courseName, title: lesson.title, url: lesson.url };
  let vimeoIndex = 0;

  for (const info of iframeData) {
    if (info.isVimeo) {
      console.log(`     [Video ${vimeoIndex + 1}] Vimeo`);
      const frames = page.frames().filter(f =>
        f.url().includes("player.vimeo.com") || f.url().includes("vimeo.com/video")
      );
      const frame = frames[vimeoIndex];
      if (frame) {
        const result = await getVimeoFrameTranscript(page, frame, vimeoIndex, lessonInfo);
        if (result.text) {
          transcripts.push(result.text);
          console.log(`       ${result.text.length} chars saved`);
        }
      }
      vimeoIndex++;
      await page.waitForTimeout(1000);
    } else if (info.isYouTube) {
      const videoId = info.src.match(/embed\/([^?&/]+)/)?.[1];
      if (videoId) {
        console.log(`     [Video] YouTube: ${videoId}`);
        const t = await getYouTubeTranscript(browserContext, videoId);
        if (t) {
          transcripts.push(t);
          console.log(`       ${t.length} chars saved`);
        } else {
          console.log(`       No YouTube transcript available`);
        }
      }
    }
  }

  return transcripts.length > 0 ? transcripts.join("\n\n") : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));

const browser = await chromium.launch({ headless: false, slowMo: 30 });
const browserContext = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
});

if (fs.existsSync(SESSION_PATH)) {
  const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
  if (session.cookies?.length) await browserContext.addCookies(session.cookies);
}

const page = await browserContext.newPage();
let done = 0, skipped = 0, failed = 0, keepaliveCounter = 0;

for (const course of index.courses) {
  if (FILTER_COURSE && course.slug !== FILTER_COURSE) continue;
  if (SKIP_COURSES.has(course.slug)) {
    console.log(`\n[SKIPPING] ${course.title}`);
    continue;
  }
  console.log(`\nCourse: ${course.title}`);

  for (const lesson of course.lessons) {
    if (done + failed >= MAX) break;
    if (!lesson.hasVideo) { skipped++; continue; }

    const mdPath = path.join(OUTPUT_DIR, lesson.file);
    if (!fs.existsSync(mdPath)) { skipped++; continue; }

    const existing = fs.readFileSync(mdPath, "utf8");
    if (existing.includes("## Video Transcript") && !existing.includes("[Transcript not available")) {
      skipped++;
      continue;
    }

    // Keepalive ping every 20 lessons
    keepaliveCounter++;
    if (keepaliveCounter % 20 === 0) {
      const pingUrl = lesson.url.split("/lessons/")[0] + "/";
      await page.goto(pingUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }

    console.log(`  [${done + skipped + failed + 1}] ${lesson.title}`);

    try {
      const transcript = await getLessonTranscripts(page, lesson, course.title, browserContext);
      if (transcript) {
        patchMarkdown(mdPath, transcript);
        console.log(`     ✓ Saved (${transcript.length} chars total)`);
        done++;
      } else {
        console.log(`     No transcript found`);
        failed++;
      }
    } catch (e) {
      console.log(`     ERROR: ${e.message}`);
      failed++;
    }

    await new Promise(r => setTimeout(r, 800));
  }

  if (done + failed >= MAX) break;
}

await browser.close();

// ── End-of-run summary ────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(60)}`);
console.log(`TRANSCRIPT SCRAPE COMPLETE`);
console.log(`Saved: ${done} | Skipped (already done): ${skipped} | Failed: ${failed}`);

if (noTranscriptVideos.length > 0) {
  const totalSeconds = noTranscriptVideos.reduce((sum, v) => sum + (v.duration || 0), 0);
  const totalHours = (totalSeconds / 3600).toFixed(1);
  const knownDuration = noTranscriptVideos.filter(v => v.duration > 0).length;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`VIMEO VIDEOS WITH NO TRANSCRIPT BUTTON: ${noTranscriptVideos.length}`);
  console.log(`Total known duration: ${totalHours} hours (${knownDuration}/${noTranscriptVideos.length} durations captured)`);
  console.log(`These will need audio transcription (yt-dlp + Gemini):`);
  console.log(`${"─".repeat(60)}`);
  for (const v of noTranscriptVideos) {
    console.log(`  [${v.durationStr}] ${v.course} — ${v.lesson}`);
    console.log(`           ${v.url}`);
  }

  // Save the list to a file for reference
  const reportPath = path.join(OUTPUT_DIR, "needs-audio-transcription.json");
  fs.writeFileSync(reportPath, JSON.stringify(noTranscriptVideos, null, 2));
  console.log(`\nFull list saved to: ${reportPath}`);
}
