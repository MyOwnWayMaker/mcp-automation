import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

await page.goto("https://ftevolve.com");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(3000);
console.log("URL:", page.url());
console.log("Title:", await page.title());

const inputs = await page.locator("input").all();
console.log("\n=== INPUTS ===");
for (const input of inputs) {
  console.log({ id: await input.getAttribute("id"), name: await input.getAttribute("name"), type: await input.getAttribute("type"), placeholder: await input.getAttribute("placeholder"), visible: await input.isVisible() });
}

await page.screenshot({ path: "/tmp/filetrac.png" });
await browser.close();
console.log("\nScreenshot: /tmp/filetrac.png");
