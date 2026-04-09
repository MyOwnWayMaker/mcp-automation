import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

await page.goto("https://www.notarygadget.com/UserLogin");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(3000);

// Dump ALL links and buttons (visible or not) related to login
const allClickable = await page.locator("a, button, input[type='submit'], input[type='button']").all();
console.log("=== ALL CLICKABLE ELEMENTS ===");
for (const el of allClickable) {
  const text = await el.innerText().catch(() => "");
  const href = await el.getAttribute("href").catch(() => "");
  const id = await el.getAttribute("id");
  const cls = await el.getAttribute("class");
  const visible = await el.isVisible();
  if (text || href || id) {
    console.log({ tag: await el.evaluate(e => e.tagName), text: text.trim(), href, id, class: cls?.substring(0, 60), visible });
  }
}

// Check if there's a modal with the form
console.log("\n=== MODAL/FORM CONTAINERS ===");
const containers = await page.locator('form, .modal, [class*="modal"], [id*="modal"], [id*="login"], [class*="login"]').all();
for (const c of containers) {
  const id = await c.getAttribute("id");
  const cls = await c.getAttribute("class");
  const visible = await c.isVisible();
  const tag = await c.evaluate(e => e.tagName);
  console.log({ tag, id, class: cls?.substring(0, 80), visible });
}

await browser.close();
