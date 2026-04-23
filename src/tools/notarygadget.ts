import { chromium, type Browser, type Page } from "playwright";
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
async function goToSignings(page: Page) {
  await page.evaluate(() => (window as any).SelectPage('Signings'));
  await page.waitForTimeout(3000);
}

/**
 * Fill all signer name fields in the signing form.
 * Signer 1 fields are always visible; signers 2-4 require clicking
 * "Add 2nd/3rd/4th Signer" links to reveal their hidden fields first.
 */
async function fillSigners(page: Page, signerNames: string[]) {
  const ordinal = ["1st", "2nd", "3rd", "4th"];
  for (let i = 0; i < Math.min(signerNames.length, 4); i++) {
    const parts = signerNames[i].trim().split(/\s+/);
    const first = parts[0] ?? "";
    const last = parts.slice(1).join(" ") ?? "";

    if (i > 0) {
      // Reveal the hidden signer row by clicking the "Add Nth Signer" link
      const addLink = page.locator([
        `a:has-text("Add ${ordinal[i]} Signer")`,
        `a:has-text("${ordinal[i]} Signer")`,
        `a[onclick*="AddSigner(${i + 1})"]`,
        `a[id*="lnkAddSigner${i + 1}"]`,
        `span[onclick*="AddSigner(${i + 1})"]`,
      ].join(", ")).first();

      const isVisible = await addLink.isVisible({ timeout: 2000 }).catch(() => false);
      if (isVisible) {
        await addLink.click();
        await page.waitForTimeout(800);
      }
    }

    await page.fill(`#txtSigner${i + 1}First`, first).catch(() => {});
    await page.fill(`#txtSigner${i + 1}Last`, last).catch(() => {});
  }
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

    // Normalize signer_names — MCP clients sometimes deliver arrays as comma-separated strings
    const signerNames: string[] = Array.isArray(args.signer_names)
      ? args.signer_names
      : String(args.signer_names).split(",").map(s => s.trim()).filter(Boolean);

    // Signer names — supports up to 4 signers via Add 2nd/3rd/4th Signer links
    if (signerNames.length > 0) {
      await fillSigners(page, signerNames);
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

    // ZIP is required by NotaryGadget — fail early if missing
    if (!zip) {
      await browser.close();
      return ok(
        `❌ Cannot create signing — ZIP code is required but could not be determined from the address.\n` +
        `Address provided: "${args.location}"\n` +
        `Please include the ZIP code in the location string (e.g. "123 Main St, Los Angeles, CA 90001") ` +
        `or pass it explicitly as the 'zip' parameter.`
      );
    }

    await page.fill('#txtSigningAdd1', street);
    await page.fill('#txtSigningCty', city).catch(() => {});
    // State is a <select>
    await page.selectOption('#txtSigningSt', state).catch(() => {});
    await page.fill('#txtSigningZp', zip).catch(() => {});

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
    const saved = bodyText.toLowerCase().includes(signerNames[0]?.split(" ").pop()?.toLowerCase() ?? "");

    // Calculate follow-up time (1 hour after signing)
    const followUpTime = (() => {
      try {
        const [h, mRaw] = args.time.split(":");
        const m = mRaw?.substring(0, 2) ?? "00";
        const followUpHour = (parseInt(h) + 1) % 24;
        const fh = followUpHour % 12 || 12;
        const fampm = followUpHour >= 12 ? "PM" : "AM";
        return `${fh}:${m} ${fampm}`;
      } catch { return "1 hour after signing"; }
    })();

    // Post-save verification: navigate back to signings list and confirm the row exists
    if (saved) {
      await page.evaluate(() => (window as any).SelectPage('Signings'));
      await page.waitForTimeout(3000);

      const verifyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
      const signerLast = (signerNames[0]?.split(" ").pop() ?? "").toLowerCase();
      const customerFirst = args.customer.split(" ")[0].toLowerCase();
      const verified = (signerLast && verifyText.includes(signerLast)) ||
                       (customerFirst && verifyText.includes(customerFirst));

      if (!verified) {
        return ok(
          `⚠️ Signing saved but post-save verification mismatch — signing may not have persisted.\n` +
          `Customer: ${args.customer} | Signer: ${signerNames.join(", ")} | Date: ${formattedDate} @ ${args.time}\n` +
          `Check NotaryGadget manually to confirm.`
        );
      }
    }

    if (!saved) {
      return ok(
        `⚠️ Signing may not have saved — could not confirm in NotaryGadget.\n` +
        `Customer: ${args.customer} | Signer: ${signerNames.join(", ")} | Date: ${formattedDate} @ ${args.time} | Fee: $${args.fee}`
      );
    }

    return ok(
      `✅ Signing created and verified in NotaryGadget!\n` +
      `Customer: ${args.customer}\n` +
      `Date: ${formattedDate} at ${args.time}\n` +
      `Location: ${street}${city ? `, ${city}` : ""}${state ? `, ${state}` : ""}${zip ? ` ${zip}` : ""}\n` +
      `Signers: ${signerNames.join(", ")}\n` +
      `Fee: $${args.fee}\n\n` +
      `📋 Follow-up at ${followUpTime}: Ask how many notarial acts were performed, then record them and send the invoice.`
    );
  } finally {
    await browser.close();
  }
}

