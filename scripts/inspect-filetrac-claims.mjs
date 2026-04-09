import { chromium } from "playwright";
import fs from "fs";

const session = JSON.parse(fs.readFileSync("/Users/hakielmcqueen/mcp-automation/filetrac_session.json"));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

// Restore session
await page.goto("https://ftevolve.com");
await page.waitForLoadState("domcontentloaded");
await page.evaluate((ls) => { for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v); }, session.localStorage);
await page.reload();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(4000);

await page.goto("https://ftevolve.com/app/legacy/linked-companies");
await page.waitForLoadState("networkidle");
await page.waitForTimeout(5000);

// Click "See Jobs" for Premier Claims (has 4 jobs — index 1)
const seeJobsBtns = await page.locator('button:has-text("See Jobs")').all();
console.log("See Jobs buttons:", seeJobsBtns.length);

// Click Premier Claims (index 1)
if (seeJobsBtns.length > 1) {
  console.log("Clicking See Jobs for Premier Claims...");
  await seeJobsBtns[1].click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(5000);
} else if (seeJobsBtns.length > 0) {
  await seeJobsBtns[0].click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(5000);
}

console.log("URL after click:", page.url());
console.log("Title:", await page.title());

// Dump body text
const bodyText = await page.locator("body").innerText().catch(() => "");
console.log("\n=== BODY TEXT (first 3000 chars) ===");
console.log(bodyText.substring(0, 3000));

// Save full HTML
const html = await page.content();
fs.writeFileSync("/tmp/filetrac_jobs_list.html", html);
console.log("\nHTML saved to /tmp/filetrac_jobs_list.html");

await page.screenshot({ path: "/tmp/filetrac_jobs_list.png" });

// Capture cookies after redirect to filetrac.net
const allCookies = await context.cookies();
console.log("\nCookies after redirect:", allCookies.length);
allCookies.forEach(c => console.log(`  ${c.domain} | ${c.name} = ${c.value.substring(0, 40)}`));

// Find file number links (claim list links like 81030471)
console.log("\n=== CLAIM LINKS ===");
const allLinks = await page.locator("a").all();
const claimLinks = [];
for (const link of allLinks) {
  const text = (await link.innerText().catch(() => "")).trim();
  const href = await link.getAttribute("href").catch(() => "");
  if (/^\d{8}$/.test(text) || (href && href.includes("claimDetail"))) {
    claimLinks.push({ text, href });
    console.log(`  text="${text}" href="${href}"`);
  }
}

// Also dump all links to see what's clickable
console.log("\n=== ALL VISIBLE LINKS (first 30) ===");
let linkCount = 0;
for (const link of allLinks) {
  const text = (await link.innerText().catch(() => "")).trim();
  const href = await link.getAttribute("href").catch(() => "");
  if ((text || href) && linkCount < 30) {
    console.log(`  "${text}" -> ${href}`);
    linkCount++;
  }
}

// Try navigating to first claim detail
if (claimLinks.length > 0 && claimLinks[0].href) {
  const detailUrl = claimLinks[0].href.startsWith("http")
    ? claimLinks[0].href
    : `https://claims.filetrac.net/system/${claimLinks[0].href}`;
  console.log("\nNavigating to claim detail:", detailUrl);
  await page.goto(detailUrl);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);
} else {
  // Try clicking first file number link
  console.log("\nTrying to click first file number...");
  const fileLink = page.locator('a').filter({ hasText: /^\d{8}$/ }).first();
  if (await fileLink.count() > 0) {
    await fileLink.click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);
  }
}

console.log("URL:", page.url());
const detail = await page.locator("body").innerText().catch(() => "");
console.log("\n=== CLAIM DETAIL TEXT (first 4000 chars) ===");
console.log(detail.substring(0, 4000));
await page.screenshot({ path: "/tmp/filetrac_claim_detail.png" });
const detailHtml = await page.content();
fs.writeFileSync("/tmp/filetrac_claim_detail.html", detailHtml);
console.log("Claim detail HTML saved to /tmp/filetrac_claim_detail.html");

await browser.close();
