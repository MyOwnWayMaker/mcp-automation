import { chromium } from "playwright";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/adjuster_university_session.json";
const browser = await chromium.launch({ headless: false, slowMo: 50 });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
});
const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
if (session.cookies?.length) await ctx.addCookies(session.cookies);

const page = await ctx.newPage();

// Load page 1
await page.goto("https://adjuster-university.com/courses/xactimate-gold-training-suite/", 
  { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);

// Scroll to bottom to reveal pagination
for (let i = 0; i < 10; i++) {
  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(300);
}

// Collect page 1 links
const collectLinks = async () => {
  return await page.evaluate(() => {
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      if (seen.has(href)) continue;
      seen.add(href);
      if (href.includes("xactimate-gold-training-suite") && href.includes("/lessons/") && !href.includes("/topic/") && !href.includes("/quizzes/")) {
        links.push({ href, text: a.textContent.trim().replace(/\s+/g, " ").slice(0, 60) });
      }
    }
    return links;
  });
};

console.log("Page 1 links:", (await collectLinks()).map(l => l.text));

// Find and click next button
const nextBtn = page.locator('a.next[data-context="course_content_shortcode"], a[aria-label="Next Page"][data-context="course_content_shortcode"]').first();
if (await nextBtn.count() > 0) {
  console.log("\nClicking Next button...");
  await nextBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await nextBtn.click({ force: true });
  await page.waitForTimeout(3000);
  
  // Scroll again
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(300);
  }
  
  const page2Links = await collectLinks();
  console.log("Page 2 links:", page2Links.map(l => l.text));
  console.log("Count:", page2Links.length);
  
  // Save HTML
  const html = await page.content();
  fs.writeFileSync("/tmp/course-page2-clicked.html", html);
  console.log("Saved HTML to /tmp/course-page2-clicked.html");
} else {
  console.log("No Next button found!");
  const btns = await page.evaluate(() => 
    Array.from(document.querySelectorAll("a, button")).filter(el => 
      el.textContent?.toLowerCase().includes("next") || el.getAttribute("aria-label")?.toLowerCase().includes("next")
    ).map(el => ({ tag: el.tagName, text: el.textContent?.trim(), href: el.href, cls: el.className }))
  );
  console.log("Elements with 'next':", JSON.stringify(btns, null, 2));
}

await browser.close();
