import { chromium } from "playwright";
import fs from "fs";

const session = JSON.parse(fs.readFileSync("/Users/hakielmcqueen/mcp-automation/filetrac_session.json"));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" });
const page = await context.newPage();

await page.goto("https://ftevolve.com");
await page.waitForLoadState("domcontentloaded");
await page.evaluate((ls) => { for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v); }, session.localStorage);
await page.reload();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(4000);

await page.goto("https://ftevolve.com/app/legacy/linked-companies");
await page.waitForLoadState("networkidle");
await page.waitForTimeout(5000);

const seeJobsBtns = await page.locator('button:has-text("See Jobs")').all();
await seeJobsBtns[1].click();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(3000);

const aspBase = new URL(page.url()).origin;
console.log("ASP base:", aspBase);

await page.goto(`${aspBase}/system/quickTimelog.asp?claimFID=81030471`);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(3000);

console.log("Timelog URL:", page.url());
const bodyText = await page.locator("body").innerText().catch(() => "");
console.log("\n=== TIMELOG TEXT ===");
console.log(bodyText.substring(0, 3000));
fs.writeFileSync("/tmp/filetrac_timelog.html", await page.content());

await page.goto(`${aspBase}/system/quickNotes.asp?claimFID=81030471`);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(3000);

const notesText = await page.locator("body").innerText().catch(() => "");
console.log("\n=== NOTES TEXT ===");
console.log(notesText.substring(0, 2000));
fs.writeFileSync("/tmp/filetrac_notes.html", await page.content());

await browser.close();
console.log("Done. HTMLs saved to /tmp/");
