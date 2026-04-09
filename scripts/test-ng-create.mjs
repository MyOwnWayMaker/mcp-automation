import { chromium } from "playwright";
import "dotenv/config";

const email = process.env.NOTARYGADGET_EMAIL;
const password = process.env.NOTARYGADGET_PASSWORD;
const NG_URL = "https://www.notarygadget.com";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

await page.goto(`${NG_URL}/UserLogin`);
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector('#txtUsername', { timeout: 15000 });
await page.fill('#txtUsername', email);
await page.fill('#txtPassword', password);
await page.evaluate(() => window.Login());
await page.waitForTimeout(6000);

// Go to Signings tab
await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(3000);

// Click "New Signing" button
console.log("Clicking New Signing...");
await page.click('#tdNewSigningBtn');
await page.waitForTimeout(3000);

await page.screenshot({ path: "/tmp/ng_create.png" });

// Dump all visible inputs
console.log("\n=== INPUTS IN CREATE FORM ===");
const inputs = await page.locator("input:visible, select:visible, textarea:visible").all();
for (const inp of inputs) {
  const id = await inp.getAttribute("id");
  const name = await inp.getAttribute("name");
  const type = await inp.getAttribute("type");
  const placeholder = await inp.getAttribute("placeholder");
  const tag = await inp.evaluate(el => el.tagName);
  if (id || name) console.log({ tag, id, name, type, placeholder });
}

// Also click a signing row to see the detail view
console.log("\n=== CLICKING FIRST SIGNING ROW ===");
const firstRow = page.locator('tr[id^="trSigning"]').first();
const rowId = await firstRow.getAttribute("id");
console.log("Row ID:", rowId);
await firstRow.click();
await page.waitForTimeout(3000);

await page.screenshot({ path: "/tmp/ng_detail.png" });

// Dump inputs in detail view
console.log("\n=== INPUTS IN DETAIL VIEW ===");
const detailInputs = await page.locator("input:visible, select:visible, textarea:visible").all();
for (const inp of detailInputs) {
  const id = await inp.getAttribute("id");
  const name = await inp.getAttribute("name");
  const type = await inp.getAttribute("type");
  const tag = await inp.evaluate(el => el.tagName);
  if (id || name) console.log({ tag, id, name, type });
}

await browser.close();
console.log("\nScreenshots: /tmp/ng_create.png, /tmp/ng_detail.png");
