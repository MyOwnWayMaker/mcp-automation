import { chromium } from "playwright";
import fs from "fs";

const session = JSON.parse(fs.readFileSync("/Users/hakielmcqueen/mcp-automation/filetrac_session.json"));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

await page.goto("https://ftevolve.com");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(2000);
await page.evaluate((ls) => { for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v); }, session.localStorage);
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(4000);

// Look for FileTrac / claims link
console.log("=== NAV LINKS ===");
const links = await page.locator("a[href], button").all();
for (const link of links) {
  const text = await link.innerText().catch(() => "");
  const href = await link.getAttribute("href").catch(() => "");
  if (text.trim()) console.log({ text: text.trim().substring(0, 60), href });
}

// Click FileTrac link
try {
  await page.click('a:has-text("FileTrac"), button:has-text("FileTrac")');
  await page.waitForTimeout(4000);
  console.log("\nURL after clicking FileTrac:", page.url());
  await page.screenshot({ path: "/tmp/filetrac_claims.png" });
  
  const body = await page.locator("body").innerText();
  const lines = body.split("\n").filter(l => l.trim()).slice(0, 50);
  console.log("\nClaims page content:");
  lines.forEach(l => console.log(" ", l.trim()));
} catch(e) {
  console.log("Could not click FileTrac:", e.message);
}

await browser.close();
