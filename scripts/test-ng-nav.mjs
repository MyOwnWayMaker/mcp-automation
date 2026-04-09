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

// Find the Signings nav tab specifically
console.log("=== NAV TAB HTML ===");
const navHTML = await page.locator('text="Signings"').first().evaluate(el => {
  // Walk up to find the clickable parent
  let node = el;
  let result = [];
  for (let i = 0; i < 5; i++) {
    result.push({ tag: node.tagName, id: node.id, class: node.className, onclick: node.getAttribute('onclick') });
    if (node.parentElement) node = node.parentElement; else break;
  }
  return result;
}).catch(e => "Error: " + e.message);
console.log(JSON.stringify(navHTML, null, 2));

// Click the Signings tab and capture what changes
console.log("\n=== CLICKING SIGNINGS TAB ===");
await page.locator('text="Signings"').first().click();
await page.waitForTimeout(4000);
console.log("URL after click:", page.url());

// Look for signing rows
console.log("\n=== LOOKING FOR SIGNING DATA ===");
const tables = await page.locator("table").all();
console.log("Tables found:", tables.length);
for (let i = 0; i < Math.min(tables.length, 3); i++) {
  const text = await tables[i].innerText().catch(() => "");
  if (text.length > 10) console.log(`Table ${i}:`, text.substring(0, 200));
}

// Look for signing-specific elements
const signingItems = await page.locator('[id*="igning"], [class*="igning"], [id*="rder"], [class*="rder"]').all();
console.log("\nSigning-related elements:", signingItems.length);
for (const el of signingItems.slice(0, 5)) {
  const id = await el.getAttribute("id");
  const cls = await el.getAttribute("class");
  const text = await el.innerText().catch(() => "").then(t => t.substring(0, 100));
  console.log({ id, class: cls?.substring(0, 50), text: text.trim() });
}

await page.screenshot({ path: "/tmp/ng_nav.png" });
await browser.close();
console.log("\nScreenshot: /tmp/ng_nav.png");
