/**
 * Understand the full document structure returned by claimDocuments.asp POST.
 * Find claim-specific uploaded documents (not general library docs).
 * Also check reportUpload.asp and the REPORTS button URL.
 */
import fs from "fs";

const s = JSON.parse(fs.readFileSync("filetrac_session.json", "utf-8"));
const { aspBase, aspCookies } = s;

const CLAIM_ID = "3701463";
const CLAIM_FID = "81030678";

async function fetchAsp(path, method = "GET", body = null, referer = "") {
  const headers = {
    "Cookie": aspCookies,
    "User-Agent": "Mozilla/5.0",
    "Referer": aspBase + referer,
  };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

  const res = await fetch(aspBase + path, { method, headers, body, redirect: "follow" });
  return res.text();
}

// 1. GET a fresh CSR token
const getHtml = await fetchAsp(`/system/claimDocuments.asp?claimID=${CLAIM_ID}`);
const csrMatch = getHtml.match(/pageLayout_CSRtoken[^>]+value="([^"]+)"/);
const csrToken = csrMatch ? csrMatch[1] : "";
console.log("CSR token:", csrToken);

// 2. POST the search form
const postBody = new URLSearchParams({
  pageLayout_CSRtoken: csrToken,
  DocCategory1: "0",
  searchTxt: "",
  formNumber: "",
  claimID: CLAIM_ID,
  claimFileID: CLAIM_FID,
  allBranches: "",
  pageLayout_fieldCount: "0",
}).toString();

const postHtml = await fetchAsp(
  `/system/claimDocuments.asp?GO=1&claimID=${CLAIM_ID}`,
  "POST",
  postBody,
  `/system/claimDocuments.asp?claimID=${CLAIM_ID}`
);

console.log("POST response length:", postHtml.length);

// Find ALL document rows — look for SessionBridgeFromASP.asp?...pageName=GetDocument
const docLinks = [...postHtml.matchAll(/SessionBridgeFromASP\.asp\?[^"'<\s]+pageName=GetDocument[^"'<\s]*/gi)].map(m => m[0]);
console.log(`\nTotal GetDocument links found: ${docLinks.length}`);

// Decode and analyze paths
const paths = docLinks.map(link => {
  const pathMatch = link.match(/path=([^&"'\s]+)/);
  if (!pathMatch) return null;
  try {
    return decodeURIComponent(pathMatch[1]);
  } catch {
    return pathMatch[1];
  }
}).filter(Boolean);

// Check if any are claim-specific (not companyDocuments general library)
const generalDocs = paths.filter(p => p.includes("companyDocuments"));
const claimSpecific = paths.filter(p => !p.includes("companyDocuments"));

console.log(`  General library docs: ${generalDocs.length}`);
console.log(`  Claim-specific docs: ${claimSpecific.length}`);

if (claimSpecific.length > 0) {
  console.log("\nClaim-specific document paths:");
  claimSpecific.slice(0, 10).forEach(p => console.log(" ", p));
}

// Find the boundary between general and claim-specific sections
const sections = postHtml.split(/(Client.Specific Documents|General Documents|Your Files|Uploaded Documents|Claim Documents)/i);
console.log("\nSection markers found:", sections.length - 1);
sections.forEach((s, i) => {
  if (i > 0 && i % 2 !== 0) console.log(`  Section: "${sections[i]}"`);
});

// Look for any heading that separates general from specific
const headings = [...postHtml.matchAll(/<(?:h[1-6]|strong|b|th|td\s+bgcolor)[^>]*>([^<]{5,80})<\/(?:h[1-6]|strong|b|th|td)>/gi)].map(m => m[1].trim());
const uniqueHeadings = [...new Set(headings)].filter(h => !/cookie|function|var |href|javascript|Copyright/i.test(h));
console.log("\nUnique headings:");
uniqueHeadings.slice(0, 30).forEach(h => console.log(" ", h));

// 3. Check reportUpload.asp to understand claim-specific docs
const uploadHtml = await fetchAsp(`/system/reportUpload.asp?claimID=${CLAIM_ID}`);
console.log("\n=== reportUpload.asp ===");
console.log("Length:", uploadHtml.length);
const uploadLinks = [...uploadHtml.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]).filter(l => !l.includes(".css") && !l.includes(".gif") && l !== "#" && !l.startsWith("javascript"));
console.log("Links:", uploadLinks.slice(0, 20));
const uploadSection = uploadHtml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\s+/g, " ");
console.log("Content:", uploadSection.substring(uploadHtml.indexOf("report") > 0 ? uploadHtml.toLowerCase().indexOf("report") : 0, 2000));

// 4. Check what URL openRpt() actually calls — look in the JS of the main claim list page
const claimListHtml = await fetchAsp(`/system/claimlist.asp`);
const openRptFn = claimListHtml.match(/function openRpt[\s\S]{0,500}/);
console.log("\n=== openRpt function ===");
console.log(openRptFn ? openRptFn[0] : "not found in claimlist.asp");

// Also look in claimView
const claimViewHtml = await fetchAsp(`/system/claimView.asp?claimID=${CLAIM_ID}`);
const openRptFn2 = claimViewHtml.match(/function openRpt[\s\S]{0,500}/);
const openRptFn3 = claimViewHtml.match(/openRpt[^)]+\)/g);
console.log("\nopenRpt in claimView:", openRptFn2 ? openRptFn2[0] : "not found");
console.log("openRpt calls in claimView:", openRptFn3 ? openRptFn3.slice(0, 5) : []);
