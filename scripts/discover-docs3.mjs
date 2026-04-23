import fs from "fs";
import { chromium } from "playwright";

const s = JSON.parse(fs.readFileSync("filetrac_session.json", "utf-8"));
const { aspBase, aspCookies } = s;

// Use claim 3701463 (file# 81030678)
const CLAIM_ID = "3701463";
const CLAIM_FID = "81030678";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

const hostname = new URL(aspBase).hostname;
const cookieObjs = aspCookies.split(";").map(p => p.trim()).filter(Boolean).map(pair => {
  const eq = pair.indexOf("=");
  return { name: pair.substring(0, eq), value: pair.substring(eq + 1), domain: hostname, path: "/" };
});
await context.addCookies(cookieObjs);

const page = await context.newPage();

// Capture all network requests
const captured = [];
page.on("request", req => {
  const url = req.url();
  if (!url.endsWith(".css") && !url.endsWith(".js") && !url.includes("font-awesome") && !url.endsWith(".gif") && !url.endsWith(".png")) {
    captured.push({ method: req.method(), url, postData: req.postData() });
  }
});

await page.goto(`${aspBase}/system/claimDocuments.asp?claimID=${CLAIM_ID}`, {
  waitUntil: "networkidle",
  timeout: 30000,
});

// Print the form HTML
const formHtml = await page.evaluate(() => {
  const forms = document.querySelectorAll("form");
  return [...forms].map(f => f.outerHTML.substring(0, 2000)).join("\n\n===\n\n");
});
console.log("=== FORMS ===");
console.log(formHtml.substring(0, 3000));

// Try submitting the search form with empty criteria to get all documents
console.log("\n=== Submitting search form ===");
try {
  // Click the Search button
  await page.click("input[type=button][value=Search]", { timeout: 5000 });
  await page.waitForTimeout(3000);

  const afterContent = await page.content();
  const fileLinks = [...afterContent.matchAll(/href=["']([^"']+\.(?:pdf|doc|docx|xls|xlsx|jpg|png)[^"']*)/gi)].map(m => m[1]);
  console.log("File links after search:", fileLinks);

  // Look for table rows that are document entries
  const rows = afterContent.match(/<tr[^>]*>[\s\S]{0,600}?<\/tr>/gi) || [];
  const dateRows = rows.filter(r => /\d{1,2}\/\d{1,2}\/\d{4}/.test(r) && !/mainnav|navbar|#186597/.test(r));
  console.log("Date rows after search:", dateRows.length);
  dateRows.slice(0, 5).forEach(r => console.log(r.replace(/\s+/g, " ").substring(0, 400)));

  // Show all new requests made
  console.log("\nNew requests after click:", captured.filter(r => r.method === "POST").map(r => r.url + " | " + r.postData));
} catch (e) {
  console.log("Click failed:", e.message);
}

// Also look at the complete page source to understand document listing format
const fullContent = await page.content();
// Find what comes after the document library header
const docIdx = fullContent.indexOf("Document Library");
if (docIdx > -1) {
  const section = fullContent.substring(docIdx, docIdx + 5000)
    .replace(/<script[\s\S]*?<\/script>/gi, "[SCRIPT]")
    .replace(/\s+/g, " ");
  console.log("\n=== Document Library section ===");
  console.log(section.substring(0, 2000));
}

await browser.close();
