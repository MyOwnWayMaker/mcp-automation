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
console.log("Opening signing:", await rows[0].getAttribute("id"));
await rows[0].click();
await page.waitForTimeout(2000);

// ===== MILEAGE =====
console.log("\n\n===== MILEAGE FORM =====");
await page.evaluate(() => window.EditSigningMileage());
await page.waitForTimeout(2000);

const mileageBody = (await page.locator("body").innerText().catch(() => "")).substring(0, 3000);
// Print just the mileage section
const mileageIdx = mileageBody.toLowerCase().indexOf("mileage");
console.log(mileageBody.slice(Math.max(0, mileageIdx - 50), mileageIdx + 1500));

console.log("\n=== MILEAGE INPUTS ===");
const mInputs = await page.locator("input:visible, textarea:visible, select:visible").all();
for (const inp of mInputs) {
  const id = await inp.getAttribute("id").catch(() => "");
  const name = await inp.getAttribute("name").catch(() => "");
  const type = await inp.getAttribute("type").catch(() => "");
  const val = await inp.inputValue().catch(() => "");
  const placeholder = await inp.getAttribute("placeholder").catch(() => "");
  if (id && id !== "txtSigningsStatusFilter") {
    console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" value="${val.substring(0,60)}"`);
  }
}

console.log("\n=== MILEAGE BUTTONS ===");
const mBtns = await page.locator("div[onclick], button").all();
for (const btn of mBtns) {
  const text = (await btn.innerText().catch(() => "")).trim().substring(0, 60);
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const id = await btn.getAttribute("id").catch(() => "");
  if (onclick && (onclick.includes("Mile") || onclick.includes("mile") || onclick.includes("Save") || onclick.includes("Cancel") || onclick.includes("No") || onclick.includes("Skip") || onclick.includes("Close"))) {
    if (!onclick.includes("StopProp") && !onclick.includes("GetSigning") && !onclick.includes("SelectPage") && !onclick.includes("ShowHelp")) {
      console.log(`  id="${id}" onclick="${onclick}" text="${text}"`);
    }
  }
}

fs.writeFileSync("/tmp/ng_mileage.html", await page.content());
await page.screenshot({ path: "/tmp/ng_mileage.png" });

// Close and open notarial acts
await page.evaluate(() => window.CloseOperationWindow && window.CloseOperationWindow()).catch(() => {});
await page.waitForTimeout(1000);

// Re-open signing
await rows[0].click();
await page.waitForTimeout(2000);

// ===== NOTARIAL ACTS =====
console.log("\n\n===== NOTARIAL ACTS FORM =====");
await page.evaluate(() => window.EditNotarialFees());
await page.waitForTimeout(2000);

const notBody = (await page.locator("body").innerText().catch(() => "")).substring(0, 4000);
const notIdx = notBody.toLowerCase().indexOf("notarial");
console.log(notBody.slice(Math.max(0, notIdx - 50), notIdx + 2000));

console.log("\n=== NOTARIAL INPUTS ===");
const nInputs = await page.locator("input:visible, textarea:visible, select:visible").all();
for (const inp of nInputs) {
  const id = await inp.getAttribute("id").catch(() => "");
  const name = await inp.getAttribute("name").catch(() => "");
  const type = await inp.getAttribute("type").catch(() => "");
  const val = await inp.inputValue().catch(() => "");
  const placeholder = await inp.getAttribute("placeholder").catch(() => "");
  if (id && id !== "txtSigningsStatusFilter") {
    console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" value="${val.substring(0,60)}"`);
  }
}

console.log("\n=== NOTARIAL BUTTONS ===");
const nBtns = await page.locator("div[onclick], button").all();
for (const btn of nBtns) {
  const text = (await btn.innerText().catch(() => "")).trim().substring(0, 60);
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const id = await btn.getAttribute("id").catch(() => "");
  if (onclick && (onclick.includes("Notari") || onclick.includes("notari") || onclick.includes("Save") || onclick.includes("Fee") || onclick.includes("Add"))) {
    if (!onclick.includes("StopProp") && !onclick.includes("GetSigning") && !onclick.includes("SelectPage") && !onclick.includes("ShowHelp")) {
      console.log(`  id="${id}" onclick="${onclick}" text="${text}"`);
    }
  }
}

fs.writeFileSync("/tmp/ng_notarial.html", await page.content());
await page.screenshot({ path: "/tmp/ng_notarial.png" });
console.log("\nSaved screenshots.");
await browser.close();
