/**
 * Network-capture probe: load ProfessorCEWard's profile with cookies, click
 * into Ideas, and log every TradingView API/XHR request the SPA fires so we
 * can find the real per-user ideas endpoint (the one that actually filters
 * by ProfessorCEWard, unlike /api/v1/ideas/?username= which returns global).
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const COOKIES = path.join(HOME, "Downloads", "www.tradingview.com_cookies.txt");

function readNetscape(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(l => l.trim() && !l.startsWith("#"))
    .map(l => l.split("\t")).filter(p => p.length >= 7)
    .map(([domain,_f,p,secure,exp,name,value]) => ({
      name, value, domain, path: p,
      expires: exp === "0" ? -1 : parseInt(exp, 10),
      httpOnly: false, secure: secure.toUpperCase() === "TRUE", sameSite: "Lax",
    }));
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
});
await ctx.addCookies(readNetscape(COOKIES));
const page = await ctx.newPage();

const apiCalls = [];
page.on("response", async (resp) => {
  const url = resp.url();
  // Capture any TradingView API call that might carry ideas
  if (/\/api\/|ideas|published|charts|stream/.test(url) && !/\.(js|css|png|jpg|svg|woff)/.test(url)) {
    let bodyPreview = "";
    let isIdeas = false;
    try {
      const ct = resp.headers()["content-type"] || "";
      if (ct.includes("json")) {
        const txt = await resp.text();
        bodyPreview = txt.slice(0, 300);
        // Does this response contain ProfessorCEWard?
        isIdeas = txt.includes("ProfessorCEWard") || /"results"\s*:\s*\[/.test(txt);
      }
    } catch {}
    apiCalls.push({ url, status: resp.status(), isIdeas, bodyPreview });
  }
});

console.log("Loading profile...");
await page.goto("https://www.tradingview.com/u/ProfessorCEWard/", { waitUntil: "networkidle", timeout: 60000 }).catch(()=>{});
await page.waitForTimeout(3000);

// Try clicking the Ideas tab/link if present
const ideasTab = page.locator('a[href*="/ideas"], [role="tab"]:has-text("Ideas"), button:has-text("Ideas")').first();
if (await ideasTab.count() > 0) {
  console.log("Clicking Ideas tab...");
  await ideasTab.click().catch(()=>{});
  await page.waitForTimeout(3000);
  // scroll to trigger pagination XHR
  for (let i=0;i<5;i++){ await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)); await page.waitForTimeout(1500); }
}

await browser.close();

console.log(`\n=== Captured ${apiCalls.length} API calls ===`);
const ideaCalls = apiCalls.filter(c => c.isIdeas);
console.log(`\n=== ${ideaCalls.length} calls that contain ProfessorCEWard or results[] ===`);
for (const c of ideaCalls) {
  console.log(`\n[${c.status}] ${c.url}`);
  console.log(`  body: ${c.bodyPreview.replace(/\s+/g,' ').slice(0,200)}`);
}
console.log("\n=== ALL captured URLs ===");
for (const c of apiCalls) console.log(`  [${c.status}]${c.isIdeas?" *":"  "} ${c.url.slice(0,140)}`);