export async function notarygadgetUpdateSigning(args: {
  signing_id: string;           // required — numeric NotaryGadget signing ID
  customer?: string;            // change the escrow/title company
  date?: string;                // YYYY-MM-DD or MM/DD/YYYY
  time?: string;                // HH:MM (24h or 12h)
  fee?: number;
  location?: string;            // street address or full address with city/state/zip
  city?: string;
  state?: string;
  zip?: string;
  signer_names?: string[];      // replaces ALL signers when provided
  package_type?: string;
}): Promise<CallToolResult> {
  const log: string[] = [];
  const t0 = Date.now();
  const ms = () => `+${Date.now() - t0}ms`;

  // Normalize signer_names upfront — MCP clients can deliver arrays as comma-separated strings
  const signerNames: string[] = !args.signer_names
    ? []
    : Array.isArray(args.signer_names)
      ? args.signer_names
      : String(args.signer_names).split(",").map(s => s.trim()).filter(Boolean);

  // ── Run main flow; always return the log, even on timeout ─────────────────────
  const runUpdate = async (): Promise<CallToolResult> => {
    log.push(`${ms()} getPage`);
    const { browser: br, page: pg } = await getPage();

    pg.setDefaultTimeout(10000);  // 10s max per Playwright operation

    try {

    log.push(`${ms()} goToSignings`);
    await goToSignings(pg);

    // Locate the signing row — skip row.click(), EditSigning(id) works without it
    log.push(`${ms()} locating #trSigning${args.signing_id}`);
    const row = pg.locator(`#trSigning${args.signing_id}`);
    const rowCount = await row.count().catch(() => 0);
    log.push(`${ms()} rowCount=${rowCount}`);
    if (rowCount === 0) {
      return ok(`Signing ${args.signing_id} not found in the signings list.\nLog: ${log.join(" | ")}`);
    }

    // Click the row to select it, then open edit form
    await row.click().catch(() => {});
    log.push(`${ms()} row clicked`);

    log.push(`${ms()} EditSigning(${args.signing_id})`);
    await pg.evaluate((id: string) => (window as any).EditSigning(id), args.signing_id);

    // Wait for fee field to have a non-empty value (proves async form data loaded)
    log.push(`${ms()} waiting for form data (txtSigningFee non-empty)`);
    const formReady = await pg.waitForFunction(() => {
      const el = document.getElementById("txtSigningFee") as HTMLInputElement | null;
      return !!(el && el.value && el.value.trim().length > 0);
    }, { timeout: 10000 }).then(() => true).catch(() => false);

    const feeValue = await pg.inputValue("#txtSigningFee").catch(() => "(not found)");
    log.push(`${ms()} formReady=${formReady} fee="${feeValue}"`);

    if (!formReady) {
      const snap = (await pg.locator("body").innerText().catch(() => "")).substring(0, 400);
      return ok(
        `⏱ Form did not load for signing ${args.signing_id} (10s timeout).\n` +
        `Log: ${log.join(" | ")}\nPage: ${snap}`
      );
    }

    const updated: string[] = [];

    // Customer
    if (args.customer) {
      await pg.evaluate(() => (window as any).ShowCustomerSelector());
      await pg.waitForTimeout(1500);
      const searchInput = pg.locator('#txtCustomerSelectorSearch, input[id*="CustomerSelector"]').first();
      if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await searchInput.fill(args.customer);
        await pg.waitForTimeout(1000);
      }
      const customerOption = pg.locator('div[onclick*="SelectCustomer"], td[onclick*="SelectCustomer"]')
        .filter({ hasText: new RegExp(args.customer.split(" ")[0], "i") }).first();
      if (await customerOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await customerOption.click();
      } else {
        await pg.locator(`text=${args.customer.split(" ")[0]}`).first().click().catch(() => {});
      }
      await pg.waitForTimeout(500);
      updated.push(`Customer: ${args.customer}`);
      log.push(`${ms()} customer set`);
    }

    // Signers
    if (signerNames.length > 0) {
      log.push(`${ms()} fillSigners([${signerNames.join(", ")}])`);
      await fillSigners(pg, signerNames);
      const s1f = await pg.inputValue("#txtSigner1First").catch(() => "?");
      const s1l = await pg.inputValue("#txtSigner1Last").catch(() => "?");
      log.push(`${ms()} signer1="${s1f} ${s1l}"`);
      updated.push(`Signers: ${signerNames.join(", ")}`);
    }

    // Address
    const hasAddressChange = args.location || args.city || args.state || args.zip;
    if (hasAddressChange) {
      let street = args.location ?? "";
      let city = args.city ?? "";
      let state = args.state ?? "";
      let zip = args.zip ?? "";
      if (args.location && !city) {
        const parts = args.location.split(",").map(s => s.trim());
        if (parts.length >= 2) {
          street = parts[0];
          const csz = parts.slice(1).join(", ");
          const m = csz.match(/^(.+?)[,\s]+([A-Z]{2})[,\s]*(\d{5})?/);
          if (m) { city = m[1].trim(); state = m[2]; zip = m[3] ?? ""; }
          else city = csz.split(",")[0]?.trim() ?? csz;
        }
      }
      if (street) { await pg.fill('#txtSigningAdd1', street).catch(() => {}); updated.push(`Street: ${street}`); }
      if (city)   { await pg.fill('#txtSigningCty', city).catch(() => {});   updated.push(`City: ${city}`); }
      if (state)  { await pg.selectOption('#txtSigningSt', state).catch(() => {}); updated.push(`State: ${state}`); }
      if (zip)    { await pg.fill('#txtSigningZp', zip).catch(() => {});     updated.push(`ZIP: ${zip}`); }
      log.push(`${ms()} address set`);
    }

    // Date
    if (args.date) {
      const parts = args.date.split("-");
      const formatted = parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : args.date;
      await pg.fill('#txtSigningDate', formatted).catch(() => {});
      updated.push(`Date: ${formatted}`);
    }

    // Time
    if (args.time) {
      const tp = args.time.split(":");
      if (tp.length >= 2) {
        let hour = parseInt(tp[0]);
        const min = tp[1].substring(0, 2);
        const ampm = hour >= 12 ? "PM" : "AM";
        if (hour > 12) hour -= 12;
        if (hour === 0) hour = 12;
        await pg.fill('#txtSigningHour', String(hour)).catch(() => {});
        await pg.fill('#txtSigningMinutes', min).catch(() => {});
        await pg.fill('#txtSigningAMPM', ampm).catch(() => {});
        updated.push(`Time: ${args.time}`);
      }
    }

    // Fee
    if (args.fee !== undefined) {
      await pg.fill('#txtSigningFee', String(args.fee)).catch(() => {});
      updated.push(`Fee: $${args.fee}`);
    }

    // Package type
    if (args.package_type) {
      await pg.fill('#txtLoanType', args.package_type).catch(() => {});
      updated.push(`Package: ${args.package_type}`);
    }

    if (updated.length === 0) {
      return ok(`No fields provided to update — signing ${args.signing_id} unchanged.\nLog: ${log.join(" | ")}`);
    }

    log.push(`${ms()} SaveSigning`);
    await pg.evaluate(() => (window as any).SaveSigning());
    log.push(`${ms()} waiting 4s for save`);
    await pg.waitForTimeout(4000);
    log.push(`${ms()} save done`);

    // Post-save verification
    if (signerNames.length > 0) {
      const bodyText = (await pg.locator("body").innerText().catch(() => "")).toLowerCase();
      const signerLast = (signerNames[0].split(" ").pop() ?? "").toLowerCase();
      const verified = signerLast && bodyText.includes(signerLast);
      log.push(`${ms()} verify signer "${signerLast}"=${verified}`);
      if (!verified) {
        return ok(
          `⚠️ Signing ${args.signing_id}: saved but verification mismatch (signer not visible in page).\n` +
          `Log: ${log.join(" | ")}\nFields: ${updated.join(", ")}`
        );
      }
    }

    return ok(
      `✅ Signing ${args.signing_id} updated:\n` +
      updated.map(u => `  • ${u}`).join("\n") +
      `\nLog: ${log.join(" | ")}`
    );
    } finally {
      br.close().catch(() => {});
    }
  };

  // Race the main flow against a 52s timer — always returns the log, never hangs silently.
  // If timeout wins, runUpdate() is still in-flight; its finally block closes the browser.
  const timeoutResult = new Promise<CallToolResult>(resolve =>
    setTimeout(() =>
      resolve(ok(`⏱ notarygadget_update_signing timed out after 52s.\nSteps reached:\n${log.join("\n")}`)),
      52000)
  );

  return Promise.race([
    runUpdate().catch(err => ok(`❌ Error: ${(err as Error).message}\nLog: ${log.join(" | ")}`)),
    timeoutResult,
  ]);
}

