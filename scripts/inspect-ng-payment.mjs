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

await page.goto(`${NG_URL}/UserLogin`);
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector('#txtUsername', { timeout: 20000 });
await page.fill('#txtUsername', process.env.NOTARYGADGET_EMAIL);
await page.fill('#txtPassword', process.env.NOTARYGADGET_PASSWORD);
await page.evaluate(() => window.Login());
await page.waitForTimeout(8000);

await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(3000);

// Open first signing row
const rows = await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').all();
const firstId = await rows[0].getAttribute("id");
console.log("Opening signing:", firstId);
await rows[0].click();
await page.waitForTimeout(2000);

// --- Dump signing summary buttons/links ---
console.log("=== SIGNING SUMMARY BUTTONS ===");
const allBtns = await page.locator("div[onclick], a[onclick], button").all();
for (const btn of allBtns) {
  const text = (await btn.innerText().catch(() => "")).trim().substring(0, 60);
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const id = await btn.getAttribute("id").catch(() => "");
  if (onclick) {
    console.log(`  id="${id}" onclick="${onclick}" text="${text}"`);
  }
}

// Now open the Payments tab / section
console.log("\n\n=== TRYING ShowInvoice Payments tab ===");
await page.evaluate(() => window.ShowInvoice('', 'Payments'));
await page.waitForTimeout(2000);

console.log("=== INPUTS AFTER Payments tab ===");
const inputs = await page.locator("input:visible, textarea:visible, select:visible").all();
for (const inp of inputs) {
  const id = await inp.getAttribute("id").catch(() => "");
  const name = await inp.getAttribute("name").catch(() => "");
  const type = await inp.getAttribute("type").catch(() => "");
  const val = await inp.inputValue().catch(() => "");
  const placeholder = await inp.getAttribute("placeholder").catch(() => "");
  console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" value="${val.substring(0,60)}"`);
}

console.log("\n=== BUTTONS AFTER Payments tab ===");
const btns2 = await page.locator("div[onclick], button, input[type='button']").all();
for (const btn of btns2) {
  const text = (await btn.innerText().catch(() => "")).trim().substring(0, 60);
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const id = await btn.getAttribute("id").catch(() => "");
  if (onclick && (onclick.toLowerCase().includes("pay") || onclick.toLowerCase().includes("save") || onclick.toLowerCase().includes("add"))) {
    console.log(`  id="${id}" onclick="${onclick}" text="${text}"`);
  }
}

fs.writeFileSync("/tmp/ng_payment.html", await page.content());
await page.screenshot({ path: "/tmp/ng_payment.png" });
console.log("\nSaved /tmp/ng_payment.html");
await browser.close();
