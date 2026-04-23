/**
 * Discovery script: find FileTrac Reports tab URL and document link structure.
 * Run from project root: node scripts/discover-filetrac-docs.mjs <claim_id>
 * Example: node scripts/discover-filetrac-docs.mjs 1234567
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const SESSION_PATH = "/Users/hakielmcqueen/mcp-automation/filetrac_session.json";

const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
const { aspBase, aspCookies } = session;

if (!aspBase || !aspCookies) {
  console.error("No aspBase/aspCookies in session. Run auth-filetrac.mjs first.");
  process.exit(1);
}

// Use a real claim ID — first CLI arg or a known one
const CLAIM_ID = process.argv[2] || "1234567";

async function discoverReportsTab() {
  console.log(`\n=== FileTrac Reports Tab Discovery ===`);
  console.log(`Claim ID: ${CLAIM_ID}`);
  console.log(`Base: ${aspBase}`);

  // First: try fast-path HTTP to load the claim view and extract file number
  const claimHtml = await fetchAsp(`/system/claimView.asp?claimID=${CLAIM_ID}`);
  if (!claimHtml) {
    console.error("Fast-path failed for claimView.asp — session may be expired");
    process.exit(1);
  }

  // Extract claimFID
  const fidMatch = claimHtml.match(/claimFID=(\d{7,9})/i);
  const claimFID = fidMatch ? fidMatch[1] : null;
  console.log(`\nExtracted claimFID: ${claimFID}`);

  // Try common report/document URL patterns via HTTP first
  const candidates = [
    `/system/claimReports.asp?claimFID=${claimFID}&claimID=${CLAIM_ID}`,
    `/system/claimDocuments.asp?claimFID=${claimFID}&claimID=${CLAIM_ID}`,
    `/system/claimFiles.asp?claimFID=${claimFID}&claimID=${CLAIM_ID}`,
    `/system/claimAttachments.asp?claimFID=${claimFID}&claimID=${CLAIM_ID}`,
    `/system/claimUploads.asp?claimFID=${claimFID}&claimID=${CLAIM_ID}`,
    `/system/reports.asp?claimFID=${claimFID}&claimID=${CLAIM_ID}`,
    `/system/documents.asp?claimFID=${claimFID}&claimID=${CLAIM_ID}`,
    `/system/claimReport.asp?claimFID=${claimFID}&claimID=${CLAIM_ID}`,
    `/system/claimDocument.asp?claimFID=${claimFID}&claimID=${CLAIM_ID}`,
    `/system/claimDocs.asp?claimFID=${claimFID}&claimID=${CLAIM_ID}`,
  ];

  console.log("\n--- Fast-path HTTP URL probing ---");
  for (const url of candidates) {
    const html = await fetchAsp(url);
    if (html) {
      console.log(`\n✅ HIT: ${url}`);
      console.log(`   Length: ${html.length} chars`);
      // Show first 500 chars of body
      const bodyMatch = html.match(/<body[^>]*>([\s\S]{0,500})/i);
      if (bodyMatch) console.log(`   Body preview: ${bodyMatch[1].replace(/\s+/g, " ").substring(0, 300)}`);
      // Look for file links
      const links = [...html.matchAll(/href=["']([^"']*\.(?:pdf|doc|docx|xls|xlsx|jpg|jpeg|png|zip|txt|esx)[^"']*)/gi)];
      if (links.length > 0) {
        console.log(`   File links found: ${links.length}`);
        links.slice(0, 5).forEach(m => console.log(`     ${m[1]}`));
      }
    } else {
      console.log(`❌ miss: ${url}`);
    }
  }

  // Now use browser to intercept tab-click requests
  console.log("\n--- Browser tab-click discovery ---");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  // Restore cookies
  const cookiePairs = aspCookies.split(";").map(s => s.trim()).filter(Boolean);
  const cookieObjs = cookiePairs.map(pair => {
    const eq = pair.indexOf("=");
    return {
      name: pair.substring(0, eq),
      value: pair.substring(eq + 1),
      domain: new URL(aspBase).hostname,
      path: "/",
    };
  });
  await context.addCookies(cookieObjs);

  const page = await context.newPage();

  const capturedRequests = [];
  page.on("request", req => {
    const url = req.url();
    if (url.includes(".asp") || url.includes("/system/")) {
      capturedRequests.push({ url, method: req.method() });
    }
  });

  await page.goto(`${aspBase}/system/claimView.asp?claimID=${CLAIM_ID}`, {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  console.log("Page loaded. Looking for tabs...");

  // Find all tab-like links/buttons
  const tabLinks = await page.evaluate(() => {
    const results = [];
    // Look for links/buttons with tab-like text
    const tabKeywords = ["report", "document", "file", "attach", "upload", "doc"];
    document.querySelectorAll("a, button, td, th, li, div[onclick]").forEach(el => {
      const text = (el.textContent || "").toLowerCase().trim();
      const onclick = el.getAttribute("onclick") || "";
      const href = el.getAttribute("href") || "";
      if (tabKeywords.some(k => text.includes(k)) && text.length < 50) {
        results.push({ tag: el.tagName, text: el.textContent.trim(), onclick, href });
      }
    });
    return results;
  });

  console.log(`\nTab-like elements found: ${tabLinks.length}`);
  tabLinks.forEach(t => console.log(`  [${t.tag}] "${t.text}" onclick="${t.onclick}" href="${t.href}"`));

  // Click each tab-like element and capture requests
  for (const tab of tabLinks.slice(0, 10)) {
    const beforeCount = capturedRequests.length;
    try {
      if (tab.href && tab.href !== "#" && !tab.href.startsWith("javascript")) {
        await page.goto(`${aspBase}${tab.href.startsWith("/") ? tab.href : "/system/" + tab.href}`, {
          waitUntil: "networkidle", timeout: 10000,
        });
      } else {
        // Click by text
        const el = await page.getByText(tab.text, { exact: true }).first();
        if (el) {
          await el.click();
          await page.waitForTimeout(2000);
        }
      }
      const newReqs = capturedRequests.slice(beforeCount);
      if (newReqs.length > 0) {
        console.log(`\nAfter clicking "${tab.text}":`);
        newReqs.forEach(r => console.log(`  ${r.method} ${r.url}`));
      }
    } catch (e) {
      // ignore nav errors
    }
  }

  // Dump all captured requests
  console.log("\n--- All captured ASP requests ---");
  [...new Set(capturedRequests.map(r => r.url))].forEach(u => console.log(u));

  // Check all iframes for reports content
  console.log("\n--- Iframe contents ---");
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const url = frame.url();
      if (url && url !== "about:blank") {
        const content = await frame.content();
        console.log(`\nFrame: ${url} (${content.length} chars)`);
        if (content.includes(".pdf") || content.includes(".doc") || content.includes("report")) {
          // Look for file links in this frame
          const links = [...content.matchAll(/href=["']([^"']*\.(?:pdf|doc|docx|xls|xlsx|jpg|png)[^"']*)/gi)];
          console.log(`  File links: ${links.length}`);
          links.slice(0, 10).forEach(m => console.log(`    ${m[1]}`));
          // Show body preview
          const b = content.match(/<body[^>]*>([\s\S]{0,300})/i);
          if (b) console.log(`  Body: ${b[1].replace(/\s+/g, " ")}`);
        }
      }
    } catch { }
  }

  await browser.close();
  console.log("\n=== Discovery complete ===");
}

async function fetchAsp(relPath) {
  try {
    const res = await fetch(`${aspBase}${relPath}`, {
      headers: {
        "Cookie": aspCookies,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (html.includes("Session has expired") || html.includes("Please log in")) return null;
    if (html.includes("ftevolve.com/auth") || html.includes("/sign-in") || html.includes("Forgot password")) return null;
    if ((html.includes("Login") || html.includes("Sign in")) && html.includes("password") && html.length < 8000) return null;
    if (html.length < 300) return null;
    return html;
  } catch {
    return null;
  }
}

discoverReportsTab().catch(console.error);
