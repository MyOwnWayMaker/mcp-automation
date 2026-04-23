/**
 * Check the expanded claimList view and claimView for report/document links.
 * This is where uploaded reports (PDFs, estimates) are shown.
 */
import fs from "fs";

const s = JSON.parse(fs.readFileSync("filetrac_session.json", "utf-8"));
const { aspBase, aspCookies } = s;

const CLAIM_ID = "3701463";
const CLAIM_FID = "81030678";

async function fetchAsp(path) {
  const res = await fetch(aspBase + path, {
    headers: { "Cookie": aspCookies, "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  return res.text();
}

// 1. Check claimList expanded view
console.log("=== claimList expanded view ===");
const listHtml = await fetchAsp(
  `/system/claimList.asp?allBranches=1&searchType=claimID&searchTgt=${CLAIM_ID}&expand=${CLAIM_ID}`
);
console.log("Length:", listHtml.length);

// Look for GetDocument links
const getDocLinks = [...listHtml.matchAll(/SessionBridgeFromASP\.asp\?[^"'\s<]+pageName=GetDocument[^"'\s<]*/gi)].map(m => {
  const pathMatch = m[0].match(/path=([^&"'\s]+)/);
  return pathMatch ? decodeURIComponent(pathMatch[1]) : m[0];
});
console.log("GetDocument links:", getDocLinks.length);
const claimSpecific = getDocLinks.filter(p => !p.includes("companyDocuments"));
console.log("Claim-specific:", claimSpecific.slice(0, 10));

// Look for report links with report IDs
const reportLinks = [...listHtml.matchAll(/reportView\.asp[^"'\s<]*/gi)].map(m => m[0]);
console.log("reportView links:", reportLinks.slice(0, 10));

const reportView2 = [...listHtml.matchAll(/reportGet[^"'\s<]*/gi)].map(m => m[0]);
console.log("reportGet links:", reportView2.slice(0, 10));

// Any .pdf, .doc, etc. links
const fileLinks = [...listHtml.matchAll(/href=["']([^"']+\.(?:pdf|doc|docx|xls|xlsx|jpg|png)[^"']*)/gi)].map(m => m[1]).filter(l => !l.includes("SaaS") && !l.includes("Privacy"));
console.log("File links:", fileLinks.slice(0, 10));

// Find table rows with dates
const rows = listHtml.match(/<tr[^>]*>[\s\S]{0,800}?<\/tr>/gi) || [];
const dataRows = rows.filter(r => {
  const t = r.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 50 && !/mainnav|Copyright|Support|Privacy|twitter|HINTS/i.test(t);
});

// Look for rows with "report" text
const reportRows = dataRows.filter(r => /report|upload|document/i.test(r) && !/function|var |script/i.test(r));
console.log("\nReport-related rows:", reportRows.length);
reportRows.slice(0, 5).forEach(r => {
  const text = r.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 300);
  const links = [...r.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]).filter(l => !l.includes(".css") && !l.includes(".gif"));
  console.log(`  "${text}" | links: ${links.join(", ")}`);
});

// 2. Check claimView.asp for reports
console.log("\n=== claimView.asp for reports ===");
const viewHtml = await fetchAsp(`/system/claimView.asp?claimID=${CLAIM_ID}`);
const viewGetDocLinks = [...viewHtml.matchAll(/SessionBridgeFromASP\.asp\?[^"'\s<]+pageName=GetDocument[^"'\s<]*/gi)].map(m => {
  const pathMatch = m[0].match(/path=([^&"'\s]+)/);
  return pathMatch ? decodeURIComponent(pathMatch[1]) : m[0];
});
const viewClaimSpecific = viewGetDocLinks.filter(p => !p.includes("companyDocuments"));
console.log("Claim-specific GetDocument links in claimView:", viewClaimSpecific.slice(0, 10));

const viewReportLinks = [...viewHtml.matchAll(/reportView\.asp[^"'\s<]*/gi)].map(m => m[0]);
console.log("reportView links in claimView:", viewReportLinks.slice(0, 10));

// 3. Check if there's a dedicated report view page
const candidates = [
  `/system/reportView.asp?claimID=${CLAIM_ID}`,
  `/system/claimReportView.asp?claimID=${CLAIM_ID}`,
  `/system/reports.asp?claimID=${CLAIM_ID}`,
  `/system/reportList.asp?claimID=${CLAIM_ID}`,
  `/system/claimReportList.asp?claimID=${CLAIM_ID}`,
];
console.log("\n=== Candidate report list pages ===");
for (const c of candidates) {
  const h = await fetchAsp(c);
  const hasDates = /\d{1,2}\/\d{1,2}\/\d{4}/.test(h);
  const hasReports = /report|upload|estimate/i.test(h.substring(h.length/2));
  const getDocCount = (h.match(/pageName=GetDocument/g) || []).length;
  console.log(`${c.split("?")[0].split("/").pop()}: len=${h.length}, dates=${hasDates}, reports=${hasReports}, getDocs=${getDocCount}`);
}
