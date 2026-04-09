import { chromium } from "playwright";
import "dotenv/config";

const email = process.env.NOTARYGADGET_EMAIL;
const password = process.env.NOTARYGADGET_PASSWORD;

console.log("Email:", email ? email : "NOT SET");
console.log("Password:", password ? "SET (hidden)" : "NOT SET");

if (!email || !password) process.exit(1);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

// Listen for all network responses
page.on("response", resp => {
  if (resp.url().includes("notarygadget")) {
    console.log(`  RESPONSE: ${resp.status()} ${resp.url()}`);
  }
});

console.log("\n1. Loading /UserLogin...");
await page.goto("https://www.notarygadget.com/UserLogin");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(2000);

console.log("2. Filling credentials...");
await page.fill('#txtUsername', email);
await page.fill('#txtPassword', password);

console.log("3. Calling Login() JS function...");
await page.evaluate(() => window.Login());

console.log("4. Waiting 8 seconds for response...");
await page.waitForTimeout(8000);

const url = page.url();
const title = await page.title();
console.log("\nFinal URL:", url);
console.log("Final Title:", title);

await page.screenshot({ path: "/tmp/ng_final.png" });

// Check for error messages on page
const bodyText = await page.locator("body").innerText();
const lines = bodyText.split("\n").filter(l => l.trim()).slice(0, 30);
console.log("\nPage text (first 30 lines):");
lines.forEach(l => console.log(" ", l.trim()));

await browser.close();
console.log("\nScreenshot: /tmp/ng_final.png");
