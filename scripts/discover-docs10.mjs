/**
 * Find the reports section in claimList expanded view.
 * Look at raw HTML around the reportView link.
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

// Get the claimList expanded view
const listHtml = await fetchAsp(
  `/system/claimList.asp?allBranches=1&searchType=claimID&searchTgt=${CLAIM_ID}&expand=${CLAIM_ID}`
);

// Find reportView reference
const rvIdx = listHtml.indexOf("reportView.asp?reportID=20053042");
console.log("reportView index:", rvIdx);
if (rvIdx > -1) {
  // Show raw HTML 3000 chars before and 2000 after
  console.log("=== Raw context ===");
  console.log(listHtml.substring(Math.max(0, rvIdx - 3000), rvIdx + 1500));
}

// Also search for any "ENCLOSURES" or report path references
const enclIdx = listHtml.indexOf("ENCLOSURES");
console.log("\nENCLOSURES index:", enclIdx);
if (enclIdx > -1) {
  console.log(listHtml.substring(Math.max(0, enclIdx - 500), enclIdx + 500));
}

// Search for reportID pattern
const reportIDs = [...listHtml.matchAll(/reportID=(\d+)/gi)].map(m => m[1]);
console.log("\nAll reportIDs in page:", [...new Set(reportIDs)]);

// Check the dedicated report listing - maybe it's claimReports.asp
const candidates2 = [
  `/system/claimReports.asp?claimID=${CLAIM_ID}`,
  `/system/reportList2.asp?claimID=${CLAIM_ID}`,
  `/system/claimReportList2.asp?claimID=${CLAIM_ID}`,
  `/system/reportsList.asp?claimID=${CLAIM_ID}`,
];
console.log("\n=== More candidate pages ===");
for (const c of candidates2) {
  const h = await fetchAsp(c);
  const rids = (h.match(/reportID=\d+/g) || []).length;
  console.log(`${c.split("?")[0].split("/").pop()}: len=${h.length}, reportIDs=${rids}`);
}

// Check what the SessionBridgeFromASP.asp actually does for GetDocument
// Try to download the report we know about
console.log("\n=== Test downloading a report ===");
const encodedPath = encodeURIComponent("./ENCLOSURES/PREMIER_CLAIMS_SERVICE__LLC_1/202604/3701463_20260421144704026.pdf");
const dlUrl = `/system/SessionBridgeFromASP.asp?ActiveUserID=196002&disp=dl&pageName=GetDocument&path=${encodedPath}`;
console.log("Download URL:", aspBase + dlUrl);

const dlRes = await fetch(aspBase + dlUrl, {
  headers: { "Cookie": aspCookies, "User-Agent": "Mozilla/5.0" },
  redirect: "follow",
});
console.log("Download status:", dlRes.status);
console.log("Content-Type:", dlRes.headers.get("content-type"));
console.log("Content-Disposition:", dlRes.headers.get("content-disposition"));
console.log("Content-Length:", dlRes.headers.get("content-length"));
const body = await dlRes.arrayBuffer();
console.log("Body size:", body.byteLength, "bytes");
// Check if it's a PDF
const header = Buffer.from(body).toString("ascii", 0, 5);
console.log("File header:", header);
