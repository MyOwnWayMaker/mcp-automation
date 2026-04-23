/**
 * Find the reports listing in the expanded claimList view.
 * The claimList expanded view had reportView.asp?reportID=20053042.
 * Find ALL report entries and understand the structure.
 */
import fs from "fs";

const s = JSON.parse(fs.readFileSync("filetrac_session.json", "utf-8"));
const { aspBase, aspCookies } = s;

const CLAIM_ID = "3701463";

async function fetchAsp(path) {
  const res = await fetch(aspBase + path, {
    headers: { "Cookie": aspCookies, "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  return res.text();
}

// Use the claimList expanded view
const listHtml = await fetchAsp(
  `/system/claimList.asp?allBranches=1&searchType=claimID&searchTgt=${CLAIM_ID}&expand=${CLAIM_ID}`
);

// Find all reportView links and surrounding context
const reportLinks = [...listHtml.matchAll(/reportView\.asp\?reportID=(\d+)/gi)];
console.log("reportView links found:", reportLinks.length);

for (const m of reportLinks) {
  const reportID = m[1];
  const idx = m.index;
  const context = listHtml.substring(Math.max(0, idx - 300), idx + 800);
  console.log(`\n=== reportID=${reportID} ===`);
  // Strip tags for readability
  const stripped = context.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  console.log(stripped.substring(0, 500));

  // Find the download/view link for this report
  const links = [...context.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]);
  console.log("Links:", links.filter(l => !l.includes(".css") && !l.includes(".gif") && l !== "#").slice(0, 10));
}

// Also check: is there a `reports.asp` for listing (not uploading)?
// Try reports.asp with different params
const candidates = [
  `/system/reports.asp?claimID=${CLAIM_ID}&GO=1`,
  `/system/reports.asp?claimFileID=81030678`,
  `/system/reports.asp?claimFileID=81030678&GO=1`,
];

console.log("\n=== Alternate reports.asp params ===");
for (const c of candidates) {
  const h = await fetchAsp(c);
  const reports = (h.match(/reportView\.asp\?reportID=/g) || []).length;
  const getDocs = (h.match(/pageName=GetDocument/g) || []).length;
  const dates = (h.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || []).length;
  console.log(`${c}: len=${h.length}, reportViewLinks=${reports}, getDocs=${getDocs}, dates=${dates}`);
}

// Check what the reportView.asp page actually loads (it uses loadContent() JS)
console.log("\n=== reportView.asp iframe/content loading ===");
const rvHtml = await fetchAsp(`/system/reportView.asp?reportID=20053042`);
// Find the loadContent function
const loadContent = rvHtml.match(/function loadContent[\s\S]{0,500}/);
console.log("loadContent:", loadContent ? loadContent[0] : "not found");
// Find any iframe or data load URLs
const iframeSrcs = [...rvHtml.matchAll(/(?:src|location|window\.open)\s*[=(]\s*["']([^"']+)/gi)].map(m => m[1]);
console.log("src/location refs:", iframeSrcs.filter(l => !l.includes(".css") && !l.includes(".gif")).slice(0, 20));

// Look for report file path in the report view
const viewSection = rvHtml.substring(rvHtml.length / 2).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\s+/g, " ");
console.log("Report view content:", viewSection.substring(0, 1000));
