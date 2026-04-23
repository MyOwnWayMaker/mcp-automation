/**
 * Inspects a lesson page to find the transcript button/panel.
 * Opens the browser visibly so you can see the page.
 * Dumps all buttons and clickable elements to the console.
 *
 * Run: node inspect-transcript-button.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/adjuster_university_session.json";
const LESSON_URL = "https://adjuster-university.com/courses/field-property-mastery/lessons/lesson-1-lifestyle-changes/";

const browser = await chromium.launch({ headless: false, slowMo: 100 });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  viewport: { width: 1280, height: 900 },
});

const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
if (session.cookies?.length) await context.addCookies(session.cookies);

const page = await context.newPage();
await page.goto(LESSON_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);

console.log("\n=== ALL BUTTONS ON PAGE ===");
const buttons = await page.evaluate(() => {
  return Array.from(document.querySelectorAll("button, [role='button'], a[class*='btn'], a[class*='button']")).map(el => ({
    tag: el.tagName,
    text: el.innerText?.trim().slice(0, 80) || "",
    class: el.className?.slice(0, 80) || "",
    id: el.id || "",
    ariaLabel: el.getAttribute("aria-label") || "",
    title: el.getAttribute("title") || "",
    href: el.href || "",
  }));
});
buttons.forEach((b, i) => {
  if (b.text || b.ariaLabel || b.title) {
    console.log(`[${i}] <${b.tag}> text="${b.text}" aria="${b.ariaLabel}" title="${b.title}" class="${b.class}" id="${b.id}"`);
  }
});

console.log("\n=== IFRAMES ON PAGE ===");
const iframes = await page.evaluate(() =>
  Array.from(document.querySelectorAll("iframe")).map(f => ({ src: f.src, class: f.className, id: f.id }))
);
iframes.forEach(f => console.log(" iframe:", f.src?.slice(0, 100), "class:", f.class, "id:", f.id));

console.log("\n=== ELEMENTS WITH 'TRANSCRIPT' IN CLASS/ID/TEXT ===");
const transcriptEls = await page.evaluate(() => {
  const results = [];
  document.querySelectorAll("*").forEach(el => {
    const cls = (el.className || "").toString().toLowerCase();
    const id = (el.id || "").toLowerCase();
    const text = (el.innerText || "").toLowerCase().slice(0, 50);
    if (cls.includes("transcript") || id.includes("transcript") || text.includes("transcript")) {
      results.push({
        tag: el.tagName,
        class: el.className?.toString().slice(0, 80),
        id: el.id,
        text: el.innerText?.trim().slice(0, 80),
      });
    }
  });
  return results.slice(0, 20);
});
transcriptEls.forEach(e => console.log(` <${e.tag}> id="${e.id}" class="${e.class}" text="${e.text}"`));

console.log("\nBrowser staying open — look at the page, find the transcript icon, then press Ctrl+C here.");
console.log("Tell me: where is the transcript icon and what does the panel look like when clicked?");

// Keep browser open for manual inspection
await new Promise(() => {}); // wait forever until Ctrl+C
