import { chromium } from "playwright";
import fs from "fs";

const session = JSON.parse(fs.readFileSync("/Users/hakielmcqueen/mcp-automation/xactanalysis_session.json"));
const BASE = "https://www.xactanalysis.com/apps";
const MFN = "06SSNJ3";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
await context.addCookies(session.cookies);

// Intercept the AJAX POST
const finishRequests = [];
context.on("request", req => {
  if (req.url().includes("finish.do")) {
    finishRequests.push({ method: req.method(), url: req.url(), body: req.postData() });
  }
});
context.on("response", async resp => {
  if (resp.url().includes("finish.do")) {
    const body = await resp.text().catch(() => "");
    console.log("finish.do response:", body.substring(0, 500));
  }
});

const page = await context.newPage();
await page.goto(`${BASE}/cxa/detail.jsp?mfn=${MFN}&src=ip`);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(5000);

console.log("Calling updateStatus(5) for Customer Contacted...");
await page.evaluate(() => window.updateStatus(5));

// Wait for the dialog iframe to load
await page.waitForTimeout(3000);
const dlgFrame = page.frames().find(f => f.url().includes("dlg_updateStatus"));
if (!dlgFrame) {
  console.log("Dialog frame not found!");
  await browser.close();
  process.exit(1);
}
console.log("Found dialog iframe:", dlgFrame.url());

// Fill the date (set to today: 4/9/2026 → 2026-04-09 for the hidden field)
await dlgFrame.waitForLoadState("domcontentloaded");
await dlgFrame.evaluate(() => {
  document.getElementById('dateupdated').value = '2026-04-09';
  // Also set time to current
  document.getElementById('timeupdated').value = '10:00:00';
  // Add a note
  document.getElementById('notes').value = 'Test: Customer contacted via automation';
});

console.log("Date and notes filled. Clicking UPDATE STATUS...");
await dlgFrame.click('#updatestatus_button');
await page.waitForTimeout(5000);

console.log("\nPOST requests captured:", finishRequests.length);
finishRequests.forEach(r => {
  console.log(`  ${r.method} ${r.url}`);
  console.log(`  Body: ${(r.body || "").substring(0, 500)}`);
});

// Check result by reloading the page
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(4000);

const bodyText = (await page.locator("body").innerText().catch(() => "")).substring(0, 2000);
const contactIdx = bodyText.indexOf("Customer Contacted");
if (contactIdx >= 0) {
  console.log("\nWorkflow section after update:");
  console.log(bodyText.slice(contactIdx, contactIdx+200));
}

await browser.close();
