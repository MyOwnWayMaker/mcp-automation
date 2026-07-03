// Probe NotaryGadget's Customers page UI to map selectors for the
// notarygadget_update_customer tool. Finds Pickford Escrow, opens its edit
// form, dumps inputs/buttons so we can write the tool against real IDs.
import { chromium } from "playwright";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/dino/mcp-automation/.env" });

const NG_URL = "https://www.notarygadget.com";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

await page.goto(`${NG_URL}/UserLogin`);
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("#txtUsername", { timeout: 20000 });
await page.fill("#txtUsername", process.env.NOTARYGADGET_EMAIL);
await page.fill("#txtPassword", process.env.NOTARYGADGET_PASSWORD);
await page.evaluate(() => window.Login());
await page.waitForTimeout(8000);
console.log("Post-login URL:", page.url());

// === Probe 1: NG calls customers "Contacts" internally ===
console.log("\n=== SelectPage('Contacts') ===");
try {
  await page.evaluate(() => window.SelectPage("Contacts"));
  await page.waitForTimeout(4000);
  console.log("URL after:", page.url());
} catch (e) {
  console.log("SelectPage Contacts FAILED:", e.message);
}

// Dump the body text head + look for Pickford
const body1 = await page.locator("body").innerText().catch(() => "");
console.log("Body length:", body1.length);
const pickfordIdx = body1.toLowerCase().indexOf("pickford");
console.log("Pickford found in body:", pickfordIdx >= 0);
if (pickfordIdx >= 0) {
  console.log("Context around Pickford:", body1.slice(Math.max(0, pickfordIdx - 80), pickfordIdx + 200));
}

// === Dump page-level globals matching Contact / Customer / Save / Edit ===
console.log("\n=== window functions matching Contact/Customer/Save/Edit ===");
const winFns = await page.evaluate(() => {
  const fns = [];
  for (const k of Object.keys(window)) {
    if (typeof window[k] === "function" && /contact|customer|^save|^edit/i.test(k)) {
      fns.push(k);
    }
  }
  return fns.sort();
});
console.log(winFns);

// === Dump all visible inputs ===
console.log("\n=== ALL VISIBLE INPUTS ===");
const inputs = await page.locator("input:visible, textarea:visible, select:visible").all();
for (const inp of inputs) {
  const id = await inp.getAttribute("id").catch(() => "");
  const name = await inp.getAttribute("name").catch(() => "");
  const type = await inp.getAttribute("type").catch(() => "");
  const val = await inp.inputValue().catch(() => "");
  const placeholder = await inp.getAttribute("placeholder").catch(() => "");
  if (id) {
    console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" value="${val.substring(0,60)}"`);
  }
}

// === Dump visible buttons / clickable divs ===
console.log("\n=== ALL onclick ELEMENTS ===");
const btns = await page.locator("div[onclick]:visible, button:visible, a[onclick]:visible, td[onclick]:visible").all();
for (const btn of btns.slice(0, 60)) {
  const text = ((await btn.innerText().catch(() => "")) || "").trim().substring(0, 60);
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const id = await btn.getAttribute("id").catch(() => "");
  if (onclick && !onclick.includes("StopProp") && !onclick.includes("ShowHelp")) {
    console.log(`  id="${id}" onclick="${onclick.substring(0,80)}" text="${text}"`);
  }
}

// === Try clicking the Pickford row if visible ===
if (pickfordIdx >= 0) {
  console.log("\n=== ATTEMPTING TO OPEN PICKFORD ROW ===");
  const pickfordRow = page.locator("tr, div").filter({ hasText: /pickford/i }).first();
  const visible = await pickfordRow.isVisible({ timeout: 2000 }).catch(() => false);
  console.log("Pickford row visible:", visible);
  if (visible) {
    await pickfordRow.click();
    await page.waitForTimeout(3000);
    console.log("URL after click:", page.url());

    console.log("\n=== INPUTS AFTER PICKFORD CLICK ===");
    const inputs2 = await page.locator("input:visible, textarea:visible, select:visible").all();
    for (const inp of inputs2) {
      const id = await inp.getAttribute("id").catch(() => "");
      const name = await inp.getAttribute("name").catch(() => "");
      const type = await inp.getAttribute("type").catch(() => "");
      const val = await inp.inputValue().catch(() => "");
      const placeholder = await inp.getAttribute("placeholder").catch(() => "");
      if (id) {
        console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" value="${val.substring(0,80)}"`);
      }
    }

    console.log("\n=== BUTTONS AFTER PICKFORD CLICK ===");
    const btns2 = await page.locator("div[onclick]:visible, button:visible, a[onclick]:visible").all();
    for (const btn of btns2.slice(0, 40)) {
      const text = ((await btn.innerText().catch(() => "")) || "").trim().substring(0, 60);
      const onclick = await btn.getAttribute("onclick").catch(() => "");
      const id = await btn.getAttribute("id").catch(() => "");
      if (onclick && !onclick.includes("StopProp") && !onclick.includes("ShowHelp")) {
        console.log(`  id="${id}" onclick="${onclick.substring(0,80)}" text="${text}"`);
      }
    }
  }
}

await browser.close();
console.log("\n=== DONE ===");
