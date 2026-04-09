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

await page.evaluate(() => window.SelectPage('Signings'));
await page.waitForTimeout(3000);

const rows = await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').all();
await rows[0].click();
await page.waitForTimeout(2000);

// Open notarial acts
await page.evaluate(() => window.EditNotarialFees());
await page.waitForTimeout(2000);

const body = (await page.locator("body").innerText().catch(() => "")).substring(0, 5000);
const idx = body.toLowerCase().indexOf("notarial");
console.log("=== NOTARIAL ACTS BODY ===");
console.log(body.slice(Math.max(0, idx - 50), idx + 3000));

console.log("\n=== ALL VISIBLE INPUTS ===");
const inputs = await page.locator("input:visible, textarea:visible, select:visible").all();
for (const inp of inputs) {
  const id = await inp.getAttribute("id").catch(() => "");
  const name = await inp.getAttribute("name").catch(() => "");
  const type = await inp.getAttribute("type").catch(() => "");
  const val = await inp.inputValue().catch(() => "");
  const placeholder = await inp.getAttribute("placeholder").catch(() => "");
  if (id && id !== "txtSigningsStatusFilter") {
    console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" value="${val.substring(0,60)}"`);
  }
}

console.log("\n=== ALL BUTTONS ===");
const btns = await page.locator("div[onclick], button").all();
for (const btn of btns) {
  const text = (await btn.innerText().catch(() => "")).trim().substring(0, 60);
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const id = await btn.getAttribute("id").catch(() => "");
  if (onclick && !onclick.includes("StopProp") && !onclick.includes("GetSigning") && !onclick.includes("SelectPage") && !onclick.includes("ShowHelp") && !onclick.includes("Edit") && !onclick.includes("Show")) {
    console.log(`  id="${id}" onclick="${onclick}" text="${text}"`);
  }
}

fs.writeFileSync("/tmp/ng_notarial.html", await page.content());
await page.screenshot({ path: "/tmp/ng_notarial.png" });
console.log("\nSaved.");
await browser.close();
