import { chromium } from "playwright";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });
import fs from "fs";

const NG_URL = "https://www.notarygadget.com";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

await page.goto(`${NG_URL}/UserLogin`);
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector('#txtUsername', { timeout: 20000 });
await page.fill('#txtUsername', process.env.NOTARYGADGET_EMAIL);
await page.fill('#txtPassword', process.env.NOTARYGADGET_PASSWORD);
await page.evaluate(() => window.Login());
await page.waitForTimeout(8000);
await page.waitForLoadState("domcontentloaded");
console.log("Logged in:", page.url());

await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(3000);

// Open new signing form
console.log("Opening new signing form...");
await page.evaluate(() => window.EditSigning('New'));
await page.waitForTimeout(3000);

const bodyText = (await page.locator("body").innerText().catch(() => "")).substring(0, 2000);
console.log("\n=== BODY ===");
console.log(bodyText);

// Dump all visible inputs
console.log("\n=== ALL INPUTS ===");
const inputs = await page.locator("input, textarea, select").all();
for (const inp of inputs) {
  const id = await inp.getAttribute("id").catch(() => "");
  const name = await inp.getAttribute("name").catch(() => "");
  const type = await inp.getAttribute("type").catch(() => "");
  const visible = await inp.isVisible().catch(() => false);
  const val = await inp.inputValue().catch(() => "");
  const placeholder = await inp.getAttribute("placeholder").catch(() => "");
  if (visible || id) {
    console.log(`  visible=${visible} id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" value="${val.substring(0,40)}"`);
  }
}

console.log("\n=== ALL ONCLICK BUTTONS ===");
const btns = await page.locator("div[onclick], button, input[type='button'], input[type='submit']").all();
for (const btn of btns) {
  const text = (await btn.innerText().catch(() => "")).trim().substring(0, 60);
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const id = await btn.getAttribute("id").catch(() => "");
  if (onclick && !onclick.includes("StopProp") && !onclick.includes("GetSigning")) {
    console.log(`  id="${id}" onclick="${onclick}" text="${text}"`);
  }
}

fs.writeFileSync("/tmp/ng_new_signing.html", await page.content());
await page.screenshot({ path: "/tmp/ng_new_signing.png" });
console.log("\nSaved /tmp/ng_new_signing.html");
await browser.close();
