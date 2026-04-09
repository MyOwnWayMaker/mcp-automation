import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

// Get session cookie first
await page.goto("https://www.notarygadget.com/");
await page.waitForTimeout(2000);

// Go to actual login page
await page.goto("https://www.notarygadget.com/UserLogin");
await page.waitForTimeout(3000);

console.log("URL:", page.url());

const inputs = await page.locator("input").all();
console.log("\n=== INPUTS ===");
for (const input of inputs) {
  console.log({
    id: await input.getAttribute("id"),
    name: await input.getAttribute("name"),
    type: await input.getAttribute("type"),
    placeholder: await input.getAttribute("placeholder"),
    visible: await input.isVisible(),
  });
}

const buttons = await page.locator("button, input[type='submit'], input[type='button']").all();
console.log("\n=== BUTTONS ===");
for (const btn of buttons) {
  console.log({
    id: await btn.getAttribute("id"),
    name: await btn.getAttribute("name"),
    type: await btn.getAttribute("type"),
    value: await btn.getAttribute("value"),
    text: await btn.innerText().catch(() => ""),
    visible: await btn.isVisible(),
  });
}

await page.screenshot({ path: "/tmp/ng_login.png" });
await browser.close();
console.log("\nScreenshot at /tmp/ng_login.png");
