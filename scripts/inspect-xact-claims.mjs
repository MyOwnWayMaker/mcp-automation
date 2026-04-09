import { chromium } from "playwright";
import fs from "fs";

const session = JSON.parse(fs.readFileSync("/Users/hakielmcqueen/mcp-automation/xactanalysis_session.json"));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});

// Inject cookies
await context.addCookies(session.cookies);
const page = await context.newPage();

await page.goto("https://www.xactanalysis.com/apps/cxa/start.jsp");
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(5000);

console.log("URL:", page.url());
console.log("Title:", await page.title());

const bodyText = await page.locator("body").innerText().catch(() => "");
console.log("\n=== BODY TEXT (first 3000 chars) ===");
console.log(bodyText.substring(0, 3000));

const html = await page.content();
fs.writeFileSync("/tmp/xact_main.html", html);
console.log("\nHTML saved to /tmp/xact_main.html");
await page.screenshot({ path: "/tmp/xact_main.png" });

console.log("\n=== ALL LINKS (first 40) ===");
const links = await page.locator("a").all();
let count = 0;
for (const link of links) {
  const text = (await link.innerText().catch(() => "")).trim();
  const href = await link.getAttribute("href").catch(() => "");
  if ((text || href) && count < 40) {
    console.log(`  "${text.substring(0, 60)}" -> ${href}`);
    count++;
  }
}

await browser.close();
