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

// Login
await page.goto(`${NG_URL}/UserLogin`);
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector('#txtUsername', { timeout: 15000 });
await page.fill('#txtUsername', email);
await page.fill('#txtPassword', password);
await page.evaluate(() => window.Login());
await page.waitForTimeout(6000);
console.log("After login URL:", page.url());

// Click the Signings tab
console.log("\nLooking for Signings tab...");
const links = await page.locator("a, div[onclick], span[onclick]").all();
for (const link of links) {
  const text = await link.innerText().catch(() => "");
  const onclick = await link.getAttribute("onclick").catch(() => "");
  const href = await link.getAttribute("href").catch(() => "");
  if (text.trim().toLowerCase().includes("signing") || (onclick && onclick.toLowerCase().includes("signing")) || (href && href.toLowerCase().includes("signing"))) {
    console.log({ text: text.trim(), onclick, href, visible: await link.isVisible() });
  }
}

// Try clicking Signings tab
try {
  await page.click('a:has-text("Signings"), div:has-text("Signings")', { timeout: 5000 });
  await page.waitForTimeout(3000);
  console.log("\nAfter clicking Signings URL:", page.url());
} catch {
  console.log("Could not click Signings tab");
}

await page.screenshot({ path: "/tmp/ng_signings.png" });

// Get page content
const bodyText = await page.locator("body").innerText();
const lines = bodyText.split("\n").filter(l => l.trim()).slice(0, 40);
console.log("\nPage content (first 40 lines):");
lines.forEach(l => console.log(" ", l.trim()));

await browser.close();
console.log("\nScreenshot: /tmp/ng_signings.png");
