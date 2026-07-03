#!/usr/bin/env node
// Read-only walk of the Claims and Inspection Archive: root -> quarter -> month -> claim folders.
// Dumps JSON of every claim-level folder with its path + id. No writes.
import "./pipeline/env.mjs";
import { google } from "googleapis";
const { getGoogleAuthClient } = await import("../dist/auth/google.js");

const ROOT = process.argv[2] || "1sP3-7I5u8G7DY-LQrDBdYmdhmzOIYvD8"; // Claims and Inspection Archive

const auth = await getGoogleAuthClient();
const drive = google.drive({ version: "v3", auth });

async function listChildren(parentId) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 1000,
      pageToken,
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

const isFolder = (f) => f.mimeType === "application/vnd.google-apps.folder";

const result = { root: ROOT, quarters: [] };

const quarters = await listChildren(ROOT);
for (const q of quarters.sort((a, b) => a.name.localeCompare(b.name))) {
  const qEntry = { name: q.name, id: q.id, isFolder: isFolder(q), months: [], looseFiles: [] };
  if (!isFolder(q)) { result.quarters.push(qEntry); continue; }
  const months = await listChildren(q.id);
  for (const m of months.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isFolder(m)) { qEntry.looseFiles.push({ name: m.name, id: m.id, mimeType: m.mimeType }); continue; }
    const mEntry = { name: m.name, id: m.id, claims: [], looseFiles: [] };
    const claims = await listChildren(m.id);
    for (const c of claims.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isFolder(c)) mEntry.claims.push({ name: c.name, id: c.id });
      else mEntry.looseFiles.push({ name: c.name, id: c.id, mimeType: c.mimeType });
    }
    qEntry.months.push(mEntry);
  }
  result.quarters.push(qEntry);
}

console.log(JSON.stringify(result, null, 2));
