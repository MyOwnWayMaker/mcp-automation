import { chromium } from "playwright";
import fs from "fs";

const session = JSON.parse(fs.readFileSync("/Users/hakielmcqueen/mcp-automation/filetrac_session.json"));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

await page.goto("https://ftevolve.com");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(2000);
await page.evaluate((ls) => { for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v); }, session.localStorage);
await page.reload();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(4000);

// Go to linked companies
await page.goto("https://ftevolve.com/app/legacy/linked-companies");
await page.waitForLoadState("networkidle");
await page.waitForTimeout(5000);

console.log("URL:", page.url());
console.log("Title:", await page.title());

// Dump all links
console.log("\n=== ALL LINKS ===");
const links = await page.locator("a").all();
for (const link of links) {
  const text = (await link.innerText().catch(() => "")).trim();
  const href = await link.getAttribute("href").catch(() => "");
  const id = await link.getAttribute("id").catch(() => "");
  const cls = (await link.getAttribute("class").catch(() => "") ?? "").substring(0, 60);
  if (text || href) {
    console.log(`  href="${href}" id="${id}" class="${cls}" text="${text.substring(0, 60)}"`);
  }
}

// Dump all clickable elements
console.log("\n=== CLICKABLE ELEMENTS (buttons, [ng-click], [onclick]) ===");
const clickable = await page.locator("button, [ng-click], [onclick], [ui-sref]").all();
for (const el of clickable.slice(0, 50)) {
  const text = (await el.innerText().catch(() => "")).trim().substring(0, 80);
  const id = await el.getAttribute("id").catch(() => "");
  const ngClick = await el.getAttribute("ng-click").catch(() => "");
  const uiSref = await el.getAttribute("ui-sref").catch(() => "");
  const onclick = await el.getAttribute("onclick").catch(() => "");
  const cls = (await el.getAttribute("class").catch(() => "") ?? "").substring(0, 60);
  if (text || ngClick || uiSref || onclick) {
    console.log(`  id="${id}" ng-click="${ngClick}" ui-sref="${uiSref}" onclick="${onclick}" class="${cls}" text="${text}"`);
  }
}

// Dump body text
console.log("\n=== BODY TEXT ===");
const bodyText = (await page.locator("body").innerText().catch(() => ""));
console.log(bodyText.substring(0, 3000));

// Dump full HTML to file for detailed inspection
const html = await page.content();
fs.writeFileSync("/tmp/filetrac_linked_companies.html", html);
console.log("\nFull HTML saved to /tmp/filetrac_linked_companies.html");

await page.screenshot({ path: "/tmp/filetrac_linked_companies.png" });
console.log("Screenshot saved to /tmp/filetrac_linked_companies.png");

await browser.close();
