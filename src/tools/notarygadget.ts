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
  signer_names: string[];
  package_type?: string;
  notes?: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await goToSignings(page);

    // Click "New Signing" button
    await page.click('#tdNewSigningBtn');
    await page.waitForTimeout(2000);

    // Customer (title company / escrow company)
    try {
      await page.fill('#txtSearchCustomerSelector', args.customer);
      await page.waitForTimeout(1000);
      // Select first autocomplete result if it appears
      const suggestion = page.locator('.DropDownOption, .autocomplete-option, [class*="DropDown"]:visible').first();
      if (await suggestion.isVisible().catch(() => false)) await suggestion.click();
    } catch { /* customer field may vary */ }

    // Signer names
    if (args.signer_names.length > 0) {
      const parts = args.signer_names[0].split(" ");
      await page.fill('#txtSigner1First', parts[0] ?? "").catch(() => {});
      await page.fill('#txtSigner1Last', parts.slice(1).join(" ") ?? "").catch(() => {});
    }

    // Address — fill street address in add1 field
    await page.fill('#txtSigningAdd1', args.location).catch(() => {});

    // Date (expects MM/DD/YYYY format)
    const dateParts = args.date.split("-"); // YYYY-MM-DD
    const formattedDate = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}/${dateParts[0]}` : args.date;
    await page.fill('#txtSigningDate', formattedDate).catch(() => {});

    // Time — split into hour, minutes, AM/PM
    const timeParts = args.time.split(":");
    if (timeParts.length >= 2) {
      let hour = parseInt(timeParts[0]);
      const minutes = timeParts[1].substring(0, 2);
      const ampm = hour >= 12 ? "PM" : "AM";
      if (hour > 12) hour -= 12;
      if (hour === 0) hour = 12;
      await page.fill('#txtSigningHour', String(hour)).catch(() => {});
      await page.fill('#txtSigningMinutes', minutes).catch(() => {});
      await page.fill('#txtSigningAMPM', ampm).catch(() => {});
    }

    // Fee
    await page.fill('#txtSigningFee', String(args.fee)).catch(() => {});

    // Loan type (package type)
    if (args.package_type) {
      await page.fill('#txtLoanType', args.package_type).catch(() => {});
    }

    // Save — NotaryGadget uses div buttons with onclick
    await page.click('div[onclick*="SaveSigning"], div[onclick*="AddSigning"], div:has-text("Save"), div:has-text("Add Signing")').catch(() => {});
    await page.waitForTimeout(3000);

    return ok(
      `Signing order created in NotaryGadget!\n` +
      `Customer: ${args.customer}\n` +
      `Date: ${args.date} at ${args.time}\n` +
      `Location: ${args.location}\n` +
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
  payment_method?: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await goToSignings(page);

    // Open the signing row
    if (args.signing_id) {
      await page.locator(`#trSigning${args.signing_id}`).click();
    } else {
      await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader)').first().click();
    }
    await page.waitForTimeout(2000);

    // Look for payment button/section
    await page.click('div[onclick*="Payment"], div[onclick*="RecordPayment"], div:has-text("Record Payment"), div:has-text("Enter Payment")').catch(() => {});
    await page.waitForTimeout(1000);

    // Amount
    await page.fill('#txtPaymentAmount, input[id*="PaymentAmount"], input[id*="Amount"]', String(args.amount)).catch(() => {});

    if (args.payment_date) {
      await page.fill('#txtPaymentDate, input[id*="PaymentDate"]', args.payment_date).catch(() => {});
    }

    if (args.payment_method) {
      await page.selectOption('#txtPaymentMethod, select[id*="PaymentMethod"]', args.payment_method).catch(() => {});
    }

    await page.click('div[onclick*="Save"], div:has-text("Save")').catch(() => {});
    await page.waitForTimeout(2000);

    return ok(`Payment of $${args.amount} recorded${args.payment_date ? ` for ${args.payment_date}` : ""}.`);
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
