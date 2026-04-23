/**
 * Uploads all extracted knowledge base content to Google Drive.
 * Creates organized folders and uploads all markdown files + PDFs.
 *
 * Run from Mac Terminal:
 *   node /Users/hakielmcqueen/mcp-automation/scripts/upload-knowledge-to-drive.mjs
 *
 * Options:
 *   --au       Upload Adjuster University content only
 *   --kajabi   Upload Kajabi content only
 *   --circle   Upload Circle community content only
 *   (no flag)  Upload all three
 */
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

const MCP_DIR = "/Users/hakielmcqueen/mcp-automation";
const HOME = process.env.HOME;

const credentials = JSON.parse(fs.readFileSync(`${MCP_DIR}/credentials.json`, "utf-8"));
const token = JSON.parse(fs.readFileSync(`${MCP_DIR}/token.json`, "utf-8"));
const { client_secret, client_id, redirect_uris } = credentials.installed ?? credentials.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(token);
const drive = google.drive({ version: "v3", auth });

const UPLOAD_AU = process.argv.includes("--au") || !process.argv.includes("--kajabi") && !process.argv.includes("--circle");
const UPLOAD_KAJABI = process.argv.includes("--kajabi") || !process.argv.includes("--au") && !process.argv.includes("--circle");
const UPLOAD_CIRCLE = process.argv.includes("--circle") || !process.argv.includes("--au") && !process.argv.includes("--kajabi");

// Parent folder in Google Drive for all knowledge base content
const PARENT_FOLDER_ID = "1qUX_pkvZzceUMw_kW_hng01lKIG6JeEv"; // Cowork Context Files

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function findOrCreateFolder(name, parentId) {
  const q = parentId
    ? `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const res = await drive.files.list({ q, fields: "files(id, name)" });
  if (res.data.files.length > 0) {
    console.log(`  Found folder: ${name} (${res.data.files[0].id})`);
    return res.data.files[0].id;
  }
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: "id",
  });
  console.log(`  Created folder: ${name} (${created.data.id})`);
  return created.data.id;
}

async function uploadFile(filePath, folderId) {
  const name = path.basename(filePath);
  const isPdf = filePath.endsWith(".pdf");
  const mimeType = isPdf ? "application/pdf" : "text/plain";

  const existing = await drive.files.list({
    q: `name='${name}' and '${folderId}' in parents and trashed=false`,
    fields: "files(id, name)",
  });

  const body = Readable.from([fs.readFileSync(filePath)]);

  if (existing.data.files.length > 0) {
    await drive.files.update({
      fileId: existing.data.files[0].id,
      media: { mimeType, body },
    });
    process.stdout.write("U");
  } else {
    await drive.files.create({
      requestBody: { name, parents: [folderId] },
      media: { mimeType, body },
      fields: "id",
    });
    process.stdout.write(".");
  }
}

// Upload all files in a local directory tree to a Drive folder tree
async function uploadDirectory(localDir, driveFolderId, depth = 0) {
  if (!fs.existsSync(localDir)) {
    console.log(`  Skipping (not found): ${localDir}`);
    return 0;
  }

  let count = 0;
  const entries = fs.readdirSync(localDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(localDir, entry.name);

    if (entry.isDirectory()) {
      const subFolderId = await findOrCreateFolder(entry.name, driveFolderId);
      count += await uploadDirectory(fullPath, subFolderId, depth + 1);
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".pdf") || entry.name.endsWith(".json")) {
      try {
        await uploadFile(fullPath, driveFolderId);
        count++;
      } catch (e) {
        console.log(`\n  Error uploading ${entry.name}: ${e.message}`);
      }
    }
  }

  return count;
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("Uploading knowledge base content to Google Drive...\n");

let total = 0;

if (UPLOAD_AU) {
  const auDir = path.join(HOME, "Desktop/adjuster-university-content");
  if (fs.existsSync(auDir)) {
    console.log("Creating Adjuster University Knowledge Base folder...");
    const folderId = await findOrCreateFolder("Adjuster University Knowledge Base", PARENT_FOLDER_ID);
    process.stdout.write("Uploading AU content: ");
    const count = await uploadDirectory(auDir, folderId);
    total += count;
    console.log(`\n  ${count} files uploaded`);
  } else {
    console.log("No Adjuster University content found. Run scrape-adjuster-university.mjs first.");
  }
}

if (UPLOAD_KAJABI) {
  const kajabiDir = path.join(HOME, "Desktop/kajabi-content");
  if (fs.existsSync(kajabiDir)) {
    console.log("\nCreating Kajabi Knowledge Base folder...");
    const folderId = await findOrCreateFolder("Kajabi Knowledge Base", PARENT_FOLDER_ID);
    process.stdout.write("Uploading Kajabi content: ");
    const count = await uploadDirectory(kajabiDir, folderId);
    total += count;
    console.log(`\n  ${count} files uploaded`);
  } else {
    console.log("No Kajabi content found. Run scrape-kajabi.mjs first.");
  }
}

if (UPLOAD_CIRCLE) {
  const circleDir = path.join(HOME, "Desktop/circle-content");
  if (fs.existsSync(circleDir)) {
    console.log("\nCreating Circle Community History folder...");
    const folderId = await findOrCreateFolder("Circle Community History", PARENT_FOLDER_ID);
    process.stdout.write("Uploading Circle content: ");
    const count = await uploadDirectory(circleDir, folderId);
    total += count;
    console.log(`\n  ${count} files uploaded`);
  } else {
    console.log("No Circle content found. Run circle-scraper.mjs --historical first.");
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`Upload complete. Total files: ${total}`);
console.log(`\nNext steps:`);
console.log(`  1. Open https://notebooklm.google.com`);
console.log(`  2. Create a new notebook`);
console.log(`  3. Click "Add sources" → Google Drive`);
console.log(`  4. Select "Adjuster University Knowledge Base" and/or "Kajabi Knowledge Base" folders`);
console.log(`  5. Start chatting with your course content`);
