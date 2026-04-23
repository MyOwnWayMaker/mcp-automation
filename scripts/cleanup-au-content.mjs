/**
 * Cleans up Adjuster University lesson .md files.
 *
 * Removes:
 * 1. All "You don't currently have access to this content" lines
 * 2. The sidebar navigation block that gets captured between the no-access lines
 *    and the actual lesson summary (course nav lists like "Xactimate GOLD Training Suite",
 *    "Previous Lesson", "Next Lesson", "X% COMPLETE", etc.)
 * 3. Collapses 3+ consecutive blank lines into 2
 *
 * Rewrites files in-place, then re-uploads only changed files to Drive.
 *
 * Run: node scripts/cleanup-au-content.mjs
 */

import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { Readable } from "stream";

const HOME = process.env.HOME;
const CONTENT_DIR = path.join(HOME, "Desktop/adjuster-university-content");
const MCP_DIR = "/Users/hakielmcqueen/mcp-automation";

// ── Drive auth ────────────────────────────────────────────────────────────────
const credentials = JSON.parse(fs.readFileSync(`${MCP_DIR}/credentials.json`, "utf-8"));
const token = JSON.parse(fs.readFileSync(`${MCP_DIR}/token.json`, "utf-8"));
const { client_secret, client_id, redirect_uris } = credentials.installed ?? credentials.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(token);
const drive = google.drive({ version: "v3", auth });

// ── Cleanup logic ─────────────────────────────────────────────────────────────

function isUsefulContentLine(trimmed) {
  if (trimmed === "") return true; // keep blank lines (collapsed later)

  // Long prose lines are real content
  if (trimmed.length > 100) return true;

  // Summary headers like "13 Wyndamere Court - Summary"
  if (/ - Summary\s*$/.test(trimmed)) return true;

  // Explicitly exclude nav patterns even if they have colons
  if (/^(Lesson|Chapter|Topic)\s+\d+/i.test(trimmed)) return false;
  if (/^\d+ Topics?$/i.test(trimmed)) return false;

  // Key-value pairs with a real value (e.g. "Type of Damage: Ice Dam", "Claim Estimate: $3,335.77")
  // Key must be 4-40 chars, value must be at least 3 chars
  if (/^[A-Za-z][^:]{3,40}:\s*.{3,}$/.test(trimmed)) return true;

  return false;
}

function cleanContent(original) {
  const lines = original.split("\n");
  const result = [];
  let inContentSection = false;
  let consecutiveBlanks = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track section
    if (trimmed.startsWith("## ")) {
      inContentSection = trimmed === "## Content";
    }

    // Inside Content section: only keep useful lines
    if (inContentSection && trimmed !== "## Content") {
      if (!isUsefulContentLine(trimmed)) continue;
    }

    // Collapse 3+ consecutive blank lines to 2
    if (trimmed === "") {
      consecutiveBlanks++;
      if (consecutiveBlanks <= 2) result.push(line);
    } else {
      consecutiveBlanks = 0;
      result.push(line);
    }
  }

  return result.join("\n");
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function findFolder(name, parentId) {
  const res = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
  });
  return res.data.files[0]?.id ?? null;
}

async function findFile(name, parentId) {
  const res = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
  });
  return res.data.files[0]?.id ?? null;
}

async function updateFile(fileId, content) {
  await drive.files.update({
    fileId,
    media: { mimeType: "text/plain", body: Readable.from([content]) },
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
// Find the root AU KB folder on Drive
const PARENT_FOLDER_ID = "1qUX_pkvZzceUMw_kW_hng01lKIG6JeEv";
const rootId = await findFolder("Adjuster University Knowledge Base", PARENT_FOLDER_ID);
if (!rootId) {
  console.error("Could not find 'Adjuster University Knowledge Base' folder on Drive. Run upload-knowledge-to-drive.mjs first.");
  process.exit(1);
}
const coursesDriveFolderId = await findFolder("courses", rootId);

console.log("Cleaning and re-uploading Adjuster University content...\n");

const coursesDir = path.join(CONTENT_DIR, "courses");
const courses = fs.readdirSync(coursesDir).filter(f =>
  fs.statSync(path.join(coursesDir, f)).isDirectory()
);

let totalCleaned = 0;
let totalUploaded = 0;
let totalFailed = 0;

for (const course of courses) {
  const courseDir = path.join(coursesDir, course);
  const mdFiles = fs.readdirSync(courseDir).filter(f => f.endsWith(".md"));
  const folderName = course.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  // Find this course's Drive folder
  const courseDriveFolderId = coursesDriveFolderId
    ? await findFolder(folderName, coursesDriveFolderId)
    : null;

  let courseChanged = 0;
  process.stdout.write(`${folderName}: `);

  for (const file of mdFiles) {
    const filePath = path.join(courseDir, file);
    const original = fs.readFileSync(filePath, "utf-8");
    const cleaned = cleanContent(original);

    if (cleaned === original) {
      process.stdout.write(".");
      continue; // No change needed
    }

    // Write cleaned version back to disk
    fs.writeFileSync(filePath, cleaned, "utf-8");
    totalCleaned++;
    courseChanged++;

    // Re-upload to Drive if we have the folder
    if (courseDriveFolderId) {
      try {
        const fileId = await findFile(file, courseDriveFolderId);
        if (fileId) {
          await updateFile(fileId, cleaned);
          totalUploaded++;
          process.stdout.write("U");
        } else {
          process.stdout.write("?"); // File not found on Drive
        }
      } catch (e) {
        totalFailed++;
        process.stdout.write("!");
      }
    } else {
      process.stdout.write("W"); // Written locally, no Drive folder found
    }
  }

  console.log(` — ${courseChanged} files updated`);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`CLEANUP COMPLETE`);
console.log(`Files cleaned (local): ${totalCleaned}`);
console.log(`Files re-uploaded to Drive: ${totalUploaded}`);
console.log(`Failed uploads: ${totalFailed}`);
