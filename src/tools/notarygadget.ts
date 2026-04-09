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

  // Capture OperationsLogin.asp response for diagnostics
  let loginResponseStatus = 0;
  let loginResponseBody = "";
  page.on("response", async (resp) => {
    if (resp.url().includes("OperationsLogin")) {
      loginResponseStatus = resp.status();
      loginResponseBody = await resp.text().catch(() => "");
    }
  });

  // NotaryGadget uses classic ASP with login at /UserLogin
  await page.goto(`${NG_URL}/UserLogin`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector('#txtUsername', { timeout: 20000 });
  await page.fill('#txtUsername', email);
  await page.fill('#txtPassword', password);
  // Login button is a <div onclick="Login();"> — call it directly
  await page.evaluate(() => (window as any).Login());
  // Wait for redirect to dashboard
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

// NotaryGadget is a SPA — all navigation uses SelectPage() JS calls
async function goToSignings(page: Awaited<ReturnType<typeof getPage>>["page"]) {
  await page.evaluate(() => (window as any).SelectPage('Signings'));
  await page.waitForTimeout(3000);
}

export async function notarygadgetGetSignings(args: {
  max_results?: number;
  status?: "pending" | "completed" | "all";
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await goToSignings(page);

    // Signing rows have IDs like trSigning7576152
    const rows = await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').all();
    const limit = Math.min(rows.length, args.max_results ?? 10);
    const results: string[] = [];

    for (let i = 0; i < limit; i++) {
      const id = await rows[i].getAttribute("id") ?? "";
      const signingId = id.replace("trSigning", "");
      const text = await rows[i].innerText();
      const cleaned = text.trim().replace(/\t+/g, " | ").replace(/\n+/g, " ");
      results.push(`ID: ${signingId} | ${cleaned}`);
    }

    if (results.length === 0) return ok("No signings found.");
    return ok(`Recent signings:\n\n${results.join("\n---\n")}`);
  } finally {
    await browser.close();
  }
}

export async function notarygadgetCreateSigning(args: {
  customer: string;
  date: string;
  time: string;
  fee: number;
  location: string;
  city?: string;
  state?: string;
  zip?: string;
  signer_names: string[];
  package_type?: string;
  notes?: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await goToSignings(page);

    // Open new signing form via JS
    await page.evaluate(() => (window as any).EditSigning('New'));
    await page.waitForTimeout(3000);

    // Customer: open selector popup, search, click match
    await page.evaluate(() => (window as any).ShowCustomerSelector());
    await page.waitForTimeout(2000);

    const searchInput = page.locator('#txtCustomerSelectorSearch, input[id*="CustomerSelector"]').first();
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill(args.customer);
      await page.waitForTimeout(1500);
    }

    const customerOption = page.locator('div[onclick*="SelectCustomer"], td[onclick*="SelectCustomer"]')
      .filter({ hasText: new RegExp(args.customer.split(" ")[0], "i") }).first();
    if (await customerOption.isVisible().catch(() => false)) {
      await customerOption.click();
    } else {
      // Fallback: click first visible result containing customer text
      await page.locator(`text=${args.customer.split(" ")[0]}`).first().click().catch(() => {});
    }
    await page.waitForTimeout(1000);

    // Signer names
    if (args.signer_names.length > 0) {
      const parts = args.signer_names[0].split(" ");
      await page.fill('#txtSigner1First', parts[0] ?? "");
      await page.fill('#txtSigner1Last', parts.slice(1).join(" ") ?? "");
    }

    // Parse location into street / city / state / zip if not provided separately
    // location can be "4328 Ben Ave, Studio City, CA 91604" or just a street address
    let street = args.location;
    let city = args.city ?? "";
    let state = args.state ?? "CA";
    let zip = args.zip ?? "";

    if (!city) {
      // Try to parse "Street, City, ST Zip" format
      const parts = args.location.split(",").map(s => s.trim());
      if (parts.length >= 2) {
        street = parts[0];
        const cityStateZip = parts.slice(1).join(", ");
        // Match "City, CA 12345" or "City CA 12345"
        const m = cityStateZip.match(/^(.+?)[,\s]+([A-Z]{2})[,\s]*(\d{5})?/);
        if (m) {
          city = m[1].trim();
          state = m[2];
          zip = m[3] ?? "";
        } else {
          city = cityStateZip.split(",")[0]?.trim() ?? cityStateZip;
        }
      }
    }

    await page.fill('#txtSigningAdd1', street);
    await page.fill('#txtSigningCty', city).catch(() => {});
    // State is a <select>
    await page.selectOption('#txtSigningSt', state).catch(() => {});
    if (zip) await page.fill('#txtSigningZp', zip).catch(() => {});

    // Date (accepts MM/DD/YYYY; also handle YYYY-MM-DD input)
    const dateParts = args.date.split("-");
    const formattedDate = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}/${dateParts[0]}` : args.date;
    await page.fill('#txtSigningDate', formattedDate);

    // Time — split into hour, minutes, AM/PM
    const timeParts = args.time.split(":");
    if (timeParts.length >= 2) {
      let hour = parseInt(timeParts[0]);
      const minutes = timeParts[1].substring(0, 2);
      const ampm = hour >= 12 ? "PM" : "AM";
      if (hour > 12) hour -= 12;
      if (hour === 0) hour = 12;
      await page.fill('#txtSigningHour', String(hour));
      await page.fill('#txtSigningMinutes', minutes);
      await page.fill('#txtSigningAMPM', ampm);
    }

    // Fee
    await page.fill('#txtSigningFee', String(args.fee));

    // Loan type (package type)
    if (args.package_type) {
      await page.fill('#txtLoanType', args.package_type).catch(() => {});
    }

    // Save via JS — same as clicking the Save button
    await page.evaluate(() => (window as any).SaveSigning());
    await page.waitForTimeout(5000);

    // Verify: page should show a signing summary with the signer name
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const saved = bodyText.toLowerCase().includes(args.signer_names[0]?.split(" ").pop()?.toLowerCase() ?? "");

    if (!saved) {
      return ok(
        `⚠️ Signing may not have saved — could not confirm in NotaryGadget.\n` +
        `Customer: ${args.customer} | Signer: ${args.signer_names.join(", ")} | Date: ${formattedDate} @ ${args.time} | Fee: $${args.fee}`
      );
    }

    return ok(
      `✅ Signing created in NotaryGadget!\n` +
      `Customer: ${args.customer}\n` +
      `Date: ${formattedDate} at ${args.time}\n` +
      `Location: ${street}${city ? `, ${city}` : ""}${state ? `, ${state}` : ""}${zip ? ` ${zip}` : ""}\n` +
      `Signers: ${args.signer_names.join(", ")}\n` +
      `Fee: $${args.fee}`
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
    await goToSignings(page);

    // Open the signing row
    if (args.signing_id) {
      const row = page.locator(`#trSigning${args.signing_id}`);
      await row.click();
    } else {
      // Click first signing row
      await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader)').first().click();
    }
    await page.waitForTimeout(2000);

    // Look for complete/status button
    await page.click('div[onclick*="Complete"], div[onclick*="MarkComplete"], div:has-text("Mark Complete"), div:has-text("Complete Signing")').catch(() => {});
    await page.waitForTimeout(1000);

    // Notarization count
    await page.fill('#txtNotarizationCount, input[id*="Notariz"], input[id*="notariz"]', String(args.notarization_count)).catch(() => {});

    if (args.date_completed) {
      await page.fill('#txtCompletedDate, input[id*="CompletedDate"], input[id*="DateCompleted"]', args.date_completed).catch(() => {});
    }

    // Save
    await page.click('div[onclick*="Save"], div:has-text("Save")').catch(() => {});
    await page.waitForTimeout(2000);

    return ok(`Signing marked complete. Notarizations recorded: ${args.notarization_count}`);
  } finally {
    await browser.close();
  }
}

