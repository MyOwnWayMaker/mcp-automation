/**
 * Find the reports LISTING page. We know reportView.asp?reportID=20053042
 * has the actual file path. Now find what generates the list of reportIDs for a claim.
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

// 1. reports.asp?claimID=3701463&GO=1 — what does it contain?
console.log("=== reports.asp?claimID=...&GO=1 ===");
const h1 = await fetchAsp(`/system/reports.asp?claimID=${CLAIM_ID}&GO=1`);
console.log("Length:", h1.length);

// Find all non-standard links
const links1 = [...h1.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]).filter(l =>
  !l.includes(".css") && !l.includes(".gif") && !l.includes(".png") && l !== "#" && !l.startsWith("javascript") && !l.includes("HINTS")
);
console.log("Links:", links1.slice(0, 20));

// Find reportView references
const rvRefs = [...h1.matchAll(/reportView[^"'\s<]*/gi)].map(m => m[0]);
console.log("reportView refs:", rvRefs.slice(0, 10));

// Date rows
const rows1 = h1.match(/<tr[^>]*>[\s\S]{0,800}?<\/tr>/gi) || [];
const dateRows1 = rows1.filter(r => /\d{1,2}\/\d{1,2}\/\d{4}/.test(r) && !/mainnav|186597/.test(r));
console.log("Date rows:", dateRows1.length);
dateRows1.slice(0, 10).forEach(r => {
  const text = r.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 300);
  const links = [...r.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]);
  console.log(`  "${text}" | links: ${links.slice(0, 3).join(", ")}`);
});

// Show content around "report" keyword
const repIdx = h1.toLowerCase().indexOf("first report");
if (repIdx > -1) {
  console.log("\nAround 'first report':", h1.substring(repIdx - 200, repIdx + 600).replace(/\s+/g, " "));
}

// 2. Look at claimList expanded view for the context around reportView link
console.log("\n=== claimList context around reportView ===");
const listHtml = await fetchAsp(
  `/system/claimList.asp?allBranches=1&searchType=claimID&searchTgt=${CLAIM_ID}&expand=${CLAIM_ID}`
);

const rvIdx = listHtml.indexOf("reportView.asp?reportID=20053042");
if (rvIdx > -1) {
  const context = listHtml.substring(Math.max(0, rvIdx - 2000), rvIdx + 1000);
  // Find all table rows in this section
  const rows = context.match(/<tr[^>]*>[\s\S]{0,800}?<\/tr>/gi) || [];
  console.log("Rows around reportView:", rows.length);
  rows.forEach(r => {
    const text = r.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 300);
    if (text.length > 20) {
      const links = [...r.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]).filter(l => !l.includes(".css") && !l.includes(".gif"));
      console.log(`  "${text}" | links: ${links.slice(0, 5).join(", ")}`);
    }
  });
}

// 3. Check reportView_rightMargin.asp which was referenced
console.log("\n=== reportView_rightMargin.asp?reportID=20053042 ===");
const rvm = await fetchAsp(`/system/reportView_rightMargin.asp?reportID=20053042`);
console.log("Length:", rvm.length);
const rvmLinks = [...rvm.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]).filter(l => !l.includes(".css") && !l.includes(".gif") && l !== "#");
console.log("Links:", rvmLinks.slice(0, 20));
const rvmContent = rvm.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
console.log("Content:", rvmContent.substring(0, 1000));

// 4. Is there a reports listing page accessible via the claimView tabs?
// Let me look at claimView to understand the tab structure
console.log("\n=== claimView.asp tab structure ===");
const cvHtml = await fetchAsp(`/system/claimView.asp?claimID=${CLAIM_ID}`);
// Find all tab-like links/buttons
const tabs = [...cvHtml.matchAll(/(?:tab|Tab|TAB)[^>]*>([^<]{2,30})</g)].map(m => m[0].substring(0, 80));
console.log("Tab refs:", tabs.slice(0, 20));

// Look for frame URLs in claimView
const frameSrcs = [...cvHtml.matchAll(/(?:frame src|iframe src)\s*=\s*["']([^"']+)/gi)].map(m => m[1]);
console.log("Frame srcs:", frameSrcs.slice(0, 10));

// Look for any section that shows reports
const reportSection = cvHtml.substring(cvHtml.toLowerCase().indexOf("report"));
const repSectionLinks = [...reportSection.substring(0, 3000).matchAll(/href=["']([^"']+)/gi)].map(m => m[1]).filter(l => !l.includes(".css") && !l.includes(".gif"));
console.log("Report section links:", repSectionLinks.slice(0, 20));
