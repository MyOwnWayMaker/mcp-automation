// Probe v2: click the real DOCUMENTS tab, inspect all frames for the doc list,
// dump the downloadFile() signature. node scripts/probe-xact-documents.mjs 06QRD2C
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const MFN = process.argv[2] || "06QRD2C";
const BASE = "https://www.xactanalysis.com/apps";
const session = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "xactanalysis_session.json"), "utf-8"));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  acceptDownloads: true,
});
await context.addCookies(session.cookies);
const page = await context.newPage();
await page.goto(`${BASE}/cxa/detail.jsp?mfn=${MFN}&src=ip`);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(4000);

// downloadFile signature (root).
const dlSrc = await page.evaluate(() => {
  try { return typeof window.downloadFile === "function" ? window.downloadFile.toString().slice(0, 600) : "(not a fn)"; }
  catch (e) { return "err " + e.message; }
});
console.log("=== downloadFile() source ===\n", dlSrc, "\n");

// Click the DOCUMENTS (NN) tab by visible text.
const clicked = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll("a, button, div, span, li, td"));
  const tab = els.find((e) => /^DOCUMENTS\s*\(\d+\)/i.test((e.textContent || "").trim()) && e.offsetParent !== null);
  if (tab) { tab.click(); return "clicked: " + (tab.textContent || "").trim().slice(0, 40); }
  return "no DOCUMENTS tab element found";
});
console.log("=== tab click ===\n", clicked);
await page.waitForTimeout(8000);
console.log("url now:", page.url());

// Walk every frame, look for the doc list (filenames + the click/download handler).
for (const f of page.frames()) {
  let info;
  try {
    info = await f.evaluate(() => {
      const txt = document.body ? document.body.innerText : "";
      const hasDocs = /\.(pdf|jpg|esx|xml|eml)\b/i.test(txt);
      if (!hasDocs) return null;
      const rows = Array.from(document.querySelectorAll("a, [onclick], tr"))
        .filter((e) => /\.(pdf|jpg|jpeg|png|esx|xml|eml|docx?)\b/i.test(e.textContent || ""))
        .slice(0, 8)
        .map((e) => ({
          tag: e.tagName,
          text: (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70),
          href: e.getAttribute?.("href") || null,
          onclick: (e.getAttribute?.("onclick") || "").slice(0, 200) || null,
        }));
      return { bodyLen: txt.length, sample: txt.replace(/\s+/g, " ").slice(0, 300), rows };
    });
  } catch (e) { info = "frame eval err: " + e.message; }
  if (info) console.log(`\n=== FRAME ${f.name() || "(root)"} ${f.url().slice(0, 90)} ===\n`, JSON.stringify(info, null, 2));
}
await browser.close();
