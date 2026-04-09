import { chromium } from "playwright";
import fs from "fs";

const session = JSON.parse(fs.readFileSync("/Users/hakielmcqueen/mcp-automation/xactanalysis_session.json"));
const BASE = "https://www.xactanalysis.com/apps";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
await context.addCookies(session.cookies);
const page = await context.newPage();

// Navigate directly to first claim detail (mfn=06SSNJ3 = claim 1095394)
const detailUrl = `${BASE}/cxa/detail.jsp?mfn=06SSNJ3&src=ip`;
console.log("Navigating to:", detailUrl);
await page.goto(detailUrl);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(6000);

console.log("Final URL:", page.url());
console.log("Title:", await page.title());

const bodyText = (await page.locator("body").innerText().catch(() => "")).substring(0, 5000);
console.log("\n=== BODY TEXT ===");
console.log(bodyText);

fs.writeFileSync("/tmp/xact_detail.html", await page.content());
await page.screenshot({ path: "/tmp/xact_detail.png" });
console.log("\nHTML saved to /tmp/xact_detail.html");

// Find all inputs/forms
console.log("\n=== ALL VISIBLE INPUTS ===");
const inputs = await page.locator("input, textarea, select").all();
for (const inp of inputs.slice(0, 40)) {
  const id = await inp.getAttribute("id").catch(() => "");
  const name = await inp.getAttribute("name").catch(() => "");
  const type = await inp.getAttribute("type").catch(() => "");
  const visible = await inp.isVisible().catch(() => false);
  const val = await inp.inputValue().catch(() => "");
  const placeholder = await inp.getAttribute("placeholder").catch(() => "");
  if (visible) {
    console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" value="${val.substring(0,50)}"`);
  }
}

// Find all links on detail page
console.log("\n=== LINKS ON DETAIL PAGE ===");
const links = await page.locator("a").all();
for (const link of links.slice(0, 40)) {
  const text = (await link.innerText().catch(() => "")).trim();
  const href = await link.getAttribute("href").catch(() => "");
  if (text || href) console.log(`  "${text.substring(0,60)}" -> ${href}`);
}

await browser.close();
