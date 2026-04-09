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

// Navigate to signings via JS
await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(4000);

// Dump all IDs containing "signing" (case insensitive)
console.log("=== ALL SIGNING-RELATED IDs ===");
const allIds = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('[id]'))
    .filter(el => el.id.toLowerCase().includes('sign') || el.id.toLowerCase().includes('order'))
    .map(el => ({ id: el.id, tag: el.tagName, class: el.className?.substring(0, 40), visible: el.offsetParent !== null }));
});
allIds.forEach(x => console.log(x));

// Look for the signings list/table container
console.log("\n=== SIGNING ROWS ===");
const rowSelectors = [
  '#divSigningsList', '#divSignings', '#tblSignings', '#SigningsList',
  '[id*="SigningRow"]', '[id*="signingRow"]', '[class*="SigningRow"]',
  'tr[id*="Signing"]', 'div[id*="Signing"]'
];
for (const sel of rowSelectors) {
  const els = await page.locator(sel).all();
  if (els.length > 0) {
    console.log(`\n${sel}: found ${els.length}`);
    for (const el of els.slice(0, 3)) {
      const text = await el.innerText().catch(() => "");
      console.log("  ", text.substring(0, 150).replace(/\n/g, " | "));
    }
  }
}

await page.screenshot({ path: "/tmp/ng_rows.png" });
await browser.close();
