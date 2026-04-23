/**
 * Uploads ~/Desktop/adjuster-university-content to Google Drive.
 * Creates folder structure: Adjuster University Content / [course-name] / files
 * Uploads all .md files, index.json, needs-audio-transcription.json, and FAILED-TRANSCRIPTS-NOTES.md
 *
 * Run: node scripts/upload-to-drive.mjs
 */
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const CONTENT_DIR = path.join(process.env.HOME, "Desktop/adjuster-university-content");
const PARENT_FOLDER_ID = "1qUX_pkvZzceUMw_kW_hng01lKIG6JeEv"; // Cowork Context Files
const ROOT_FOLDER_NAME = "Adjuster University Content";
const CONCURRENCY = 5;

// Auth
const creds = JSON.parse(fs.readFileSync(process.env.GOOGLE_CREDENTIALS_PATH));
const token = JSON.parse(fs.readFileSync(process.env.GOOGLE_TOKEN_PATH));
const auth = new google.auth.OAuth2(
  creds.installed?.client_id || creds.web?.client_id,
  creds.installed?.client_secret || creds.web?.client_secret
);
auth.setCredentials(token);
const drive = google.drive({ version: "v3", auth });

// ── Helpers ───────────────────────────────────────────────────────────────────
async function findOrCreateFolder(name, parentId) {
  const res = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
    pageSize: 1,
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
  });
  return created.data.id;
}

async function uploadFile(localPath, name, parentId, retries = 3) {
  const content = fs.readFileSync(localPath, "utf8");
  const existing = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
  });
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (existing.data.files.length > 0) {
        await drive.files.update({
          fileId: existing.data.files[0].id,
          media: { mimeType: "text/plain", body: Readable.from([content]) },
        });
      } else {
        await drive.files.create({
          requestBody: { name, parents: [parentId] },
          media: { mimeType: "text/plain", body: Readable.from([content]) },
          fields: "id",
        });
      }
      return true;
    } catch (e) {
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else throw e;
    }
  }
}

async function runConcurrent(tasks, concurrency) {
  let i = 0;
  async function run() {
    while (i < tasks.length) {
      const idx = i++;
      await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("Setting up Google Drive folder structure...");
const rootId = await findOrCreateFolder(ROOT_FOLDER_NAME, PARENT_FOLDER_ID);
console.log(`Root folder ready: "${ROOT_FOLDER_NAME}" (${rootId})`);
console.log(`View: https://drive.google.com/drive/folders/${rootId}`);

// Top-level files
console.log("\nUploading top-level files...");
for (const fname of ["index.json", "needs-audio-transcription.json", "FAILED-TRANSCRIPTS-NOTES.md"]) {
  const fpath = path.join(CONTENT_DIR, fname);
  if (fs.existsSync(fpath)) {
    await uploadFile(fpath, fname, rootId);
    console.log(`  ✓ ${fname}`);
  }
}

// Course folders
const coursesDir = path.join(CONTENT_DIR, "courses");
const courses = fs.readdirSync(coursesDir).filter(f =>
  fs.statSync(path.join(coursesDir, f)).isDirectory()
);

let totalUploaded = 0;
let totalFailed = 0;

for (const course of courses) {
  const courseDir = path.join(coursesDir, course);
  const mdFiles = fs.readdirSync(courseDir).filter(f => f.endsWith(".md"));
  const folderName = course.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  console.log(`\nCourse: ${folderName} (${mdFiles.length} files)`);
  const courseFolderId = await findOrCreateFolder(folderName, rootId);

  const tasks = mdFiles.map(file => async () => {
    try {
      await uploadFile(path.join(courseDir, file), file, courseFolderId);
      totalUploaded++;
      process.stdout.write(`  ${totalUploaded} uploaded...\r`);
    } catch (e) {
      console.log(`\n  ✗ ${file}: ${e.message}`);
      totalFailed++;
    }
  });

  await runConcurrent(tasks, CONCURRENCY);
  console.log(`  ✓ Done — ${mdFiles.length} files`);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`UPLOAD COMPLETE`);
console.log(`Uploaded: ${totalUploaded} | Failed: ${totalFailed}`);
console.log(`\nDrive folder: https://drive.google.com/drive/folders/${rootId}`);
