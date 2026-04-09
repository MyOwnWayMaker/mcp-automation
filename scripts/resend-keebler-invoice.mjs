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

await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(3000);

// Find Keebler row
const rows = await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').all();
for (const row of rows) {
  const text = await row.innerText().catch(() => "");
  if (text.toLowerCase().includes("keebler")) {
    await row.click();
    break;
  }
}
await page.waitForTimeout(2000);

await page.evaluate(() => window.ShowInvoice('', 'Invoicing'));
await page.waitForTimeout(2000);
await page.evaluate(() => window.CheckForUnsupportedEmailProvider('SendInvoice'));
await page.waitForTimeout(2000);

// Dump all visible inputs in the email dialog
console.log("=== EMAIL DIALOG FIELDS ===");
const inputs = await page.locator("input:visible, textarea:visible, select:visible").all();
for (const inp of inputs) {
  const id = await inp.getAttribute("id").catch(() => "");
  const name = await inp.getAttribute("name").catch(() => "");
  const placeholder = await inp.getAttribute("placeholder").catch(() => "");
  const val = await inp.inputValue().catch(() => "");
  console.log(`  id="${id}" name="${name}" placeholder="${placeholder}" value="${val.substring(0,80)}"`);
}

// Check for reply-to field
const replyToField = page.locator('#txtEmailReplyTo, input[id*="ReplyTo"], input[placeholder*="eply"]').first();
const hasReplyTo = await replyToField.isVisible().catch(() => false);
console.log("\nHas reply-to field:", hasReplyTo);

if (hasReplyTo) {
  await replyToField.fill('drupenterprise1@gmail.com');
  console.log("Set reply-to to drupenterprise1@gmail.com");
}

const toEmail = await page.inputValue('#txtEmailTo').catch(() => "");
const subject = await page.inputValue('#txtEmailSubject').catch(() => "");
console.log("Sending to:", toEmail);
console.log("Subject:", subject);

await page.evaluate(() => window.SendInvoice(false, undefined));
await page.waitForTimeout(3000);
console.log("Resent.");

await browser.close();