export async function notarygadgetCompleteSigning(args: {
  signing_id?: string;
  notarization_count: number;
  date?: string;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await goToSignings(page);

    if (args.signing_id) {
      const row = page.locator(`#trSigning${args.signing_id}`);
      if (await row.count() === 0) return ok(`Signing ID ${args.signing_id} not found.`);
      await row.click();
    } else {
      await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').first().click();
    }
    await page.waitForTimeout(2000);

    // Open notarial acts form
    await page.evaluate(() => (window as any).EditNotarialFees());
    await page.waitForTimeout(2000);

    if (args.notarization_count > 0) {
      // Override date if provided
      if (args.date) {
        const parts = args.date.split("-");
        const formatted = parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : args.date;
        await page.fill('#txtNotarialDate1', formatted);
      }
      await page.fill('#txtNotarialActs1', String(args.notarization_count));
      // Amount per act is pre-filled from account settings ($15.00) — leave as-is
    } else {
      // Check "I did not have any notarial acts for this signing"
      await page.evaluate(() => {
        const div = document.getElementById('divchkZeroNotarialFees');
        if (div) div.click();
      });
      await page.waitForTimeout(500);
    }

    await page.evaluate(() => (window as any).SaveNotarialFees(''));
    await page.waitForTimeout(3000);

    // Close the notarial acts modal and get back to signing summary
    await page.evaluate(() => (window as any).CloseOperationWindow && (window as any).CloseOperationWindow());
    await page.waitForTimeout(1000);

    // Send the invoice automatically
    await page.evaluate(() => (window as any).ShowInvoice('', 'Invoicing'));
    await page.waitForTimeout(2000);
    await page.evaluate(() => (window as any).CheckForUnsupportedEmailProvider('SendInvoice'));
    await page.waitForTimeout(2000);

    const toEmail = await page.inputValue('#txtEmailTo').catch(() => "");
    const subject = await page.inputValue('#txtEmailSubject').catch(() => "");

    await page.evaluate(() => (window as any).SendInvoice(false, undefined));
    await page.waitForTimeout(3000);

    const actsMsg = args.notarization_count > 0
      ? `${args.notarization_count} notarial acts recorded.`
      : `No notarial acts recorded.`;

    return ok(
      `✅ Signing completed!\n` +
      `${actsMsg}\n` +
      `📧 Invoice emailed to: ${toEmail || "customer on file"}\n` +
      `Subject: ${subject}`
    );
  } finally {
    await browser.close();
  }
}

