import { chromium } from "playwright";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });
import fs from "fs";

const NG_URL = "https://www.notarygadget.com";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

// Login
await page.goto(`${NG_URL}/UserLogin`);
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector('#txtUsername', { timeout: 20000 });
await page.fill('#txtUsername', process.env.NOTARYGADGET_EMAIL);
await page.fill('#txtPassword', process.env.NOTARYGADGET_PASSWORD);
await page.evaluate(() => window.Login());
await page.waitForTimeout(8000);

// Navigate to Signings and open first one
await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(3000);

const rows = await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').all();
const firstId = await rows[0].getAttribute("id");
const signingId = firstId.replace("trSigning", "");
console.log("Opening signing:", signingId);
await rows[0].click();
await page.waitForTimeout(3000);

// --- INVOICE PANEL ---
console.log("Opening invoice panel...");
await page.evaluate(() => window.ShowInvoice('', 'Invoicing'));
await page.waitForTimeout(3000);

const bodyText = (await page.locator("body").innerText().catch(() => "")).substring(0, 4000);
console.log("\n=== BODY AFTER ShowInvoice ===");
console.log(bodyText);

console.log("\n=== BUTTONS IN INVOICE PANEL ===");
const allBtns = await page.locator("div[onclick], button, input[type='button'], input[type='submit']").all();
for (const btn of allBtns) {
  const text = (await btn.innerText().catch(() => "")).trim().substring(0, 80);
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const id = await btn.getAttribute("id").catch(() => "");
  const val = await btn.getAttribute("value").catch(() => "");
  if ((text || onclick) && (onclick?.includes("mail") || onclick?.includes("Mail") || onclick?.includes("Send") || onclick?.includes("send") || onclick?.includes("Invoice") || onclick?.includes("invoice") || text.toLowerCase().includes("send") || text.toLowerCase().includes("email") || text.toLowerCase().includes("invoice"))) {
    console.log(`  id="${id}" onclick="${onclick}" val="${val}" text="${text}"`);
  }
}

fs.writeFileSync("/tmp/ng_invoice.html", await page.content());
await page.screenshot({ path: "/tmp/ng_invoice.png" });
console.log("\nSaved to /tmp/ng_invoice.html");

// --- DELETE CONFIRM ---
console.log("\n\n=== CONFIRM DELETE SIGNING ===");
// Close invoice panel first
await page.evaluate(() => window.CloseOperationWindow && window.CloseOperationWindow());
await page.waitForTimeout(1000);

await page.evaluate(() => window.ConfirmDeleteSigning());
await page.waitForTimeout(2000);

const deleteText = (await page.locator("body").innerText().catch(() => "")).substring(0, 2000);
const deleteIdx = deleteText.toLowerCase().indexOf("delete");
if (deleteIdx >= 0) {
  console.log(deleteText.slice(Math.max(0, deleteIdx - 100), deleteIdx + 500));
}

// Find confirm/yes buttons
console.log("\nDelete dialog buttons:");
const allBtns2 = await page.locator("div[onclick], button, input[type='button']").all();
for (const btn of allBtns2) {
  const text = (await btn.innerText().catch(() => "")).trim();
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  if (text.toLowerCase().includes("delete") || text.toLowerCase().includes("yes") || text.toLowerCase().includes("confirm") || onclick?.toLowerCase().includes("delete")) {
    console.log(`  onclick="${onclick}" text="${text}"`);
  }
}

fs.writeFileSync("/tmp/ng_delete.html", await page.content());
await page.screenshot({ path: "/tmp/ng_delete.png" });

await browser.close();
