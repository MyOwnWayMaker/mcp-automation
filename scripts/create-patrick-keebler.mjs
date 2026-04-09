import { chromium } from "playwright";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const NG_URL = "https://www.notarygadget.com";
const browser = await chromium.launch({ headless: false }); // visible so we can debug
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
console.log("Logged in:", page.url());

// Navigate to Signings
await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(3000);

// Open New Signing form
await page.evaluate(() => window.EditSigning('New'));
await page.waitForTimeout(3000);

// --- Customer: Pickford Escrow Company ---
// Open customer selector popup
await page.evaluate(() => window.ShowCustomerSelector());
await page.waitForTimeout(2000);

// Look for the search box in the selector and search for Pickford
const searchInput = page.locator('#txtCustomerSelectorSearch, input[id*="CustomerSelector"], input[placeholder*="earch"]').first();
if (await searchInput.isVisible().catch(() => false)) {
  await searchInput.fill('Pickford');
  await page.waitForTimeout(1500);
}

// Find and click the Pickford Escrow Company option
const pickfordOption = page.locator('div[onclick*="SelectCustomer"], td[onclick*="SelectCustomer"], .DropDownOption').filter({ hasText: /Pickford/i }).first();
if (await pickfordOption.isVisible().catch(() => false)) {
  await pickfordOption.click();
  await page.waitForTimeout(1000);
  console.log("Selected Pickford Escrow Company");
} else {
  // Try clicking any element with Pickford text
  const allPickford = await page.locator('text=Pickford').all();
  console.log(`Found ${allPickford.length} elements with 'Pickford'`);
  if (allPickford.length > 0) {
    await allPickford[0].click();
    await page.waitForTimeout(1000);
  }
}

// Verify customer was set
const customerVal = await page.$eval('#txtCustomer', el => el.value).catch(() => "not found");
console.log("Customer ID set to:", customerVal);

// --- Signer: Patrick Keebler ---
await page.fill('#txtSigner1First', 'Patrick');
await page.fill('#txtSigner1Last', 'Keebler');

// --- Address: 4328 Ben Ave, Studio City, CA ---
await page.fill('#txtSigningAdd1', '4328 Ben Ave');
await page.fill('#txtSigningCty', 'Studio City');
// State is already set to CA (default)
// Zip - leave blank or set
await page.fill('#txtSigningZp', '91604').catch(() => {});

// --- Date: April 7, 2026 → 04/07/2026 ---
await page.fill('#txtSigningDate', '04/07/2026');
await page.waitForTimeout(500);

// --- Time: 3:00 PM ---
await page.fill('#txtSigningHour', '3');
await page.fill('#txtSigningMinutes', '00');
await page.fill('#txtSigningAMPM', 'PM');

// --- Fee: $250 ---
await page.fill('#txtSigningFee', '250');

await page.screenshot({ path: '/tmp/before_save.png' });
console.log("Form filled. Saving...");

// Save
await page.evaluate(() => window.SaveSigning());
await page.waitForTimeout(5000);

console.log("After save URL:", page.url());
const body = (await page.locator("body").innerText().catch(() => "")).substring(0, 1000);
console.log("Body after save:", body.substring(0, 500));

await page.screenshot({ path: '/tmp/after_save.png' });

// Check if signing appeared in list
await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(3000);

const rows = await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').all();
console.log(`\nSignings count: ${rows.length}`);
for (let i = 0; i < Math.min(rows.length, 5); i++) {
  const text = (await rows[i].innerText().catch(() => "")).trim().replace(/\s+/g, ' ').substring(0, 120);
  console.log(`  ${text}`);
}

await browser.close();
