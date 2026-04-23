/**
 * Test: download a report using the data-path URL directly.
 * Also extract all 3 report entries from the claimList expanded view.
 */
import fs from "fs";
import path from "path";

const s = JSON.parse(fs.readFileSync("filetrac_session.json", "utf-8"));
const { aspBase, aspCookies } = s;

const CLAIM_ID = "3701463";

async function fetchAsp(url, isFull = false) {
  const res = await fetch(isFull ? url : aspBase + url, {
    headers: { "Cookie": aspCookies, "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  return res;
}

// 1. Get claimList expanded view and extract all report entries
const listRes = await fetchAsp(
  `/system/claimList.asp?allBranches=1&searchType=claimID&searchTgt=${CLAIM_ID}&expand=${CLAIM_ID}`
);
const listHtml = await listRes.text();

// Find all data-reportid spans
const reportSpans = [...listHtml.matchAll(/<span[^>]+data-reportid="(\d+)"[^>]+data-path="([^"]+)"/gi)];
console.log("Report spans found:", reportSpans.length);

for (const m of reportSpans) {
  const reportID = m[1];
  const dataPath = m[2];

  // Find surrounding context (go back 1000 chars to find title and date)
  const startIdx = Math.max(0, m.index - 1200);
  const context = listHtml.substring(startIdx, m.index + 500);

  // Extract title from the last <a href="reportEdit_..."> before this span
  const titleMatch = context.match(/reportEdit_TrackEditRpt[^"]+">([^<]+)<\/a[^>]*>\s*\(<i>([^<]+)<\/i>\)\s*-\s*([^<\n]+)/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const fileType = titleMatch ? titleMatch[2].trim() : "";
  const description = titleMatch ? titleMatch[3].trim() : "";

  // Extract size
  const sizeMatch = context.match(/>(\d+KB)</i);
  const size = sizeMatch ? sizeMatch[1] : "";

  // Extract date (looking for date pattern before the report entry)
  const dateMatches = [...context.matchAll(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g)];
  const date = dateMatches.length > 0 ? dateMatches[dateMatches.length - 1][1] : "";

  console.log(`\nReport ${reportID}:`);
  console.log(`  Title: ${title}`);
  console.log(`  Type: ${fileType}`);
  console.log(`  Description: ${description}`);
  console.log(`  Size: ${size}`);
  console.log(`  Date: ${date}`);
  console.log(`  Path: ${dataPath}`);
}

// 2. Test downloading a file using data-path directly
console.log("\n=== Test direct download ===");
const testPath = "https://claims.filetrac.net/system/./ENCLOSURES/PREMIER_CLAIMS_SERVICE__LLC_1/202604/3701463_20260421144704026.pdf";
const dlRes = await fetchAsp(testPath, true);
console.log("Status:", dlRes.status);
console.log("Content-Type:", dlRes.headers.get("content-type"));
console.log("Content-Length:", dlRes.headers.get("content-length"));
const buf = Buffer.from(await dlRes.arrayBuffer());
console.log("Body size:", buf.length, "bytes");
console.log("PDF header:", buf.toString("ascii", 0, 5));

if (buf.toString("ascii", 0, 5) === "%PDF-") {
  const outPath = "/tmp/test_filetrac_report.pdf";
  fs.writeFileSync(outPath, buf);
  console.log("✅ PDF saved to:", outPath);
} else {
  // Maybe redirect to login or different URL
  console.log("❌ Not a PDF. First 500 chars:", buf.toString("utf-8", 0, 500));
}

// 3. Also look at full context for one of the other reportIDs
console.log("\n=== Context for report 20058656 ===");
const idx2 = listHtml.indexOf('data-reportid="20058656"');
if (idx2 > -1) {
  const ctx = listHtml.substring(Math.max(0, idx2 - 1500), idx2 + 500);
  // Extract relevant parts
  const dataPath2 = ctx.match(/data-path="([^"]+)"/)?.[1];
  const title2 = ctx.match(/reportEdit_TrackEditRpt[^"]+">([^<]+)<\/a/i)?.[1];
  const type2 = ctx.match(/\(<i>([^<]+)<\/i>\)/i)?.[1];
  const size2 = ctx.match(/>(\d+KB)</i)?.[1];
  const dates2 = [...ctx.matchAll(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g)].map(m => m[1]);
  console.log("Title:", title2?.trim());
  console.log("Type:", type2?.trim());
  console.log("Size:", size2);
  console.log("Dates:", dates2);
  console.log("Path:", dataPath2);
}
