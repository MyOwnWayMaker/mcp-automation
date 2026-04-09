import { chromium } from "playwright";
import fs from "fs";

const session = JSON.parse(fs.readFileSync("/Users/hakielmcqueen/mcp-automation/xactanalysis_session.json"));
const BASE = "https://www.xactanalysis.com/apps";
const MFN = "06SSNJ3"; // claim 1095394

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
await context.addCookies(session.cookies);
const page = await context.newPage();

await page.goto(`${BASE}/cxa/detail.jsp?mfn=${MFN}&src=ip`);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(5000);

// --- Inspect edit buttons in Workflow Status ---
console.log("=== WORKFLOW STATUS EDIT BUTTONS ===");
const editBtns = await page.locator('button, [role="button"], .edit, a').filter({ hasText: /^edit$/ }).all();
console.log("Edit elements found:", editBtns.length);
for (const btn of editBtns) {
  const tag = await btn.evaluate(el => el.tagName);
  const cls = await btn.getAttribute("class").catch(() => "");
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const ngClick = await btn.getAttribute("ng-click").catch(() => "");
  const dataAction = await btn.getAttribute("data-action").catch(() => "");
  const ariaLabel = await btn.getAttribute("aria-label").catch(() => "");
  console.log(`  <${tag}> class="${cls}" onclick="${onclick}" ng-click="${ngClick}" data-action="${dataAction}" aria-label="${ariaLabel}"`);
}

// Look for workflow edit controls in HTML
const html = await page.content();
const workflowSection = html.match(/Workflow Status[\s\S]{0,5000}/)?.[0] ?? "";
fs.writeFileSync("/tmp/xact_workflow.txt", workflowSection.substring(0, 5000));
console.log("\nWorkflow section (first 2000 chars):");
console.log(workflowSection.substring(0, 2000));

// --- Click "edit" for Customer Contacted ---
console.log("\n=== CLICKING EDIT FOR CUSTOMER CONTACTED ===");
// Try clicking the first edit button/link
const firstEdit = page.locator('button:has-text("edit"), a:has-text("edit"), [aria-label*="edit" i], .material-icons:has-text("edit")').first();
const firstEditCount = await firstEdit.count();
console.log("First edit element count:", firstEditCount);

if (firstEditCount > 0) {
  await firstEdit.click();
  await page.waitForTimeout(2000);
  console.log("URL after edit click:", page.url());

  // Check for modal/dialog
  const modal = await page.locator('[role="dialog"], .modal, .dialog, .popup').first();
  if (await modal.count() > 0) {
    const modalText = await modal.innerText().catch(() => "");
    console.log("Modal text:", modalText.substring(0, 500));
    const modalHtml = await modal.innerHTML().catch(() => "");
    fs.writeFileSync("/tmp/xact_modal.html", modalHtml);
    console.log("Modal HTML saved to /tmp/xact_modal.html");
  }

  // Check what changed on page
  const newInputs = await page.locator("input:visible, textarea:visible").all();
  console.log("\nVisible inputs after edit click:");
  for (const inp of newInputs) {
    const id = await inp.getAttribute("id").catch(() => "");
    const name = await inp.getAttribute("name").catch(() => "");
    const type = await inp.getAttribute("type").catch(() => "");
    const val = await inp.inputValue().catch(() => "");
    console.log(`  id="${id}" name="${name}" type="${type}" value="${val.substring(0,50)}"`);
  }

  await page.screenshot({ path: "/tmp/xact_after_edit.png" });
  fs.writeFileSync("/tmp/xact_after_edit.html", await page.content());
}

// --- Navigate to NOTES tab ---
console.log("\n=== NOTES TAB ===");
await page.goto(`${BASE}/cxa/detail.jsp?mfn=${MFN}&src=ip`);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(4000);

await page.evaluate((mfn) => window.gotoDetailTab('d_notes', mfn, 'ip', false, 0), MFN);
await page.waitForTimeout(4000);

console.log("URL after notes tab:", page.url());
const notesText = (await page.locator("body").innerText().catch(() => "")).substring(0, 3000);
console.log(notesText);

fs.writeFileSync("/tmp/xact_notes_tab.html", await page.content());
await page.screenshot({ path: "/tmp/xact_notes.png" });

await browser.close();
