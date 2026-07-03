#!/usr/bin/env node
// Rename a Drive file/folder by ID using the MCP server's Google auth.
// Usage: node scripts/drive-rename-folder.mjs <file_id> <new name>
import "./pipeline/env.mjs";
import { google } from "googleapis";
const { getGoogleAuthClient } = await import("../dist/auth/google.js");

const [fileId, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ");
if (!fileId || !name) {
  console.error("usage: node scripts/drive-rename-folder.mjs <file_id> <new name>");
  process.exit(2);
}

const auth = await getGoogleAuthClient();
const drive = google.drive({ version: "v3", auth });
const res = await drive.files.update({
  fileId,
  requestBody: { name },
  fields: "id, name, webViewLink",
});
console.log(JSON.stringify(res.data, null, 2));
