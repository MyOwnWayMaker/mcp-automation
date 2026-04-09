import { chromium } from "playwright";
import "dotenv/config";

const email = process.env.NOTARYGADGET_EMAIL;
const password = process.env.NOTARYGADGET_PASSWORD;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

await page.goto("https://www.notarygadget.com/UserLogin");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(3000);

// Dump EVERYTHING inside #frmLogin
const formHTML = await page.locator('#frmLogin').innerHTML();
console.log("=== #frmLogin HTML ===");
console.log(formHTML);

// Try submitting the form directly
if (email && password) {
  console.log("\n=== TRYING LOGIN ===");
  await page.fill('#txtUsername', email);
  await page.fill('#txtPassword', password);

  // Try submitting form directly via JS
  await page.evaluate(() => {
    const form = document.getElementById('frmLogin');
    if (form) form.submit();
  });

  await page.waitForTimeout(5000);
  console.log("URL after submit:", page.url());
  console.log("Title:", await page.title());
  await page.screenshot({ path: "/tmp/ng_after_submit.png" });
}

await browser.close();
console.log("Screenshot: /tmp/ng_after_submit.png");
