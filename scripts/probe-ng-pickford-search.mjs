// Search for Pickford in Contacts, extract the real EditContact IDs from each row.
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

// Type into the search box and let CreateContactsReport refire
const search = page.locator("#txtSearchValue");
await search.fill("Pickford");
await page.waitForTimeout(2000);
// Some pages need an Enter or a separate trigger
await search.press("Enter").catch(() => {});
await page.waitForTimeout(2000);

// Now look at the contacts table — extract every onclick referencing GetContactData / EditContact / SelectContact in the filtered rows
console.log("=== Pickford rows (post-search) ===");
const rows = await page.evaluate(() => {
  const out = [];
  // ContactsReport rows usually live in a specific div/table — find any element whose text starts with Pickford
  document.querySelectorAll("tr, div").forEach((el) => {
    const txt = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (!/pickford/i.test(txt)) return;
    if (txt.length > 200) return; // skip outer containers
    // Find the onclick that opens this row's detail (usually on the tr itself or first td)
    const onclick = el.getAttribute("onclick") || "";
    let extracted = null;
    if (onclick) {
      const m = onclick.match(/(?:GetContactData|EditContact|ToggleContactDetail|ShowContactDetail|OpenContact)\(['"]?(\d+)['"]?\)/);
      if (m) extracted = m[1];
    }
    // Walk children for first contact-detail-style click
    if (!extracted) {
      const child = el.querySelector("[onclick*='GetContactData'], [onclick*='EditContact'], [onclick*='OpenContact']");
      if (child) {
        const co = child.getAttribute("onclick") || "";
        const m = co.match(/(?:GetContactData|EditContact|OpenContact)\(['"]?(\d+)['"]?\)/);
        if (m) extracted = m[1];
      }
    }
    out.push({ tagName: el.tagName, text: txt.substring(0,150), onclick: onclick.substring(0,120), extractedId: extracted });
  });
  return out;
});
console.log(JSON.stringify(rows, null, 2));

// Try clicking the FIRST search-result row that strictly starts with "Pickford"
console.log("\n=== Click search-result rows ===");
const candidateHandles = await page.locator("tr, div").filter({ hasText: /^Pickford Escrow Company\b/i }).all();
console.log("Strict match count:", candidateHandles.length);

for (let i = 0; i < Math.min(candidateHandles.length, 4); i++) {
  const r = candidateHandles[i];
  const txt = (await r.innerText().catch(() => "")).replace(/\s+/g, " ").trim().substring(0,120);
  const tag = await r.evaluate((el) => el.tagName).catch(() => "");
  console.log(`  [${i}] tag=${tag} text="${txt}"`);
}

// Click the most specific (smallest) match
if (candidateHandles.length) {
  // Find row with smallest innerText (likely the actual row, not a wrapper)
  let smallestIdx = 0;
  let smallestLen = Infinity;
  for (let i = 0; i < candidateHandles.length; i++) {
    const txt = (await candidateHandles[i].innerText().catch(() => "")) || "";
    if (txt.length < smallestLen) {
      smallestLen = txt.length;
      smallestIdx = i;
    }
  }
  console.log(`\nClicking smallest-text candidate idx=${smallestIdx}`);
  await candidateHandles[smallestIdx].click();
  await page.waitForTimeout(2000);
  // Read the popup's Edit button
  const editOnclick = await page.locator('div[onclick*="EditContact("], a[onclick*="EditContact("]').first().getAttribute("onclick").catch(() => "");
  console.log("Popup Edit onclick:", editOnclick);
  // Read company name from popup
  const popup = await page.locator(".operationWindow, .operationContent, #divOperation, body").first().innerText().catch(() => "");
  console.log("Popup head:", popup.substring(0, 400));
}

await browser.close();
console.log("\n=== DONE ===");
