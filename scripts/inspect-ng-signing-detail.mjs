/**
 * Inspect a signing detail in NotaryGadget to find invoice send + delete controls.
 */
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
await page.waitForLoadState("domcontentloaded");

const url = page.url();
if (!url.includes("MyBusiness")) {
  console.error("Login failed, landed on:", url);
  await browser.close();
  process.exit(1);
}
console.log("Logged in. URL:", url);

// Navigate to Signings
await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(3000);

// Get first signing row and click it to open detail
const rows = await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').all();
console.log("Signing rows found:", rows.length);

if (rows.length === 0) {
  console.log("No signings found.");
  await browser.close();
  process.exit(0);
}

// Click first row to open detail
const firstId = await rows[0].getAttribute("id");
const signingId = firstId.replace("trSigning", "");
console.log("Opening signing ID:", signingId);
await rows[0].click();
await page.waitForTimeout(3000);

// Dump body text
const bodyText = (await page.locator("body").innerText().catch(() => "")).substring(0, 3000);
console.log("\n=== SIGNING DETAIL BODY ===");
console.log(bodyText);

// Look for invoice/delete buttons
console.log("\n=== ALL DIV BUTTONS (onclick) ===");
const divBtns = await page.locator("div[onclick], input[onclick], button").all();
for (const btn of divBtns) {
  const text = (await btn.innerText().catch(() => "")).trim().substring(0, 60);
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const id = await btn.getAttribute("id").catch(() => "");
  const val = await btn.getAttribute("value").catch(() => "");
  if (text || onclick) {
    console.log(`  id="${id}" onclick="${onclick}" value="${val}" text="${text}"`);
  }
}

// Save HTML for inspection
fs.writeFileSync("/tmp/ng_signing_detail.html", await page.content());
await page.screenshot({ path: "/tmp/ng_signing_detail.png" });
console.log("\nHTML saved to /tmp/ng_signing_detail.html");

await browser.close();
