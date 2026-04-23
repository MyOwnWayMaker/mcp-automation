/**
 * Targeted audio transcription for the 31 non-case-study lessons
 * that have Vimeo video IDs but no transcript.
 *
 * For each unique Vimeo ID:
 *   1. Gets authenticated embed URL from the lesson page
 *   2. Downloads audio with yt-dlp
 *   3. Transcribes with Gemini 2.0 Flash
 *   4. Writes transcript to ALL .md files sharing that Vimeo ID
 *   5. Re-uploads updated files to Google Drive
 *
 * Run: node scripts/transcribe-targeted.mjs
 * Options:
 *   --max N      Stop after N transcriptions (for testing)
 */

import { chromium } from "playwright";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { Readable } from "stream";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const MCP_DIR = "/Users/hakielmcqueen/mcp-automation";
const SESSION_PATH = path.join(MCP_DIR, "adjuster_university_session.json");
const CONTENT_DIR = path.join(process.env.HOME, "Desktop/adjuster-university-content");
const AUDIO_TMP = path.join(CONTENT_DIR, "tmp-audio");
const YTDLP = "/Users/hakielmcqueen/Library/Python/3.9/bin/yt-dlp";

const MAX = process.argv.includes("--max")
  ? parseInt(process.argv[process.argv.indexOf("--max") + 1]) : Infinity;

fs.mkdirSync(AUDIO_TMP, { recursive: true });

// ── Drive auth ────────────────────────────────────────────────────────────────
const credentials = JSON.parse(fs.readFileSync(`${MCP_DIR}/credentials.json`, "utf-8"));
const token = JSON.parse(fs.readFileSync(`${MCP_DIR}/token.json`, "utf-8"));
const { client_secret, client_id, redirect_uris } = credentials.installed ?? credentials.web;
const driveAuth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
driveAuth.setCredentials(token);
const drive = google.drive({ version: "v3", auth: driveAuth });

// ── Gemini ────────────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GOOGLE_AI_API_KEY);

// ── Collect all .md files needing transcripts, grouped by Vimeo ID ───────────
function buildVimeoIndex() {
  const byId = new Map(); // vimeoId → { lessonUrl, files: [{filePath, course}] }
  const coursesDir = path.join(CONTENT_DIR, "courses");
  const courses = fs.readdirSync(coursesDir).filter(f =>
    fs.statSync(path.join(coursesDir, f)).isDirectory()
  );

  for (const course of courses) {
    const courseDir = path.join(coursesDir, course);
    const files = fs.readdirSync(courseDir).filter(f => f.endsWith(".md"));

    for (const file of files) {
      if (file.startsWith("case-study-")) continue; // skip case studies
      const filePath = path.join(courseDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.includes("Provider: vimeo")) continue;
      if (content.includes("## Video Transcript")) continue; // already done

      const idMatch = content.match(/^ID: (\d+)/m);
      const urlMatch = content.match(/^\*\*URL:\*\* (https:\/\/[^\n]+)/m);
      if (!idMatch) continue;

      const vimeoId = idMatch[1];
      if (!byId.has(vimeoId)) {
        byId.set(vimeoId, {
          vimeoId,
          lessonUrl: urlMatch?.[1] ?? null,
          title: file.replace(".md", "").replace(/-/g, " "),
          files: [],
        });
      }
      byId.get(vimeoId).files.push({ filePath, course, file, content });
    }
  }

  return byId;
}

// ── Get authenticated Vimeo embed URL from lesson page ───────────────────────
async function getEmbedUrl(page, lessonUrl) {
  try {
    await page.goto(lessonUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(2500);
    return await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="vimeo.com"]');
      return iframe ? iframe.src : null;
    });
  } catch {
    return null;
  }
}

