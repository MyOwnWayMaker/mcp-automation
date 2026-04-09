import { chromium } from "playwright";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

console.log("Step 1: Email entry on xactanalysis.com...");
await page.goto("https://www.xactanalysis.com");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(3000);

await page.fill('input[name="preAuthEmailField"]', process.env.XACTANALYSIS_EMAIL);
await page.click('button:has-text("NEXT")');
await page.waitForTimeout(4000);

console.log("URL after NEXT:", page.url());

// Step 2: password on identity.verisk.com
const pwdField = page.locator('input[name="passwordField"]');
if (await pwdField.count() > 0) {
  console.log("Password field found. Filling password...");
  await pwdField.fill(process.env.XACTANALYSIS_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);
  console.log("URL after login:", page.url());
  console.log("Title:", await page.title());

  const bodyText = (await page.locator("body").innerText().catch(() => "")).substring(0, 500);
  console.log("Body text:", bodyText);

  await page.screenshot({ path: "/tmp/xact_after_login.png" });

  // Check if MFA is needed
  if (page.url().includes("mfa") || page.url().includes("verify") || bodyText.toLowerCase().includes("verification") || bodyText.toLowerCase().includes("code")) {
    console.log(">>> MFA DETECTED! Manual step needed.");
  } else if (page.url().includes("xactanalysis.com") && !page.url().includes("identity.verisk")) {
    console.log("✅ LOGIN SUCCESSFUL!");

    // Capture session
    const cookies = await context.cookies();
    const localStorageData = await page.evaluate(() => {
      const data = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        data[key] = window.localStorage.getItem(key);
      }
      return data;
    });
    console.log("Cookies:", cookies.length);
    console.log("localStorage keys:", Object.keys(localStorageData));
  } else {
    console.log("❌ Login may have failed. Current URL:", page.url());
  }
} else {
  console.log("❌ Password field not found. Page text:", (await page.locator("body").innerText().catch(() => "")).substring(0, 300));
}

await browser.close();
