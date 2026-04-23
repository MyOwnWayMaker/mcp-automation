import { chromium } from "playwright";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/adjuster_university_session.json";
const COURSE_URL = "https://adjuster-university.com/courses/xactimate-gold-training-suite/";

const browser = await chromium.launch({ headless: false, slowMo: 30 });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
});

const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
if (session.cookies?.length) await ctx.addCookies(session.cookies);

const page = await ctx.newPage();
await page.goto(COURSE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);

// Scroll fully
for (let i = 0; i < 30; i++) {
  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(400);
}
await page.waitForTimeout(2000);

// Try clicking all accordion / toggle / expand buttons
const expandClicks = await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll(
    '.ld-section-heading, .ld-lesson-section-heading, [class*="section"], [class*="expand"], [class*="toggle"], summary, .course-section'
  ));
  return buttons.map(b => ({ tag: b.tagName, cls: b.className, text: b.innerText?.trim().slice(0, 60) }));
});
console.log("Potential expand elements:", JSON.stringify(expandClicks.slice(0, 20), null, 2));

// Try clicking each section heading
const headings = page.locator('.ld-section-heading, .ld-lesson-section-heading, .course-section-heading');
const count = await headings.count();
console.log(`\nSection headings found: ${count}`);
for (let i = 0; i < count; i++) {
  const text = await headings.nth(i).innerText().catch(() => "");
  console.log(`  [${i}] ${text.trim().slice(0, 80)}`);
  await headings.nth(i).click({ force: true }).catch(() => {});
  await page.waitForTimeout(1000);
}

// Re-scroll after clicking
for (let i = 0; i < 30; i++) {
  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(300);
}
await page.waitForTimeout(2000);

// Now collect ALL lesson links
const allLinks = await page.evaluate(() => {
  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    if (seen.has(href)) continue;
    seen.add(href);
    if (href.includes("xactimate-gold-training-suite") && href.includes("/lessons/")) {
      links.push({ href, text: a.textContent.trim().replace(/\s+/g, " ").slice(0, 80) });
    }
  }
  return links;
});

console.log(`\nTotal lesson links found after expansion: ${allLinks.length}`);
allLinks.forEach(l => console.log(`  ${l.text} → ${l.href}`));

// Also dump page structure for diagnosis
const pageHTML = await page.content();
fs.writeFileSync("/tmp/course-page.html", pageHTML);
console.log("\nPage HTML saved to /tmp/course-page.html");

await browser.close();
