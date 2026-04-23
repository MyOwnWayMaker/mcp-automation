/**
 * POST the document search form and analyze the full response.
 * Then examine the HTML structure of results vs. empty state.
 */
import fs from "fs";

const s = JSON.parse(fs.readFileSync("filetrac_session.json", "utf-8"));
const { aspBase, aspCookies } = s;

const CLAIM_ID = "3701463";
const CLAIM_FID = "81030678";
const CSR_TOKEN = "{F4DF8F16-4646-44F9-9653-F2DA859ADEFD}"; // will get fresh one

// First GET to get a fresh CSR token
const getRes = await fetch(`${aspBase}/system/claimDocuments.asp?claimID=${CLAIM_ID}`, {
  headers: { "Cookie": aspCookies, "User-Agent": "Mozilla/5.0" },
  redirect: "follow",
});
const getHtml = await getRes.text();

// Extract CSR token
const csrMatch = getHtml.match(/pageLayout_CSRtoken[^>]+value="([^"]+)"/);
const csrToken = csrMatch ? csrMatch[1] : "";
console.log("CSR token:", csrToken);

// POST with all docs (category 0 = ALL)
const postBody = new URLSearchParams({
  pageLayout_CSRtoken: csrToken,
  DocCategory1: "0",
  searchTxt: "",
  formNumber: "",
  claimID: CLAIM_ID,
  claimFileID: CLAIM_FID,
  allBranches: "",
  pageLayout_fieldCount: "0",
});

const postRes = await fetch(`${aspBase}/system/claimDocuments.asp?GO=1&claimID=${CLAIM_ID}`, {
  method: "POST",
  headers: {
    "Cookie": aspCookies,
    "User-Agent": "Mozilla/5.0",
    "Content-Type": "application/x-www-form-urlencoded",
    "Referer": `${aspBase}/system/claimDocuments.asp?claimID=${CLAIM_ID}`,
  },
  body: postBody.toString(),
  redirect: "follow",
});

const postHtml = await postRes.text();
console.log("POST response length:", postHtml.length);

// Look for "no documents" message or similar
const noDocMatch = postHtml.match(/no (?:document|file|result)/i);
console.log("No-docs message:", noDocMatch ? noDocMatch[0] : "not found");

// Find the section after the Document Library heading in the response
const docIdx = postHtml.indexOf("Document Library");
const section = docIdx > -1 ? postHtml.substring(docIdx, docIdx + 8000) : postHtml;

// Strip scripts and collapse whitespace
const stripped = section.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\s+/g, " ");
console.log("\n=== Post-search Document Library section ===");
console.log(stripped.substring(0, 3000));

// Any table rows with actual data?
const rows = postHtml.match(/<tr[^>]*>[\s\S]{0,1000}?<\/tr>/gi) || [];
const dataRows = rows.filter(r => {
  const t = r.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 30 && !/mainnav|Copyright|Support|Privacy|twitter/i.test(t) && !/^<tr\s*>?\s*<\/tr>/.test(r);
});
console.log("\n=== Non-nav table rows ===");
dataRows.slice(0, 20).forEach((r, i) => {
  const text = r.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 200);
  const links = [...r.matchAll(/href=["']([^"']+)/gi)].map(m => m[1]);
  console.log(`Row ${i}: "${text}" | links: ${links.join(", ")}`);
});
