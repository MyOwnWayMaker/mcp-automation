#!/usr/bin/env node
// Backfill a claim's Drive folder from XactAnalysis.
//   node scripts/xa-backfill-claim.mjs <driveFolderId> <mfn> [mfn2 ...] [--dry-run]
//
// - Lists docs for each MFN (dedup by image_id across MFNs).
// - Downloads every doc and uploads into an "XA Documents (All)" subfolder.
// - Picks the LATEST-dated version of each key report type and ALSO uploads it
//   into an "Actual Submitted Reports" subfolder (the final/approved set Hakiel
//   wants to study against reviewer changes).
// Bytes stream XA -> Drive locally; nothing is printed except a manifest.
import "./pipeline/env.mjs";
import { google } from "googleapis";
const xa = await import("../dist/tools/xactanalysis.js");
const { getGoogleAuthClient } = await import("../dist/auth/google.js");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
const driveFolderId = positional[0];
const mfns = positional.slice(1);
if (!driveFolderId || mfns.length === 0) {
  console.error("usage: node scripts/xa-backfill-claim.mjs <driveFolderId> <mfn> [mfn2 ...] [--dry-run]");
  process.exit(2);
}

const unwrap = (r) => JSON.parse(r?.content?.[0]?.text || JSON.stringify(r));

