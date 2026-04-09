import { chromium } from "playwright";
import fs from "fs";

const session = JSON.parse(fs.readFileSync("/Users/hakielmcqueen/mcp-automation/filetrac_session.json"));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

// Navigate first so we can set localStorage on the right origin
await page.goto("https://ftevolve.com");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(2000);

// Inject localStorage tokens
await page.evaluate((ls) => {
  for (const [key, value] of Object.entries(ls)) {
    window.localStorage.setItem(key, value);
  }
}, session.localStorage);

// Reload to trigger auth check
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(4000);

console.log("URL after session restore:", page.url());
console.log("Title:", await page.title());

const bodyText = await page.locator("body").innerText().catch(() => "");
const lines = bodyText.split("\n").filter(l => l.trim()).slice(0, 30);
console.log("\nPage content:");
lines.forEach(l => console.log(" ", l.trim()));

await page.screenshot({ path: "/tmp/filetrac_session_test.png" });
await browser.close();
console.log("\nScreenshot: /tmp/filetrac_session_test.png");
