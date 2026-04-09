import { chromium } from "playwright";
import "dotenv/config";

const email = process.env.NOTARYGADGET_EMAIL;
const password = process.env.NOTARYGADGET_PASSWORD;

if (!email || !password) {
  console.error("Set NOTARYGADGET_EMAIL and NOTARYGADGET_PASSWORD in .env");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

console.log("1. Navigating to /UserLogin...");
await page.goto("https://www.notarygadget.com/UserLogin");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(3000);
await page.screenshot({ path: "/tmp/ng_step1.png" });
console.log("   URL:", page.url());

console.log("2. Waiting for #txtUsername...");
try {
  await page.waitForSelector("#txtUsername", { timeout: 10000 });
  console.log("   Found #txtUsername");
} catch {
  console.log("   #txtUsername NOT found — checking page source...");
  const html = await page.content();
  console.log(html.substring(0, 3000));
  await browser.close();
  process.exit(1);
}

console.log("3. Filling credentials...");
await page.fill("#txtUsername", email);
await page.fill("#txtPassword", password);
await page.screenshot({ path: "/tmp/ng_step3.png" });

console.log("4. Clicking login button...");
// Try multiple selectors
const btnSelectors = [
  'input[type="submit"]',
  'button[type="submit"]',
  'button:has-text("Login")',
  'input[value="Login"]',
  'input[value="Log In"]',
  'a:has-text("Login")',
  '.btn-login',
  '#btnLogin',
  'input[type="button"]',
];

let clicked = false;
for (const sel of btnSelectors) {
  try {
    const el = page.locator(sel).first();
    const visible = await el.isVisible().catch(() => false);
    console.log(`   ${sel}: visible=${visible}`);
    if (visible) {
      await el.click();
      clicked = true;
      console.log(`   Clicked: ${sel}`);
      break;
    }
  } catch {}
}

if (!clicked) {
  console.log("   No button clicked — dumping all buttons:");
  const btns = await page.locator("button, input[type='submit'], input[type='button']").all();
  for (const b of btns) {
    console.log({
      tag: await b.evaluate(el => el.tagName),
      type: await b.getAttribute("type"),
      value: await b.getAttribute("value"),
      id: await b.getAttribute("id"),
      text: await b.innerText().catch(() => ""),
      visible: await b.isVisible(),
    });
  }
  await browser.close();
  process.exit(1);
}

console.log("5. Waiting for navigation after login...");
await page.waitForTimeout(5000);
await page.screenshot({ path: "/tmp/ng_step5.png" });
console.log("   URL after login:", page.url());
console.log("   Title:", await page.title());

// Check for error messages
const errors = await page.locator('.error, .alert-danger, .validation-summary-errors, [class*="error"]').allInnerTexts();
if (errors.length > 0) {
  console.log("   ERRORS on page:", errors);
}

await browser.close();
console.log("\nScreenshots: /tmp/ng_step1.png, /tmp/ng_step3.png, /tmp/ng_step5.png");