// Clean XA's messy filenames + classify the document type.
function classify(filename) {
  const f = (filename || "").trim();
  const U = f.toUpperCase();
  if (/ADJASSIGNWORKSHEET/i.test(f)) return { type: "Assignment Worksheet", submitted: false, clean: "Assignment Worksheet.pdf" };
  if (/\bITEL\b/i.test(f)) return { type: "ITEL Report", submitted: true, clean: "ITEL Report.pdf" };
  if (/FINAL DRAFT WITH AGE/i.test(f)) return { type: "Final Estimate", submitted: true, clean: "Final Estimate (with Age, Life, Condition).pdf" };
  if (/FINAL REPORT|REPORT TO DA|FINAL ESTIMATE/i.test(U)) return { type: "Final Report to DA", submitted: true, clean: "Final Report to DA.pdf" };
  if (/GENERAL_LOSS/i.test(U)) return { type: "General Loss Report", submitted: true, clean: "General Loss Report (GLR).pdf" };
  if (/PHOTO_SHEET/i.test(U)) return { type: "Photo Sheet", submitted: true, clean: "Photo Sheet.pdf" };
  if (/VALIDATEREVIEW|VALIDATE REVIEW/i.test(U)) return { type: "Reviewer Validation Report", submitted: true, clean: "Reviewer Validation Report.pdf" };
  if (/VARIATION REPORT/i.test(U)) return { type: "Variation Report", submitted: true, clean: "Variation Report (reviewer changes).pdf" };
  if (/ESTIMATE AUDIT REPORT/i.test(U)) return { type: "Estimate Audit Report", submitted: true, clean: "Estimate Audit Report.pdf" };
  if (/AUDIT SUMMARY/i.test(U)) return { type: "Audit Summary Report", submitted: false, clean: "Audit Summary Report.pdf" };
  if (/REMOVAL DEPRECIATION/i.test(U)) return { type: "Final Draft Depreciation Report", submitted: false, clean: "Final Draft Depreciation Report.pdf" };
  if (/REPORT ROUGH DRAFT/i.test(U)) return { type: "Rough Draft Report", submitted: false, clean: "Rough Draft Report.pdf" };
  // fallback: keep original-ish name
  let clean = f.replace(/^[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M\s+/i, "").trim();
  if (!/\.[a-z0-9]{2,4}$/i.test(clean)) clean = (clean || "document").slice(0, 60) + ".pdf";
  return { type: "Other", submitted: false, clean };
}

function parseDate(d) {
  const t = Date.parse(d || "");
  return Number.isNaN(t) ? 0 : t;
}

const auth = await getGoogleAuthClient();
const drive = google.drive({ version: "v3", auth });

async function findOrCreateSubfolder(name) {
  const q = `'${driveFolderId}' in parents and name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q, fields: "files(id,name)" });
  if (res.data.files?.length) return res.data.files[0].id;
  if (dryRun) return "(dry-run-new)";
  const c = await drive.files.create({ requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [driveFolderId] }, fields: "id" });
  return c.data.id;
}

async function existingNames(folderId) {
  if (folderId === "(dry-run-new)") return new Set();
  const out = new Set();
  let pageToken;
  do {
    const res = await drive.files.list({ q: `'${folderId}' in parents and trashed=false`, fields: "nextPageToken, files(name)", pageToken });
    for (const f of res.data.files || []) out.add(f.name);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function uploadTo(folderId, name, base64, mime) {
  if (dryRun) return "(dry-run)";
  const buf = Buffer.from(base64, "base64");
  const { Readable } = await import("stream");
  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType: mime || "application/pdf", body: Readable.from(buf) },
    fields: "id",
  });
  return res.data.id;
}

// ── gather docs across all MFNs, dedup by image_id ──
const byId = new Map();
for (const mfn of mfns) {
  const list = unwrap(await xa.xactListDocuments({ mfn }));
  for (const d of list.documents || []) {
    if (!byId.has(d.image_id)) byId.set(d.image_id, { ...d, mfn });
  }
}
const docs = [...byId.values()];
console.log(`Gathered ${docs.length} unique documents across MFNs [${mfns.join(", ")}]`);

// classify + pick latest per submitted-type
for (const d of docs) { d.meta = classify(d.filename); d.ts = parseDate(d.date); }
const latestByType = new Map();
for (const d of docs) {
  if (!d.meta.submitted) continue;
  const cur = latestByType.get(d.meta.type);
  if (!cur || d.ts > cur.ts) latestByType.set(d.meta.type, d);
}
const submittedSet = new Set([...latestByType.values()].map((d) => d.image_id));

console.log("\n=== Actual Submitted Reports (latest per type) ===");
for (const d of latestByType.values()) console.log(`  [${d.meta.type}] ${d.meta.clean}  (${d.date})`);
console.log(`\n=== All XA Documents: ${docs.length} ===`);

if (dryRun) { console.log("\n(dry-run — no downloads/uploads performed)"); process.exit(0); }

const allFolder = await findOrCreateSubfolder("XA Documents (All)");
const submittedFolder = await findOrCreateSubfolder("Actual Submitted Reports");
const haveAll = await existingNames(allFolder);
const haveSub = await existingNames(submittedFolder);

let okCount = 0, skip = 0, fail = 0;
// number duplicate clean-names within the All folder
const nameUse = new Map();
for (const d of docs.sort((a, b) => a.ts - b.ts)) {
  try {
    // download once
    const dl = unwrap(await xa.xactDownloadDocument({ mfn: d.mfn, image_id: d.image_id, filename: d.meta.clean }));
    if (!dl.ok) { console.log(`FAIL download ${d.meta.clean} (${d.image_id}): ${dl.note || dl.status}`); fail++; continue; }

    // unique name in All folder (prefix date to preserve revision history)
    const datePart = (d.date || "").replace(/[^0-9A-Za-z]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "nodate";
    let allName = `${datePart}_${d.meta.clean}`;
    const n = (nameUse.get(allName) || 0) + 1; nameUse.set(allName, n);
    if (n > 1) allName = allName.replace(/(\.[a-z0-9]+)$/i, `_${n}$1`);

    if (!haveAll.has(allName)) { await uploadTo(allFolder, allName, dl.base64, dl.content_type); okCount++; }
    else skip++;

    // curated submitted copy (clean name, no date prefix)
    if (submittedSet.has(d.image_id) && !haveSub.has(d.meta.clean)) {
      await uploadTo(submittedFolder, d.meta.clean, dl.base64, dl.content_type);
    }
  } catch (e) { console.log(`FAIL ${d.meta.clean}: ${e.message}`); fail++; }
}
console.log(`\nDONE uploaded=${okCount} skipped(existing)=${skip} failed=${fail}`);
console.log(`  All docs folder:        ${allFolder}`);
console.log(`  Submitted reports folder: ${submittedFolder}`);
