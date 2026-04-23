/**
 * Fetches transcripts for Xactimate lessons that have a Vimeo video ID
 * but no transcript yet, using Playwright to intercept the Vimeo player
 * config request (which contains the text track / VTT URLs).
 *
 * Run: node scripts/fetch-missing-transcripts.mjs
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { Readable } from "stream";

const HOME = process.env.HOME;
const CONTENT_DIR = path.join(HOME, "Desktop/adjuster-university-content");
const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/filetrac_session.json"; // not used here
const AU_SESSION_PATH = path.join("/Users/hakielmcqueen/mcp-automation", "adjuster_university_session.json");
const MCP_DIR = "/Users/hakielmcqueen/mcp-automation";

// ── Drive auth ────────────────────────────────────────────────────────────────
const credentials = JSON.parse(fs.readFileSync(`${MCP_DIR}/credentials.json`, "utf-8"));
const token = JSON.parse(fs.readFileSync(`${MCP_DIR}/token.json`, "utf-8"));
const { client_secret, client_id, redirect_uris } = credentials.installed ?? credentials.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(token);
const drive = google.drive({ version: "v3", auth });

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function findDriveFile(name, folderId) {
  const res = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
  });
  return res.data.files[0]?.id ?? null;
}

async function findDriveFolder(name, parentId) {
  const res = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
  });
  return res.data.files[0]?.id ?? null;
}

async function updateDriveFile(fileId, content) {
  await drive.files.update({
    fileId,
    media: { mimeType: "text/plain", body: Readable.from([content]) },
  });
}

// ── VTT parser ────────────────────────────────────────────────────────────────
function vttToText(vtt) {
  return vtt
    .split("\n")
    .filter(line => {
      const t = line.trim();
      if (!t) return false;
      if (t === "WEBVTT") return false;
      if (/^\d+$/.test(t)) return false; // cue numbers
      if (/^\d{2}:\d{2}/.test(t)) return false; // timestamps
      if (t.startsWith("NOTE")) return false;
      return true;
    })
    .join(" ")
    .replace(/<[^>]+>/g, "") // strip HTML tags like <c>
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── Find lessons needing transcripts ─────────────────────────────────────────
function findLessonsNeedingTranscripts(coursePath) {
  const results = [];
  const files = fs.readdirSync(coursePath).filter(f => f.endsWith(".md"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(coursePath, file), "utf-8");
    const hasVideo = /^Provider: vimeo/m.test(content);
    const hasTranscript = /^## Video Transcript/m.test(content);
    if (hasVideo && !hasTranscript) {
      const idMatch = content.match(/^ID: (\d+)/m);
      const embedMatch = content.match(/^Embed: (https:\/\/player\.vimeo\.com\/[^\n]+)/m);
      const urlMatch = content.match(/^\*\*URL:\*\* (https:\/\/[^\n]+)/m);
      if (idMatch) {
        results.push({
          file,
          filePath: path.join(coursePath, file),
          content,
          vimeoId: idMatch[1],
          embedUrl: embedMatch?.[1] ?? `https://player.vimeo.com/video/${idMatch[1]}?badge=0&autopause=0&player_id=0&app_id=58479`,
          lessonUrl: urlMatch?.[1] ?? null,
        });
      }
    }
  }
  return results;
}

// ── Fetch transcript via Playwright ──────────────────────────────────────────
async function fetchVimeoTranscript(lesson, browser, auCookies) {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  // Inject AU session cookies so we can load the lesson page
  if (auCookies?.length) {
    await context.addCookies(auCookies);
  }

  const page = await context.newPage();
  let textTrackUrl = null;
  let capturedVtt = null;

  // Intercept Vimeo player config to get text track URL
  await page.route("**/player.vimeo.com/video/*/config**", async route => {
    const response = await route.fetch();
    try {
      const json = await response.json();
      const tracks = json?.request?.text_tracks ?? [];
      if (tracks.length > 0) {
        // Prefer English, then first available
        const track = tracks.find(t => t.lang === "en") ?? tracks[0];
        textTrackUrl = track.url;
      }
    } catch { /* ignore parse errors */ }
    await route.fulfill({ response });
  });

  // Intercept VTT requests to capture content
  await page.route("**/*.vtt**", async route => {
    const response = await route.fetch();
    try {
      capturedVtt = await response.text();
    } catch { /* ignore */ }
    await route.fulfill({ response });
  });

  try {
    if (lesson.lessonUrl) {
      // Load the actual lesson page — this loads the Vimeo iframe properly
      await page.goto(lesson.lessonUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(4000); // let the player initialize and config load
    } else {
      // Fall back to loading the embed URL directly
      await page.goto(lesson.embedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // If we got a text track URL but not the VTT yet, fetch it
    if (textTrackUrl && !capturedVtt) {
      try {
        const resp = await page.evaluate(async (url) => {
          const r = await fetch(url);
          return r.text();
        }, textTrackUrl);
        capturedVtt = resp;
      } catch { /* ignore */ }
    }
  } finally {
    await context.close();
  }

  if (capturedVtt) {
    return vttToText(capturedVtt);
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
// Load AU session cookies
let auCookies = [];
if (fs.existsSync(AU_SESSION_PATH)) {
  const session = JSON.parse(fs.readFileSync(AU_SESSION_PATH, "utf-8"));
  auCookies = session.cookies ?? [];
}

// Find all courses to process
const coursesDir = path.join(CONTENT_DIR, "courses");
const courses = fs.readdirSync(coursesDir).filter(f =>
  fs.statSync(path.join(coursesDir, f)).isDirectory()
);

// Collect all lessons needing transcripts across all courses
const allLessons = [];
for (const course of courses) {
  const lessons = findLessonsNeedingTranscripts(path.join(coursesDir, course));
  lessons.forEach(l => { l.course = course; });
  allLessons.push(...lessons);
}

console.log(`Found ${allLessons.length} lessons with video but no transcript:\n`);
allLessons.forEach(l => console.log(`  [${l.course}] ${l.file} (Vimeo ${l.vimeoId})`));
console.log("");

if (allLessons.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

// Find Drive folder IDs
const PARENT_FOLDER_ID = "1qUX_pkvZzceUMw_kW_hng01lKIG6JeEv";
const auRootId = await findDriveFolder("Adjuster University Knowledge Base", PARENT_FOLDER_ID);
const coursesDriveFolderId = auRootId ? await findDriveFolder("courses", auRootId) : null;

const browser = await chromium.launch({ headless: true });

let succeeded = 0;
let failed = 0;

for (const lesson of allLessons) {
  process.stdout.write(`Fetching transcript for ${lesson.file}... `);

  const transcript = await fetchVimeoTranscript(lesson, browser, auCookies);

  if (transcript && transcript.length > 50) {
    // Append transcript to the .md file
    const updated = lesson.content + `## Video Transcript\n\n${transcript}\n`;
    fs.writeFileSync(lesson.filePath, updated, "utf-8");

    // Update on Drive
    if (coursesDriveFolderId) {
      const courseDriveFolderId = await findDriveFolder(lesson.course, coursesDriveFolderId);
      if (courseDriveFolderId) {
        const fileId = await findDriveFile(lesson.file, courseDriveFolderId);
        if (fileId) {
          await updateDriveFile(fileId, updated);
          console.log(`✅ (${transcript.length} chars) — Drive updated`);
        } else {
          console.log(`✅ (${transcript.length} chars) — local only (not found on Drive)`);
        }
      } else {
        console.log(`✅ (${transcript.length} chars) — local only (Drive folder not found)`);
      }
    } else {
      console.log(`✅ (${transcript.length} chars) — local only`);
    }
    succeeded++;
  } else {
    console.log(`❌ No transcript found (will need audio transcription route)`);
    failed++;
  }
}

await browser.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`DONE — Succeeded: ${succeeded} | Failed (need audio route): ${failed}`);
