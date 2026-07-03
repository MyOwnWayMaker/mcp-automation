// Open EditContact(id) for both Pickford rows, dump form fields, dump current values.
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

await page.evaluate(() => window.SelectPage("Contacts"));
await page.waitForTimeout(4000);

// Find both Pickford rows and their EditContact IDs
console.log("=== Pickford rows ===");
const rows = await page.locator("tr, div").filter({ hasText: /pickford/i }).all();
const seenIds = new Set();
for (const r of rows) {
  const text = (await r.innerText().catch(() => "")).replace(/\s+/g, " ").trim().substring(0, 120);
  // Look for nested EditContact onclick or row attrs
  const inner = await r.innerHTML().catch(() => "");
  const m = inner.match(/EditContact\(['"](\d+)['"]\)/);
  const onclickAttr = await r.getAttribute("onclick").catch(() => "");
  const onclickMatch = onclickAttr?.match(/(?:GetContactData|EditContact|SelectContact)\(['"]?(\d+)['"]?\)/);
  const idGuess = m?.[1] ?? onclickMatch?.[1];
  if (idGuess && !seenIds.has(idGuess)) {
    seenIds.add(idGuess);
    console.log(`  id=${idGuess} | text="${text}"`);
  }
}

// Also try to grab the row by clicking and reading the popup's EditContact() id
console.log("\n=== Click each Pickford and read popup ===");
for (const idx of [0, 1]) {
  const row = page.locator("tr, div").filter({ hasText: /pickford/i }).nth(idx);
  if (!(await row.isVisible().catch(() => false))) continue;
  await row.click();
  await page.waitForTimeout(1500);
  const editBtn = await page.locator('div[onclick*="EditContact("], a[onclick*="EditContact("]').filter({ hasText: /Edit/i }).first();
  const oc = await editBtn.getAttribute("onclick").catch(() => "");
  const titleEl = page.locator(".operationTitle, .modalHeader, h1, h2").first();
  const title = await titleEl.innerText().catch(() => "");
  console.log(`  row idx=${idx} popup title="${title?.substring(0,80)}" editBtn onclick="${oc}"`);
  // Close popup
  await page.locator("#divModalCloseButton1, .closeBtn").first().click().catch(() => {});
  await page.waitForTimeout(800);
}

// === Now open EditContact for ID 148988 directly ===
console.log("\n=== EditContact('148988') ===");
await page.evaluate(() => window.EditContact("148988"));
await page.waitForTimeout(3000);

console.log("\n=== ALL VISIBLE INPUTS IN EDIT FORM ===");
const inputs = await page.locator("input:visible, textarea:visible, select:visible").all();
for (const inp of inputs) {
  const id = await inp.getAttribute("id").catch(() => "");
  const name = await inp.getAttribute("name").catch(() => "");
  const type = await inp.getAttribute("type").catch(() => "");
  const val = await inp.inputValue().catch(() => "");
  const placeholder = await inp.getAttribute("placeholder").catch(() => "");
  // Also check for label/preceding text by id-pattern
  if (id) {
    console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" value="${val.substring(0,80)}"`);
  }
}

console.log("\n=== BUTTONS IN EDIT FORM ===");
const btns = await page.locator("div[onclick]:visible, button:visible, a[onclick]:visible").all();
for (const btn of btns.slice(0, 60)) {
  const text = ((await btn.innerText().catch(() => "")) || "").trim().substring(0, 60);
  const onclick = await btn.getAttribute("onclick").catch(() => "");
  const id = await btn.getAttribute("id").catch(() => "");
  if (onclick && /save|close|delete|cancel|update/i.test(onclick + " " + text)) {
    console.log(`  id="${id}" onclick="${onclick.substring(0,100)}" text="${text}"`);
  }
}

// Look at labels next to inputs for context
console.log("\n=== INPUT IDs + adjacent label text ===");
const inputsWithCtx = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    if (!el.id) return;
    if (el.offsetParent === null) return; // not visible
    // Find label-ish text by walking up to find a row/cell with text
    let labelText = "";
    let parent = el.parentElement;
    for (let i = 0; i < 4 && parent; i++) {
      const text = (parent.innerText || "").replace(/\s+/g, " ").trim();
      if (text && text.length < 80) { labelText = text; break; }
      parent = parent.parentElement;
    }
    out.push({ id: el.id, type: el.type, value: (el.value || "").substring(0,80), label: labelText });
  });
  return out;
});
for (const r of inputsWithCtx) {
  console.log(`  id="${r.id}" type="${r.type}" val="${r.value}" near="${r.label}"`);
}

await browser.close();
console.log("\n=== DONE ===");
