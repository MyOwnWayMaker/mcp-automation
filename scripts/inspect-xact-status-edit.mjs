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
const page = await context.newPage();

// Intercept network requests to see what updateStatus posts
const requests = [];
page.on("request", req => {
  if (req.method() !== "GET" || req.url().includes("status") || req.url().includes("update")) {
    requests.push({ method: req.method(), url: req.url(), body: req.postData() });
  }
});

await page.goto(`${BASE}/cxa/detail.jsp?mfn=${MFN}&src=ip`);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(5000);

// Click updateStatus(5) = Customer Contacted
console.log("Calling updateStatus(5)...");
await page.evaluate(() => window.updateStatus(5));
await page.waitForTimeout(3000);

// Check for dialogs/modals
console.log("URL:", page.url());
const dialogs = await page.locator('[role="dialog"], .modal, .mdl-dialog, dialog').all();
console.log("Dialogs found:", dialogs.length);

for (const d of dialogs) {
  const visible = await d.isVisible().catch(() => false);
  if (visible) {
    const text = await d.innerText().catch(() => "");
    const html = await d.innerHTML().catch(() => "");
    console.log("\nDialog text:", text.substring(0, 500));
    fs.writeFileSync("/tmp/xact_dialog.html", html);
    console.log("Dialog HTML saved");

    // Find inputs in dialog
    const inputs = await d.locator("input, textarea, select").all();
    for (const inp of inputs) {
      const id = await inp.getAttribute("id").catch(() => "");
      const name = await inp.getAttribute("name").catch(() => "");
      const type = await inp.getAttribute("type").catch(() => "");
      console.log(`  input: id="${id}" name="${name}" type="${type}"`);
    }
  }
}

// Also check if anything new appeared in the DOM
const bodyText = (await page.locator("body").innerText().catch(() => "")).substring(0, 2000);
console.log("\nBody after dialog open:");
console.log(bodyText);

await page.screenshot({ path: "/tmp/xact_dialog.png" });
fs.writeFileSync("/tmp/xact_after_dialog.html", await page.content());
console.log("Screenshot: /tmp/xact_dialog.png");

console.log("\nCaptured requests:", requests.length);
requests.forEach(r => console.log(`  ${r.method} ${r.url}`));

// Also try the notes tab
console.log("\n=== NOTES TAB ===");
await page.goto(`${BASE}/cxa/detail.jsp?mfn=${MFN}&src=ip`);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(4000);
await page.evaluate(() => window.gotoDetailTab('d_notes', '06SSNJ3', 'ip', false, 0));
await page.waitForTimeout(4000);
const notesText = (await page.locator("body").innerText().catch(() => "")).substring(0, 3000);
console.log(notesText);
fs.writeFileSync("/tmp/xact_notes.html", await page.content());

await browser.close();
