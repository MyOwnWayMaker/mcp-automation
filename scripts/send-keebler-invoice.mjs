import { chromium } from "playwright";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

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
console.log("Logged in:", page.url());

await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(3000);

// Find the Keebler signing row
const rows = await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').all();
let keeblerRow = null;
let keeblerRowId = null;
for (const row of rows) {
  const text = await row.innerText().catch(() => "");
  if (text.toLowerCase().includes("keebler")) {
    keeblerRow = row;
    const id = await row.getAttribute("id");
    keeblerRowId = id?.replace("trSigning", "");
    console.log("Found Keebler row ID:", keeblerRowId);
    break;
  }
}

if (!keeblerRow) {
  console.error("Keebler signing not found!");
  await browser.close();
  process.exit(1);
}

await keeblerRow.click();
await page.waitForTimeout(2000);

// Open invoice panel
await page.evaluate(() => window.ShowInvoice('', 'Invoicing'));
await page.waitForTimeout(2000);

// Trigger email invoice dialog
await page.evaluate(() => window.CheckForUnsupportedEmailProvider('SendInvoice'));
await page.waitForTimeout(2000);

// Capture pre-filled values
const toEmail = await page.inputValue('#txtEmailTo').catch(() => "");
const subject = await page.inputValue('#txtEmailSubject').catch(() => "");
console.log("Sending to:", toEmail);
console.log("Subject:", subject);

// Send
await page.evaluate(() => window.SendInvoice(false, undefined));
await page.waitForTimeout(3000);

const body = (await page.locator("body").innerText().catch(() => "")).substring(0, 500);
console.log("After send body:", body);
await page.screenshot({ path: '/tmp/invoice_sent.png' });

await browser.close();
console.log("\nDone.");
