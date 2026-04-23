import fs from "fs";

const s = JSON.parse(fs.readFileSync("filetrac_session.json", "utf-8"));
const { aspBase, aspCookies } = s;

const claimIDs = ["3701463", "3701193", "3699528", "3698860", "3698688", "3698545", "3693952"];

async function fetchAsp(path) {
  const res = await fetch(aspBase + path, {
    headers: { "Cookie": aspCookies, "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  return res.text();
}

for (const id of claimIDs) {
  const html = await fetchAsp("/system/claimDocuments.asp?claimID=" + id);

  // Find section after "Document Library" heading
  const docLibIdx = html.indexOf("Document Library");
  const afterDocLib = docLibIdx > -1 ? html.substring(docLibIdx, docLibIdx + 5000) : html;

  // Look for file links anywhere on page
  const allLinks = [...html.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
  const fileLinks = allLinks.filter(l => /\.(pdf|doc|docx|xls|xlsx|jpg|jpeg|png|zip|txt|esx)/i.test(l) && !l.includes("SaaS") && !l.includes("Privacy"));
  const getFileLinks = [...html.matchAll(/(getFile|downloadFile|fileDownload|viewFile|getDoc|docView)[^"'<]{0,100}/gi)].map(m => m[0]);
  const inputValues = [...html.matchAll(/value=["']([^"']*\.(?:pdf|doc|docx|xls|xlsx)[^"']*)/gi)].map(m => m[1]);
  const dateCount = (html.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || []).length;

  console.log(`\nClaim ${id}: dateCount=${dateCount}, fileLinks=${fileLinks.length}, getFileLinks=${getFileLinks.length}, inputValues=${inputValues.length}`);
  if (fileLinks.length) console.log("  fileLinks:", fileLinks.slice(0, 5));
  if (getFileLinks.length) console.log("  getFileLinks:", getFileLinks.slice(0, 3));
  if (inputValues.length) console.log("  inputValues:", inputValues.slice(0, 3));

  // Show content between Document Library and footer
  const footerIdx = afterDocLib.indexOf("SaaS Terms");
  const docContent = footerIdx > -1 ? afterDocLib.substring(0, footerIdx) : afterDocLib;
  // Strip scripts
  const stripped = docContent.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\s+/g, " ").substring(0, 500);
  console.log("  Content:", stripped);
}
