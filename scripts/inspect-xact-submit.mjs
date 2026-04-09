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

// Intercept POST to status/finish.do
const requests = [];
context.on("request", req => {
  if (req.url().includes("finish.do") || req.url().includes("status")) {
    requests.push({ method: req.method(), url: req.url(), body: req.postData() });
  }
});

const page = await context.newPage();
await page.goto(`${BASE}/cxa/detail.jsp?mfn=${MFN}&src=ip`);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(5000);

// Call updateStatus(5) and wait for dialog to load
console.log("Calling updateStatus(5)...");
await page.evaluate(() => window.updateStatus(5));
await page.waitForTimeout(4000);

// Look for the modal content in the DOM
const allText = await page.locator("body").innerText().catch(() => "");
const updateStatusIdx = allText.indexOf("Update Status");
if (updateStatusIdx >= 0) {
  console.log("Found dialog in DOM:", allText.slice(updateStatusIdx, updateStatusIdx+300));
}

// Find the modal in DOM - it might be an iframe
const iframes = page.frames();
console.log("\nFrames:", iframes.map(f => f.url()));

// Check for any newly added dialog elements
const dialogs = await page.locator('.xa-modal, .modal, [data-modalid], #modalDlgId, .mdl-dialog, dialog, [role="dialog"]').all();
console.log("Dialog elements found:", dialogs.length);
for (const d of dialogs) {
  const visible = await d.isVisible().catch(() => false);
  const text = await d.innerText().catch(() => "");
  console.log(`  visible=${visible} text="${text.substring(0,100)}"`);
}

// Try to find the form statusform in the page
const statusForm = page.locator('#statusform, form[name="statusform"]');
if (await statusForm.count() > 0) {
  console.log("\nFound statusform!");
  const formInputs = await statusForm.locator("input, textarea, select").all();
  for (const inp of formInputs) {
    const name = await inp.getAttribute("name").catch(() => "");
    const val = await inp.inputValue().catch(() => "");
    if (name) console.log(`  ${name} = "${val.substring(0,50)}"`);
  }

  // Fill the date and submit
  console.log("\nFilling date and submitting...");
  await page.evaluate(() => {
    // Set date to today
    const dateEl = document.getElementById('dateupdated');
    if (dateEl) dateEl.value = '2026-04-09';
    const notesEl = document.getElementById('notes');
    if (notesEl) notesEl.value = 'Test note from automation';
  });

  // Click UPDATE STATUS
  await page.click('#updatestatus_button').catch(async () => {
    await page.evaluate(() => window.submitStatus && window.submitStatus());
  });
  await page.waitForTimeout(4000);

  console.log("After submit URL:", page.url());
}

// Save full page HTML after dialog loads
const fullHtml = await page.content();
fs.writeFileSync("/tmp/xact_with_dialog.html", fullHtml);
await page.screenshot({ path: "/tmp/xact_with_dialog.png" });

console.log("\nCaptured status requests:");
requests.forEach(r => console.log(`  ${r.method} ${r.url}\n  Body: ${(r.body || "").substring(0,200)}`));

await browser.close();
