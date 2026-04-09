import { chromium } from "playwright";
import "dotenv/config";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

console.log("Logging in to XactAnalysis...");
await page.goto("https://www.xactanalysis.com");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(3000);

// Step 1: enter email and click NEXT
await page.fill('input[name="preAuthEmailField"]', process.env.XACTANALYSIS_EMAIL);
await page.click('button:has-text("NEXT")');
await page.waitForTimeout(3000);
console.log("After NEXT URL:", page.url());
await page.screenshot({ path: "/tmp/xact_step2.png" });

// Step 2: look for password field
const inputs = await page.locator("input:visible").all();
console.log("\n=== INPUTS AFTER NEXT ===");
for (const inp of inputs) {
  console.log({ id: await inp.getAttribute("id"), name: await inp.getAttribute("name"), type: await inp.getAttribute("type") });
}

const buttons = await page.locator("button:visible").all();
console.log("\n=== BUTTONS AFTER NEXT ===");
for (const btn of buttons) {
  console.log({ text: await btn.innerText().catch(() => ""), type: await btn.getAttribute("type") });
}

await browser.close();