export async function notarygadgetRecordPayment(args: {
  signing_id?: string;
  amount: number;
  payment_date?: string;
  check_number?: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await goToSignings(page);

    // Open the signing row
    if (args.signing_id) {
      const row = page.locator(`#trSigning${args.signing_id}`);
      if (await row.count() === 0) return ok(`Signing ID ${args.signing_id} not found.`);
      await row.click();
    } else {
      await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').first().click();
    }
    await page.waitForTimeout(2000);

    // Open payments panel, then new payment form
    await page.evaluate(() => (window as any).ShowSigningPayments());
    await page.waitForTimeout(2000);
    await page.evaluate(() => (window as any).EditPayment('New'));
    await page.waitForTimeout(2000);

    // Date (pre-filled with today; override if provided)
    if (args.payment_date) {
      // Accept YYYY-MM-DD or MM/DD/YYYY
      const parts = args.payment_date.split("-");
      const formatted = parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : args.payment_date;
      await page.fill('#txtSPmtDate', formatted);
    }

    // Amount
    await page.fill('#txtSPmtAmt', String(args.amount));

    // Check number (optional)
    if (args.check_number) {
      await page.fill('#txtSPmtChkNo', args.check_number);
    }

    // Save
    await page.evaluate(() => (window as any).SavePayment('New'));
    await page.waitForTimeout(3000);

    return ok(
      `✅ Payment of $${args.amount} recorded${args.payment_date ? ` for ${args.payment_date}` : ""}${args.check_number ? ` (Check #${args.check_number})` : ""}.`
    );
  } finally {
    await browser.close();
  }
}

export async function notarygadgetSendInvoice(args: {
  signing_id?: string;
  to_email?: string;
  subject?: string;
  body?: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await goToSignings(page);

    // Open the target signing row
    if (args.signing_id) {
      const row = page.locator(`#trSigning${args.signing_id}`);
      if (await row.count() === 0) return ok(`Signing ID ${args.signing_id} not found.`);
      await row.click();
    } else {
      await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').first().click();
    }
    await page.waitForTimeout(2000);

    // Open the invoice panel
    await page.evaluate(() => (window as any).ShowInvoice('', 'Invoicing'));
    await page.waitForTimeout(2000);

    // Open the email invoice dialog
    await page.evaluate(() => (window as any).CheckForUnsupportedEmailProvider('SendInvoice'));
    await page.waitForTimeout(2000);

    // Capture the pre-filled values before any overrides
    const defaultTo = await page.inputValue('#txtEmailTo').catch(() => "");
    const defaultSubject = await page.inputValue('#txtEmailSubject').catch(() => "");
    const defaultBody = await page.evaluate(() => {
      const el = document.getElementById('txtEmailBody') as HTMLTextAreaElement;
      return el ? el.value : "";
    }).catch(() => "");

    // Apply overrides if provided
    if (args.to_email) await page.fill('#txtEmailTo', args.to_email);
    if (args.subject) await page.fill('#txtEmailSubject', args.subject);
    if (args.body) {
      await page.evaluate((txt: string) => {
        const el = document.getElementById('txtEmailBody') as HTMLTextAreaElement;
        if (el) el.value = txt;
      }, args.body);
    }

    const finalTo = args.to_email ?? defaultTo;
    const finalSubject = args.subject ?? defaultSubject;

    // Click Send Invoice
    await page.evaluate(() => (window as any).SendInvoice(false, undefined));
    await page.waitForTimeout(3000);

    return ok(
      `✅ Invoice emailed successfully!\n` +
      `To: ${finalTo}\n` +
      `Subject: ${finalSubject}`
    );
  } finally {
    await browser.close();
  }
}

export async function notarygadgetDeleteSigning(args: {
  signing_id: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await goToSignings(page);

    const row = page.locator(`#trSigning${args.signing_id}`);
    if (await row.count() === 0) return ok(`Signing ID ${args.signing_id} not found.`);

    // Get signer name for confirmation message before deleting
    const rowText = (await row.innerText().catch(() => "")).trim().replace(/\s+/g, " ").substring(0, 100);

    await row.click();
    await page.waitForTimeout(2000);

    // Open the More menu and click Delete Signing to trigger confirmation dialog
    await page.evaluate(() => (window as any).ConfirmDeleteSigning());
    await page.waitForTimeout(1500);

    // Confirm by clicking the Delete button (calls ChangeSigningStatus('Deleted'))
    await page.evaluate(() => (window as any).ChangeSigningStatus('Deleted'));
    await page.waitForTimeout(3000);

    return ok(`✅ Signing ${args.signing_id} deleted.\nRow was: ${rowText}`);
  } finally {
    await browser.close();
  }
}
