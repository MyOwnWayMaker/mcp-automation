import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

const MCP_DIR = "/Users/hakielmcqueen/mcp-automation";
const FOLDER_NAME = "Claude Context Files";

const credentials = JSON.parse(fs.readFileSync(`${MCP_DIR}/credentials.json`, "utf-8"));
const token = JSON.parse(fs.readFileSync(`${MCP_DIR}/token.json`, "utf-8"));

const { client_secret, client_id, redirect_uris } = credentials.installed ?? credentials.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(token);

const drive = google.drive({ version: "v3", auth });

async function findOrCreateFolder(name) {
  const res = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
  });
  if (res.data.files.length > 0) {
    console.log(`Found existing folder: ${name} (${res.data.files[0].id})`);
    return res.data.files[0].id;
  }
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder" },
    fields: "id",
  });
  console.log(`Created folder: ${name} (${created.data.id})`);
  return created.data.id;
}

async function uploadFile(filePath, folderId) {
  const name = path.basename(filePath);
  const content = fs.readFileSync(filePath, "utf-8");

  // Check if file already exists in folder
  const existing = await drive.files.list({
    q: `name='${name}' and '${folderId}' in parents and trashed=false`,
    fields: "files(id, name)",
  });

  if (existing.data.files.length > 0) {
    // Update existing
    await drive.files.update({
      fileId: existing.data.files[0].id,
      media: { mimeType: "text/plain", body: Readable.from([content]) },
    });
    console.log(`  Updated: ${name}`);
  } else {
    // Create new
    await drive.files.create({
      requestBody: { name, parents: [folderId] },
      media: { mimeType: "text/plain", body: Readable.from([content]) },
      fields: "id",
    });
    console.log(`  Uploaded: ${name}`);
  }
}

const FILES_TO_UPLOAD = [
  `${MCP_DIR}/XACTIMATE_PROJECT.md`,
  `${MCP_DIR}/src/index.ts`,
  `${MCP_DIR}/src/auth/google.ts`,
  `${MCP_DIR}/src/tools/gmail.ts`,
  `${MCP_DIR}/src/tools/calendar.ts`,
  `${MCP_DIR}/src/tools/drive.ts`,
  `${MCP_DIR}/src/tools/sheets.ts`,
  `${MCP_DIR}/src/tools/imessage.ts`,
  `${MCP_DIR}/src/tools/http.ts`,
  `${MCP_DIR}/package.json`,
  `${MCP_DIR}/tsconfig.json`,
  `${MCP_DIR}/SETUP.md`,
  `${MCP_DIR}/.env.example`,
];

(async () => {
  const folderId = await findOrCreateFolder(FOLDER_NAME);
  for (const file of FILES_TO_UPLOAD) {
    await uploadFile(file, folderId);
  }
  console.log("\nAll files uploaded to Google Drive → Claude Context Files");
})();
