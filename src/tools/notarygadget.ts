import { chromium } from "playwright";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const NG_URL = "https://www.notarygadget.com";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

async function getPage() {
  const email = process.env.NOTARYGADGET_EMAIL;
  const password = process.env.NOTARYGADGET_PASSWORD;
  if (!email || !password) {
    throw new Error("NOTARYGADGET_EMAIL and NOTARYGADGET_PASSWORD must be set in .env");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Capture the OperationsLogin.asp response to diagnose failures
  let loginResponseStatus = 0;
  let loginResponseBody = "";
  page.on("response", async (resp) => {
    if (resp.url().includes("OperationsLogin")) {
      loginResponseStatus = resp.status();
      loginResponseBody = await resp.text().catch(() => "");
    }
  });

  // Login — NotaryGadget uses classic ASP with login at /UserLogin
  await page.goto(`${NG_URL}/UserLogin`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector('#txtUsername', { timeout: 20000 });
  await page.fill('#txtUsername', email);
  await page.fill('#txtPassword', password);
  // NotaryGadget uses a <div onclick="Login();"> not a real button — call it directly
  await page.evaluate(() => (window as any).Login());
  // Wait for navigation
  await page.waitForTimeout(8000);
  await page.waitForLoadState("domcontentloaded");
  const finalUrl = page.url();
  if (!finalUrl.includes("MyBusiness")) {
    throw new Error(
      `NotaryGadget login failed.\n` +
      `Landed on: ${finalUrl}\n` +
      `OperationsLogin status: ${loginResponseStatus || "no response (IP may be blocked)"}\n` +
      `Server response: ${loginResponseBody.substring(0, 300) || "none"}`
    );
  }

  return { browser, page };
}

export async function notarygadgetCreateSigning(args: {
  customer: string;
  date: string;
  time: string;
  fee: number;
  location: string;
  signer_names: string[];
  package_type?: string;
  notes?: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    // Navigate to new signing order
    await page.goto(`${NG_URL}/Signings/Create`);
    await page.waitForLoadState("networkidle");

    // Customer/company
    const customerField = page.locator('input[name="Company"], #Company, input[placeholder*="company" i], input[placeholder*="customer" i]').first();
    await customerField.fill(args.customer);

    // Check if autocomplete appears and select it
    try {
      await page.waitForSelector('.autocomplete-suggestion, .dropdown-item', { timeout: 2000 });
      await page.click('.autocomplete-suggestion:first-child, .dropdown-item:first-child');
    } catch {
      // No autocomplete, continue
    }

    // Date
    const dateField = page.locator('input[name="SigningDate"], #SigningDate, input[type="date"]').first();
    await dateField.fill(args.date);

    // Time
    const timeField = page.locator('input[name="SigningTime"], #SigningTime, input[type="time"]').first();
    await timeField.fill(args.time);

    // Fee
    const feeField = page.locator('input[name="Fee"], #Fee, input[name*="fee" i], input[name*="amount" i]').first();
    await feeField.fill(String(args.fee));

    // Location/address
    const locationField = page.locator('input[name="Location"], #Location, input[name*="address" i], textarea[name*="location" i]').first();
    await locationField.fill(args.location);

    // Signer names
    const signerField = page.locator('input[name="SignerName"], #SignerName, input[name*="signer" i], input[placeholder*="signer" i]').first();
    await signerField.fill(args.signer_names.join(", "));

    // Package type / notes
    if (args.package_type || args.notes) {
      const notesField = page.locator('textarea[name="Notes"], #Notes, textarea[name*="note" i], textarea[name*="description" i]').first();
      const notesText = [args.package_type && `Package: ${args.package_type}`, args.notes].filter(Boolean).join("\n");
      try { await notesField.fill(notesText); } catch { /* optional field */ }
    }

    // Submit
    await page.click('button[type="submit"], input[type="submit"], .btn-primary, button:has-text("Save"), button:has-text("Create")');
    await page.waitForLoadState("networkidle");

    const url = page.url();
    return ok(
      `Signing order created in NotaryGadget!\n` +
      `Customer: ${args.customer}\n` +
      `Date: ${args.date} at ${args.time}\n` +
      `Location: ${args.location}\n` +
      `Signers: ${args.signer_names.join(", ")}\n` +
      `Fee: $${args.fee}\n` +
      `URL: ${url}`
    );
  } finally {
    await browser.close();
  }
}

export async function notarygadgetCompleteSigning(args: {
  signing_id?: string;
  notarization_count: number;
  date_completed?: string;
  notes?: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    if (args.signing_id) {
      await page.goto(`${NG_URL}/Signings/Edit/${args.signing_id}`);
    } else {
      // Go to most recent incomplete signing
      await page.goto(`${NG_URL}/Signings`);
      await page.waitForLoadState("networkidle");
      await page.click('.signing-row:first-child a, table tbody tr:first-child a');
    }
    await page.waitForLoadState("networkidle");

    // Mark as complete
    const completeBtn = page.locator('button:has-text("Complete"), a:has-text("Complete"), input[value*="Complete"]').first();
    try { await completeBtn.click(); } catch { /* may already be on edit form */ }

    // Notarization count
    const notaryCountField = page.locator('input[name*="Notariz" i], input[name*="notariz" i], #NotarizationCount').first();
    await notaryCountField.fill(String(args.notarization_count));

    // Date completed
    if (args.date_completed) {
      const dateField = page.locator('input[name*="CompletedDate"], input[name*="DateCompleted"]').first();
      try { await dateField.fill(args.date_completed); } catch { /* optional */ }
    }

    // Notes
    if (args.notes) {
      const notesField = page.locator('textarea[name="Notes"], #Notes').first();
      try { await notesField.fill(args.notes); } catch { /* optional */ }
    }

    await page.click('button[type="submit"], input[type="submit"], button:has-text("Save")');
    await page.waitForLoadState("networkidle");

    return ok(`Signing marked complete. Notarizations recorded: ${args.notarization_count}`);
  } finally {
    await browser.close();
  }
}

export async function notarygadgetRecordPayment(args: {
  signing_id?: string;
  amount: number;
  payment_date?: string;
  payment_method?: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    if (args.signing_id) {
      await page.goto(`${NG_URL}/Signings/Edit/${args.signing_id}`);
    } else {
      await page.goto(`${NG_URL}/Signings`);
      await page.waitForLoadState("networkidle");
      await page.click('.signing-row:first-child a, table tbody tr:first-child a');
    }
    await page.waitForLoadState("networkidle");

    // Find payment section
    const paymentBtn = page.locator('button:has-text("Payment"), a:has-text("Payment"), button:has-text("Paid")').first();
    try { await paymentBtn.click(); await page.waitForLoadState("networkidle"); } catch { /* may be inline */ }

    // Amount
    const amountField = page.locator('input[name*="Amount"], input[name*="Payment"], #PaymentAmount').first();
    await amountField.fill(String(args.amount));

    // Date
    if (args.payment_date) {
      const dateField = page.locator('input[name*="PaymentDate"], input[name*="DatePaid"]').first();
      try { await dateField.fill(args.payment_date); } catch { /* optional */ }
    }

    // Method
    if (args.payment_method) {
      const methodField = page.locator('select[name*="Method"], input[name*="Method"]').first();
      try { await methodField.fill(args.payment_method); } catch { /* optional */ }
    }

    await page.click('button[type="submit"], input[type="submit"], button:has-text("Save")');
    await page.waitForLoadState("networkidle");

    return ok(`Payment of $${args.amount} recorded${args.payment_date ? ` for ${args.payment_date}` : ""}.`);
  } finally {
    await browser.close();
  }
}

export async function notarygadgetGetSignings(args: {
  max_results?: number;
  status?: "pending" | "completed" | "all";
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await page.goto(`${NG_URL}/Signings`);
    await page.waitForLoadState("networkidle");

    // Get signing rows from table
    const rows = await page.locator('table tbody tr, .signing-row').all();
    const limit = Math.min(rows.length, args.max_results ?? 10);
    const results: string[] = [];

    for (let i = 0; i < limit; i++) {
      const text = await rows[i].innerText();
      results.push(text.trim().replace(/\t+/g, " | "));
    }

    if (results.length === 0) return ok("No signings found.");
    return ok(`Recent signings:\n\n${results.join("\n---\n")}`);
  } finally {
    await browser.close();
  }
}
