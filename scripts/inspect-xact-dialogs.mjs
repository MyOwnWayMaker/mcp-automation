import { chromium } from "playwright";
import fs from "fs";

const session = JSON.parse(fs.readFileSync("/Users/hakielmcqueen/mcp-automation/xactanalysis_session.json"));
const BASE = "https://www.xactanalysis.com/apps";
const MFN = "06SSNJ3";
const CID = "6315015";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
await context.addCookies(session.cookies);
const page = await context.newPage();

// --- Inspect the status update dialog directly ---
console.log("=== STATUS UPDATE DIALOG (updateStatus=5, Customer Contacted) ===");
const dialogUrl = `${BASE}/shared/dlg_updateStatus.jsp?cid=${CID}&mfn=${MFN}&status=5&queue_id=&statusRecordId=&reason_id=undefined&user_type=&modalDlgId=1`;
await page.goto(dialogUrl);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(3000);

console.log("URL:", page.url());
const dialogText = (await page.locator("body").innerText().catch(() => "")).substring(0, 2000);
console.log(dialogText);

// Find form fields
console.log("\n=== DIALOG FORM FIELDS ===");
const inputs = await page.locator("input, textarea, select").all();
for (const inp of inputs) {
  const id = await inp.getAttribute("id").catch(() => "");
  const name = await inp.getAttribute("name").catch(() => "");
  const type = await inp.getAttribute("type").catch(() => "");
  const val = await inp.inputValue().catch(() => "");
  console.log(`  id="${id}" name="${name}" type="${type}" value="${val.substring(0,50)}"`);
}

// Find buttons/submit
const btns = await page.locator("button, input[type='submit'], input[type='button']").all();
for (const btn of btns) {
  const text = await btn.innerText().catch(() => "");
  const val = await btn.getAttribute("value").catch(() => "");
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  console.log(`  button: "${text || val}" onclick="${onclick}"`);
}

fs.writeFileSync("/tmp/xact_status_dialog.html", await page.content());
console.log("HTML saved to /tmp/xact_status_dialog.html");

// --- Notes tab: find "Add a Note" ---
console.log("\n=== NOTES TAB - ADD NOTE FORM ===");
const page2 = await context.newPage();
await page2.goto(`${BASE}/cxa/detail.jsp?mfn=${MFN}&src=ip`);
await page2.waitForLoadState("domcontentloaded");
await page2.waitForTimeout(4000);
await page2.evaluate(() => window.gotoDetailTab('d_notes', '06SSNJ3', 'ip', false, 0));
await page2.waitForTimeout(4000);

// Click "Add a Note"
const addNoteBtn = page2.locator('a:has-text("Add a Note"), button:has-text("Add a Note"), [aria-label*="Add a Note"]');
if (await addNoteBtn.count() > 0) {
  console.log("Found 'Add a Note' button, clicking...");
  await addNoteBtn.first().click();
  await page2.waitForTimeout(3000);

  const noteText = (await page2.locator("body").innerText().catch(() => "")).substring(0, 2000);
  console.log(noteText);

  const noteInputs = await page2.locator("input:visible, textarea:visible, select:visible").all();
  console.log("\nInputs after clicking Add a Note:");
  for (const inp of noteInputs) {
    const id = await inp.getAttribute("id").catch(() => "");
    const name = await inp.getAttribute("name").catch(() => "");
    const type = await inp.getAttribute("type").catch(() => "");
    const placeholder = await inp.getAttribute("placeholder").catch(() => "");
    console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}"`);
  }

  fs.writeFileSync("/tmp/xact_add_note.html", await page2.content());
  await page2.screenshot({ path: "/tmp/xact_add_note.png" });
} else {
  console.log("'Add a Note' not found. Body:", (await page2.locator("body").innerText().catch(() => "")).substring(0, 500));
}

await browser.close();
