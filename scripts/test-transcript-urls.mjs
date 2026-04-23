/**
 * Test transcript + download scraping on specific URLs.
 * Handles: YouTube videos, multiple Vimeo videos, tabbed content (Topic/Materials tabs),
 * and downloadable file links.
 *
 * Run:
 *   node scripts/test-transcript-urls.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { URL } from "url";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/adjuster_university_session.json";
const OUTPUT_DIR = path.join(process.env.HOME, "Desktop/adjuster-university-content");
const DOWNLOAD_DIR = path.join(OUTPUT_DIR, "downloads/xactimate-gold-training-suite");

const TEST_URLS = [
  {
    label: "YouTube video lesson",
    url: "https://adjuster-university.com/courses/xactimate-gold-training-suite/lessons/field-adjusters-assessment-packet/",
    saveAs: "field-adjusters-assessment-packet.md",
  },
  {
    label: "Topic page — 2 Vimeo videos + Materials tab downloads",
    url: "https://adjuster-university.com/courses/xactimate-gold-training-suite/lessons/15-inglewood-lane/topic/photos-small-losses/",
    saveAs: "15-inglewood-lane--photos-small-losses.md",
  },
];

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// ── Download a file ───────────────────────────────────────────────────────────
function downloadFile(fileUrl, destPath, cookies) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath)) { resolve(destPath); return; }
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const parsed = new URL(fileUrl);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(fileUrl, {
      headers: {
        "Cookie": cookieHeader,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://adjuster-university.com/",
      },
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
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

// ── Vimeo transcript ──────────────────────────────────────────────────────────
async function getVimeoFrameTranscript(page, vimeoFrame, iframeIndex) {
  await vimeoFrame.evaluate(() => {
    const v = document.querySelector("video");
    if (v) { v.muted = true; v.play().catch(() => {}); }
  }).catch(() => {});

  await page.locator('iframe[src*="vimeo.com"]').nth(iframeIndex).hover().catch(() => {});
  await page.waitForTimeout(5000);

  const transcriptBtn = vimeoFrame.locator("button").filter({ hasText: /^Transcript$/i });
  if (await transcriptBtn.count() === 0) {
    const btns = await vimeoFrame.evaluate(() =>
      Array.from(document.querySelectorAll("button")).map(b => ({ text: b.innerText?.trim(), aria: b.getAttribute("aria-label") }))
    );
    console.log(`       No Transcript button. Buttons: ${JSON.stringify(btns)}`);
    return null;
  }

  console.log(`       Clicking Transcript button...`);
  await transcriptBtn.first().click({ force: true, timeout: 5000 });
  await page.waitForTimeout(3000);

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
  return raw.length > 50 ? cleanTranscript(raw) : null;
}

// ── YouTube transcript ────────────────────────────────────────────────────────
async function getYouTubeTranscript(browserContext, videoId) {
  const ytPage = await browserContext.newPage();
  try {
    await ytPage.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await ytPage.waitForTimeout(4000);

    const moreBtn = ytPage.locator('button[aria-label="More actions"]').first();
    if (await moreBtn.count() === 0) { console.log(`       YouTube: no More Actions button`); return null; }
    await moreBtn.click({ timeout: 5000 });
    await ytPage.waitForTimeout(1500);

    const transcriptItem = ytPage.locator('yt-formatted-string, tp-yt-paper-item')
      .filter({ hasText: /show transcript/i }).first();
    if (await transcriptItem.count() === 0) { console.log(`       YouTube: no Show Transcript option`); return null; }
    await transcriptItem.click({ timeout: 5000 });
    await ytPage.waitForTimeout(3000);

    const panel = ytPage.locator('ytd-transcript-segment-list-renderer, #segments-container').first();
    if (await panel.count() === 0) { console.log(`       YouTube: panel didn't open`); return null; }
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

// ── Scrape a single page (all tabs, all videos, all downloads) ────────────────
async function scrapePage(page, url, browserContext, cookies) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  const result = { transcripts: [], downloads: [], tabContents: {} };

  // Detect tabs (Topic tab, Materials tab, etc.)
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="tab"], .tab, .nav-tab, [data-tab], .lesson-tab'))
      .map(t => ({ text: t.innerText?.trim(), selector: t.className }))
  );
  console.log(`     Tabs found: ${JSON.stringify(tabs.map(t => t.text))}`);

  // Try to find tab buttons and click each one
  const tabLocators = [
    page.locator('[role="tab"]'),
    page.locator('.tab-link, .nav-tab-link, .lesson-tab'),
  ];

  let tabsProcessed = false;
  for (const tabLocator of tabLocators) {
    const count = await tabLocator.count();
    if (count > 1) {
      console.log(`     Processing ${count} tabs...`);
      for (let i = 0; i < count; i++) {
        const tabText = await tabLocator.nth(i).innerText().catch(() => `Tab ${i + 1}`);
        console.log(`     -- Tab: ${tabText.trim()}`);
        await tabLocator.nth(i).click().catch(() => {});
        await page.waitForTimeout(2000);
        // Collect download links from this tab
        const dlLinks = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href*="/download/"], a[href$=".pdf"], a[href$=".zip"], a[href$=".docx"], a[href$=".xlsx"]'))
            .map(a => ({ href: a.href, text: a.innerText?.trim() || a.href.split('/').pop() }))
        );
        result.tabContents[tabText.trim()] = dlLinks;
        for (const dl of dlLinks) console.log(`       Download: ${dl.text} → ${dl.href}`);
      }
      tabsProcessed = true;
      // Click back to first tab
      await tabLocator.first().click().catch(() => {});
      await page.waitForTimeout(2000);
      break;
    }
  }

  // Collect ALL download links on page (including from any tab)
  const allDownloadLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/download/"], a[href$=".pdf"], a[href$=".zip"], a[href$=".docx"], a[href$=".xlsx"]'))
      .map(a => ({ href: a.href, text: a.innerText?.trim() || a.href.split('/').pop() }))
      .filter((v, i, arr) => arr.findIndex(x => x.href === v.href) === i)
  );

  // Download all files
  for (const dl of allDownloadLinks) {
    const filename = dl.text.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || `download-${Date.now()}`;
    const ext = dl.href.match(/\.(pdf|zip|docx|xlsx)$/i)?.[0] || '.bin';
    const destName = filename.endsWith(ext) ? filename : filename + ext;
    const destPath = path.join(DOWNLOAD_DIR, destName);
    try {
      await downloadFile(dl.href, destPath, cookies);
      console.log(`     Downloaded: ${destName}`);
      result.downloads.push(destPath);
    } catch (e) {
      console.log(`     Download failed (${dl.href}): ${e.message}`);
    }
  }

  // Now get all video iframes
  const iframeData = await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).map(f => ({
      src: f.src,
      isVimeo: f.src.includes('player.vimeo.com') || f.src.includes('vimeo.com/video'),
      isYouTube: f.src.includes('youtube.com/embed') || f.src.includes('youtube-nocookie.com/embed'),
    })).filter(f => f.isVimeo || f.isYouTube)
  );

  if (iframeData.length > 0) {
    console.log(`     ${iframeData.length} video(s): ${iframeData.map(f => f.isVimeo ? 'Vimeo' : 'YouTube').join(', ')}`);

    // Wait for Vimeo frames
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

    let vimeoIndex = 0;
    for (const info of iframeData) {
      if (info.isVimeo) {
        console.log(`     [Video ${vimeoIndex + 1}] Vimeo`);
        const frames = page.frames().filter(f =>
          f.url().includes("player.vimeo.com") || f.url().includes("vimeo.com/video")
        );
        const frame = frames[vimeoIndex];
        if (frame) {
          const t = await getVimeoFrameTranscript(page, frame, vimeoIndex);
          if (t) { result.transcripts.push(t); console.log(`       ${t.length} chars captured`); }
          else console.log(`       No transcript captured`);
        }
        vimeoIndex++;
        await page.waitForTimeout(1000);
      } else if (info.isYouTube) {
        const videoId = info.src.match(/embed\/([^?&/]+)/)?.[1];
        if (videoId) {
          console.log(`     [Video] YouTube: ${videoId}`);
          const t = await getYouTubeTranscript(browserContext, videoId);
          if (t) { result.transcripts.push(t); console.log(`       ${t.length} chars captured`); }
          else console.log(`       No transcript available`);
        }
      }
    }
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: false, slowMo: 30 });
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
  }
}

const page = await browserContext.newPage();

for (const test of TEST_URLS) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${test.label}`);
  console.log(`URL:  ${test.url}`);
  console.log(`${"=".repeat(60)}`);

  const result = await scrapePage(page, test.url, browserContext, cookies);

  const outPath = path.join(OUTPUT_DIR, test.saveAs);
  const content = [
    `# ${test.label}`,
    `**URL:** ${test.url}`,
    result.transcripts.length > 0
      ? `\n## Video Transcript\n\n${result.transcripts.join("\n\n")}`
      : "\n## Video Transcript\n\n[No transcript captured]",
    result.downloads.length > 0
      ? `\n## Downloads\n\n${result.downloads.map(d => `- ${path.basename(d)}`).join("\n")}`
      : "",
  ].join("\n");

  fs.writeFileSync(outPath, content, "utf8");
  console.log(`\nSaved to: ${outPath}`);
  console.log(`Transcripts: ${result.transcripts.length} | Downloads: ${result.downloads.length}`);
  console.log(`Transcript preview: ${result.transcripts[0]?.slice(0, 150) || "(none)"}...`);
}

await browser.close();
console.log("\n\nDONE. Check the output files and downloads folder.");
