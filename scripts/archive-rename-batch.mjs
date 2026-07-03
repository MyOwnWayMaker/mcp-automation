#!/usr/bin/env node
// Batch-rename Drive folders. Reads a JSON file: [{ "id": "...", "name": "new name" }, ...]
// Renames each via files.update, prints before/after. One Google auth for the whole batch.
import "./pipeline/env.mjs";
import fs from "fs";
import { google } from "googleapis";
const { getGoogleAuthClient } = await import("../dist/auth/google.js");

const jsonPath = process.argv[2];
if (!jsonPath) { console.error("usage: node scripts/archive-rename-batch.mjs <renames.json>"); process.exit(2); }
const items = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

const auth = await getGoogleAuthClient();
const drive = google.drive({ version: "v3", auth });

let ok = 0, fail = 0;
for (const it of items) {
  try {
    const before = await drive.files.get({ fileId: it.id, fields: "id, name" });
    if (before.data.name === it.name) { console.log(`SKIP (already named): ${it.name}`); ok++; continue; }
    const res = await drive.files.update({ fileId: it.id, requestBody: { name: it.name }, fields: "id, name" });
    console.log(`OK  "${before.data.name}"  ->  "${res.data.name}"`);
    ok++;
  } catch (e) {
    console.log(`FAIL ${it.id}: ${e.message}`);
    fail++;
  }
}
console.log(`\nDONE ok=${ok} fail=${fail}`);
