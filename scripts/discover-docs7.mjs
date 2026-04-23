/**
 * Examine reports.asp and reportView.asp to understand the document listing structure.
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

// 1. Examine reports.asp
console.log("=== reports.asp?claimID=" + CLAIM_ID + " ===");
const reportsHtml = await fetchAsp(`/system/reports.asp?claimID=${CLAIM_ID}`);
console.log("Length:", reportsHtml.length);

// Find all links
const allLinks = [...reportsHtml.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]).filter(l =>
  !l.includes(".css") && !l.includes(".gif") && !l.includes(".png") && l !== "#" && !l.startsWith("javascript")
);
console.log("\nAll non-asset links:");
allLinks.slice(0, 30).forEach(l => console.log(" ", l));

// Find GetDocument links
const getDocLinks = [...reportsHtml.matchAll(/SessionBridgeFromASP\.asp\?[^"'\s<]+pageName=GetDocument[^"'\s<]*/gi)].map(m => m[0]);
console.log("\nGetDocument links:", getDocLinks.length);
getDocLinks.slice(0, 5).forEach(l => {
  const pathMatch = l.match(/path=([^&"'\s]+)/);
  console.log(" ", pathMatch ? decodeURIComponent(pathMatch[1]) : l);
});

// Find reportView links
const reportViewLinks = [...reportsHtml.matchAll(/reportView\.asp\?[^"'\s<]*/gi)].map(m => m[0]);
console.log("\nreportView links:", reportViewLinks);

// Find date rows
const rows = reportsHtml.match(/<tr[^>]*>[\s\S]{0,600}?<\/tr>/gi) || [];
const dateRows = rows.filter(r => /\d{1,2}\/\d{1,2}\/\d{4}/.test(r) && !/mainnav|#186597/.test(r));
console.log("\nDate rows:", dateRows.length);
dateRows.slice(0, 10).forEach(r => {
  const text = r.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 300);
  const links = [...r.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]);
  console.log(`  "${text}" | links: ${links.slice(0, 3).join(", ")}`);
});

// Show a section of the reports content
const docIdx = reportsHtml.toLowerCase().indexOf("report");
console.log("\n=== reports.asp middle section ===");
const mid = Math.floor(reportsHtml.length / 2);
console.log(reportsHtml.substring(mid - 200, mid + 2000).replace(/\s+/g, " ").substring(0, 2000));

// 2. Check reportView.asp?reportID=20053042
console.log("\n=== reportView.asp?reportID=20053042 ===");
const reportViewHtml = await fetchAsp(`/system/reportView.asp?reportID=20053042`);
console.log("Length:", reportViewHtml.length);

const rvLinks = [...reportViewHtml.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]).filter(l =>
  !l.includes(".css") && !l.includes(".gif") && l !== "#"
);
console.log("Links:", rvLinks.slice(0, 20));

const rvGetDocs = [...reportViewHtml.matchAll(/SessionBridgeFromASP\.asp\?[^"'\s<]+pageName=GetDocument[^"'\s<]*/gi)].map(m => {
  const p = m[0].match(/path=([^&"'\s]+)/);
  return p ? decodeURIComponent(p[1]) : m[0];
});
console.log("GetDocument links:", rvGetDocs.slice(0, 5));
console.log("Length:", reportViewHtml.length);
const rvSection = reportViewHtml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\s+/g, " ");
console.log("Content:", rvSection.substring(rvSection.indexOf("Document Library") > 0 ? rvSection.indexOf("Document Library") : 0, 1000));