export async function notarygadgetEnterMileage(args: {
  signing_id?: string;
  miles?: number;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await goToSignings(page);

    if (args.signing_id) {
      const row = page.locator(`#trSigning${args.signing_id}`);
      if (await row.count() === 0) return ok(`Signing ID ${args.signing_id} not found.`);
      await row.click();
    } else {
      await page.locator('tr[id^="trSigning"]:not(#trSigningCustomer):not(#trSigningsHeader):not(#trTooManyOldUnpaidSignings)').first().click();
    }
    await page.waitForTimeout(2000);

    await page.evaluate(() => (window as any).EditSigningMileage());
    await page.waitForTimeout(2000);

    const miles = args.miles ?? 0;

    if (miles > 0) {
      await page.fill('#txtMileage1', String(miles));
    } else {
      // Check "I did not have any mileage for this signing"
      await page.evaluate(() => {
        const chk = document.getElementById('chkNoMileage') as HTMLInputElement;
        if (chk && !chk.checked) {
          chk.checked = true;
          (window as any).SelectNoMileage();
        }
      });
      await page.waitForTimeout(500);
    }

    await page.evaluate(() => (window as any).SaveMileage());
    await page.waitForTimeout(3000);

    return ok(
      miles > 0
        ? `✅ Mileage saved: ${miles} miles recorded.`
        : `✅ Mileage saved: marked as no mileage for this signing.`
    );
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