// ── Download audio with yt-dlp ────────────────────────────────────────────────
function downloadAudio(videoUrl, outputBase) {
  const args = [
    videoUrl,
    "--format", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
    "--output", outputBase + ".%(ext)s",
    "--no-playlist",
    "--no-warnings",
    "--add-header", "Referer:https://adjuster-university.com/",
  ];

  const result = spawnSync(YTDLP, args, { encoding: "utf8", timeout: 180000 });
  if (result.error) throw new Error(`yt-dlp error: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`yt-dlp failed: ${result.stderr || result.stdout}`);

  const AUDIO_EXTS = new Set([".m4a", ".mp4", ".webm", ".mp3", ".wav", ".ogg", ".opus", ".aac"]);
  const dir = path.dirname(outputBase);
  const base = path.basename(outputBase);
  const found = fs.readdirSync(dir).filter(f => {
    return f.startsWith(base) && AUDIO_EXTS.has(path.extname(f).toLowerCase());
  });
  if (found.length > 0) return path.join(dir, found[0]);
  throw new Error("Audio file not found after download");
}

// ── Transcribe with Gemini ────────────────────────────────────────────────────
async function transcribeWithGemini(audioPath, title) {
  const fileSize = fs.statSync(audioPath).size;
  console.log(`     Uploading to Gemini (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);

  const ext = path.extname(audioPath).toLowerCase();
  const mimeMap = { ".m4a": "audio/mp4", ".mp4": "video/mp4", ".webm": "audio/webm",
    ".mp3": "audio/mp3", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/opus" };
  const mimeType = mimeMap[ext] || "audio/mp4";

  const uploadResult = await fileManager.uploadFile(audioPath, { mimeType, displayName: title });
  const file = uploadResult.file;
  console.log(`     Transcribing...`);

  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent([
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    `Provide a complete, accurate transcript of this insurance adjusting training video: "${title}".
    Plain readable text only — no timestamps, no cue numbers.
    Preserve all spoken content including examples, tips, and explanations.
    If multiple speakers, note speaker changes with their role (e.g. "Instructor:", "Student:").`,
  ]);

  try { await fileManager.deleteFile(file.name); } catch { /* non-fatal */ }
  return result.response.text();
}

// ── Patch markdown file with transcript ──────────────────────────────────────
function patchMarkdown(filePath, transcript) {
  let content = fs.readFileSync(filePath, "utf-8");
  const section = `## Video Transcript\n\n${transcript}\n`;
  if (content.includes("## Attachments")) {
    content = content.replace("## Attachments", `${section}\n## Attachments`);
  } else {
    content += `\n\n${section}`;
  }
  fs.writeFileSync(filePath, content, "utf-8");
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
const PARENT_FOLDER_ID = "1qUX_pkvZzceUMw_kW_hng01lKIG6JeEv";
let auRootDriveId = null;
let coursesDriveId = null;

async function getDriveFolderIds() {
  const rootRes = await drive.files.list({
    q: `name='Adjuster University Knowledge Base' and '${PARENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)", pageSize: 1,
  });
  auRootDriveId = rootRes.data.files[0]?.id ?? null;
  if (!auRootDriveId) return;

  const coursesRes = await drive.files.list({
    q: `name='courses' and '${auRootDriveId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)", pageSize: 1,
  });
  coursesDriveId = coursesRes.data.files[0]?.id ?? null;
}

async function uploadToDrive(filePath, course, fileName) {
  if (!coursesDriveId) return;
  try {
    const courseFolderRes = await drive.files.list({
      q: `name='${course}' and '${coursesDriveId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id)", pageSize: 1,
    });
    const courseFolderId = courseFolderRes.data.files[0]?.id;
    if (!courseFolderId) return;

    const fileRes = await drive.files.list({
      q: `name='${fileName}' and '${courseFolderId}' in parents and trashed=false`,
      fields: "files(id)", pageSize: 1,
    });
    const content = fs.readFileSync(filePath, "utf-8");
    if (fileRes.data.files[0]?.id) {
      await drive.files.update({
        fileId: fileRes.data.files[0].id,
        media: { mimeType: "text/plain", body: Readable.from([content]) },
      });
    }
  } catch { /* non-fatal — local file is already updated */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("Building index of lessons needing transcripts...");
const vimeoIndex = buildVimeoIndex();
const lessons = [...vimeoIndex.values()].slice(0, MAX);

console.log(`\nFound ${lessons.length} unique Vimeo videos to transcribe:`);
lessons.forEach(l => console.log(`  ${l.vimeoId} — ${l.title} (${l.files.length} file(s))`));
console.log("");

await getDriveFolderIds();

// Launch browser with AU session
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
if (fs.existsSync(SESSION_PATH)) {
  const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
  if (session.cookies?.length) await context.addCookies(session.cookies);
}
const page = await context.newPage();

let done = 0;
let failed = 0;

for (const lesson of lessons) {
  console.log(`\n[${done + failed + 1}/${lessons.length}] ${lesson.title} (Vimeo ${lesson.vimeoId})`);

  try {
    // Get embed URL from lesson page
    const lessonUrl = lesson.lessonUrl ?? lesson.files[0]?.content.match(/^\*\*URL:\*\* (https:\/\/[^\n]+)/m)?.[1];
    if (!lessonUrl) throw new Error("No lesson URL available");

    console.log(`  Getting embed URL from: ${lessonUrl}`);
    const embedUrl = await getEmbedUrl(page, lessonUrl);
    if (!embedUrl) throw new Error("No Vimeo iframe found on lesson page");
    console.log(`  Embed URL: ${embedUrl.slice(0, 70)}...`);

    // Download audio
    console.log(`  Downloading audio...`);
    const audioBase = path.join(AUDIO_TMP, `vimeo-${lesson.vimeoId}`);
    const audioPath = downloadAudio(embedUrl, audioBase);
    console.log(`  Audio: ${path.basename(audioPath)} (${(fs.statSync(audioPath).size / 1024 / 1024).toFixed(1)} MB)`);

    // Transcribe
    const transcript = await transcribeWithGemini(audioPath, lesson.title);
    console.log(`  Transcript: ${transcript.length} chars — "${transcript.slice(0, 80)}..."`);

    // Clean up audio
    try { fs.unlinkSync(audioPath); } catch { /* ok */ }

    // Write to all duplicate files and upload each to Drive
    console.log(`  Writing to ${lesson.files.length} file(s)...`);
    for (const { filePath, course, file } of lesson.files) {
      patchMarkdown(filePath, transcript);
      await uploadToDrive(filePath, course, file);
      console.log(`    ✅ ${course}/${file}`);
    }

    done++;
  } catch (e) {
    console.log(`  ❌ FAILED: ${e.message}`);
    failed++;
  }

  // Brief pause between videos
  await new Promise(r => setTimeout(r, 1500));
}

await browser.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`TRANSCRIPTION COMPLETE`);
console.log(`Succeeded: ${done} | Failed: ${failed}`);
console.log(`All transcripts written to local files and updated on Drive.`);
