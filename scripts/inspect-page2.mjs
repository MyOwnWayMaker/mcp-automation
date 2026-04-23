import { chromium } from "playwright";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/adjuster_university_session.json";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
});
const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
if (session.cookies?.length) await ctx.addCookies(session.cookies);

const page = await ctx.newPage();

// Load page 2
await page.goto("https://adjuster-university.com/courses/xactimate-gold-training-suite/?ld-courseinfo-lesson-page=2", 
  { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);

// Get all text from ld-item-list
const curriculum = await page.evaluate(() => {
  // Find the main course curriculum container
  const items = document.querySelectorAll('.ld-item-list-item, .ld-lesson-item, .learndash-lesson-item, [class*="ld-item"]');
  const results = [];
  for (const item of items) {
    const text = item.textContent?.trim().replace(/\s+/g, " ").slice(0, 100);
    const link = item.querySelector("a")?.href || null;
    if (text && text.length > 3) results.push({ text, link });
  }
  return results;
});

console.log("Curriculum items on page 2:", curriculum.length);
curriculum.slice(0, 40).forEach(i => console.log(`  ${i.link ? "[LINK]" : "[NOLINK]"} ${i.text}`));

// Also save page 2 HTML
const html = await page.content();
fs.writeFileSync("/tmp/course-page2.html", html);
console.log("\nPage 2 HTML saved to /tmp/course-page2.html");

await browser.close();
