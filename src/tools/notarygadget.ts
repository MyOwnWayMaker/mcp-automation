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

    log.push(`${ms()} locating #trSigning${args.signing_id}`);
    const row = pg.locator(`#trSigning${args.signing_id}`);
    const rowCount = await row.count().catch(() => 0);
    log.push(`${ms()} rowCount=${rowCount}`);
    if (rowCount === 0) {
      return ok(`Signing ${args.signing_id} not found in the signings list.\nLog: ${log.join(" | ")}`);
    }

    // Click the row to populate NotaryGadget's global signing state, then wait for it to settle
    await row.click().catch(() => {});
    log.push(`${ms()} row clicked`);
    await pg.waitForTimeout(800);

    // EditSigning may throw if the signing has null/undefined fields (e.g. Address).
    // Catch the error — form data often still loads via async callback even if EditSigning throws.
    log.push(`${ms()} EditSigning(${args.signing_id})`);
    const editErr = await pg.evaluate((id: string) => {
      try { (window as any).EditSigning(id); return null; }
      catch (e: unknown) { return String(e); }
    }, args.signing_id).catch((e: Error) => e.message);
    if (editErr) log.push(`${ms()} EditSigning error (continuing): ${editErr}`);

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

export async function notarygadgetGetPayments(args: {
  signing_id: string;
  dump_html?: boolean;
}): Promise<CallToolResult> {
  const { browser, page } = await getPage();

  try {
    await goToSignings(page);

    const row = page.locator(`#trSigning${args.signing_id}`);
    if (await row.count() === 0) {
      return ok(`Signing ID ${args.signing_id} not found.`);
    }
    await row.click();
    await page.waitForTimeout(2000);

    // Open the payments panel (same call record_payment uses)
    await page.evaluate(() => (window as any).ShowSigningPayments());
    await page.waitForTimeout(2500);

    if (args.dump_html) {
      const dump = await page.evaluate(() => {
        const candidates = [
          'div[id*="ayment" i]',
          'table[id*="ayment" i]',
          '[id*="SigningPayments"]',
        ];
        const found: { selector: string; html: string }[] = [];
        for (const s of candidates) {
          for (const el of Array.from(document.querySelectorAll(s))) {
            found.push({
              selector: s,
              html: (el as HTMLElement).outerHTML.substring(0, 4000),
            });
          }
        }
        return {
          panels: found,
          bodyTextSnippet: document.body.innerText.substring(0, 3000),
        };
      });
      return ok(
        `HTML dump for signing ${args.signing_id}:\n` +
        `Panels found: ${dump.panels.length}\n\n` +
        dump.panels.map((p, i) => `[${i}] selector=${p.selector}\n${p.html}\n`).join("\n---\n") +
        `\n\nBody snippet:\n${dump.bodyTextSnippet}`
      );
    }

    // Scrape payments. Try several row patterns — NotaryGadget's DOM
    // for signings uses tr[id^="trSigning"], so payment rows are most
    // likely tr[id^="trPayment"] or tr[id^="trSPmt"].
    // Payment rows live at tr[onclick*="EditPayment("] inside #divSigningPayments,
    // with three td.tdWhiteWithLines cells: date, check #, amount (+ trash icon).
    // The "New Payment" button is a separate div with EditPayment('New') — we
    // exclude it by requiring an existing payment id in the onclick (any digit).
    const result = await page.evaluate(() => {
      const allRows = Array.from(document.querySelectorAll('tr[onclick*="EditPayment"]'));
      const paymentRows = allRows.filter(r => {
        const oc = r.getAttribute("onclick") || "";
        // Exclude EditPayment('New') and similar non-numeric ids
        return /EditPayment\(\s*['"]?\d/.test(oc);
      });

      const parsed = paymentRows.map(r => {
        const cells = Array.from(r.querySelectorAll("td.tdWhiteWithLines"));
        const cellText = cells.map(c => (c as HTMLElement).innerText.trim());
        // Pull payment id out of the onclick: EditPayment('12345')
        const oc = r.getAttribute("onclick") || "";
        const idMatch = oc.match(/EditPayment\(\s*['"]?(\d+)/);
        // NotaryGadget renders empty check numbers as an em-dash placeholder
        const rawCheck = cellText[1] || "";
        const check = /^[—\-–]+$/.test(rawCheck) ? "" : rawCheck;
        // Amount cell already contains the $ — strip it so we don't double up
        const rawAmount = cellText[2] || "";
        const amount = rawAmount.replace(/^\$/, "");
        return {
          payment_id: idMatch ? idMatch[1] : "",
          date: cellText[0] || "",
          check_number: check,
          amount,
          raw: (r as HTMLElement).innerText
            .trim()
            .replace(/\s+/g, " "),
        };
      });

      return {
        all_match_count: allRows.length,
        payment_count: parsed.length,
        rows: parsed,
        fallbackText: parsed.length === 0
          ? document.body.innerText.replace(/\s+/g, " ").substring(0, 1500)
          : "",
      };
    });

    if (result.payment_count === 0) {
      return ok(
        `No payments found for signing ${args.signing_id}.\n` +
        `(${result.all_match_count} EditPayment row(s) total — likely just the "New Payment" button, meaning no payments have been logged.)\n\n` +
        `If you expected payments here, re-run with dump_html: true.\n` +
        `Page snippet:\n${result.fallbackText}`
      );
    }

    const lines = result.rows.map(r =>
      `  • ${r.date}  |  $${r.amount}${r.check_number ? `  |  Check #${r.check_number}` : ""}  (payment_id ${r.payment_id})`
    );
    return ok(
      `Payments for signing ${args.signing_id} — ${result.payment_count} found:\n\n` +
      lines.join("\n")
    );
  } finally {
    await browser.close();
  }
}

// Helper: open a signing's payments panel and scrape the payment rows.
// Used by update_payment / delete_payment for before/after snapshots.
async function readPaymentsPanel(page: Page): Promise<{
  payment_id: string;
  date: string;
  check_number: string;
  amount: string;
}[]> {
  return page.evaluate(() => {
    const allRows = Array.from(document.querySelectorAll('tr[onclick*="EditPayment"]'));
    return allRows
      .filter(r => /EditPayment\(\s*['"]?\d/.test(r.getAttribute("onclick") || ""))
      .map(r => {
        const cells = Array.from(r.querySelectorAll("td.tdWhiteWithLines"));
        const c = cells.map(x => (x as HTMLElement).innerText.trim());
        const oc = r.getAttribute("onclick") || "";
        const idMatch = oc.match(/EditPayment\(\s*['"]?(\d+)/);
        const rawCheck = c[1] || "";
        const check = /^[—\-–]+$/.test(rawCheck) ? "" : rawCheck;
        const amount = (c[2] || "").replace(/^\$/, "");
        return {
          payment_id: idMatch ? idMatch[1] : "",
          date: c[0] || "",
          check_number: check,
          amount,
        };
      });
  });
}

function formatDateMMDDYYYY(input: string): string {
  // Accept YYYY-MM-DD or MM/DD/YYYY; emit MM/DD/YYYY for NotaryGadget's form.
  const parts = input.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : input;
}

export async function notarygadgetUpdatePayment(args: {
  signing_id: string;
  payment_id: string;
  date?: string;
  amount?: number;
  check_number?: string;
}): Promise<CallToolResult> {
  const log: string[] = [];
  const t0 = Date.now();
  const ms = () => `+${Date.now() - t0}ms`;

  const { browser, page } = await getPage();

  try {
    page.setDefaultTimeout(10000);

    log.push(`${ms()} goToSignings`);
    await goToSignings(page);

    log.push(`${ms()} locating #trSigning${args.signing_id}`);
    const row = page.locator(`#trSigning${args.signing_id}`);
    if (await row.count() === 0) {
      return ok(`Signing ${args.signing_id} not found.\nLog: ${log.join(" | ")}`);
    }
    await row.click().catch(() => {});
    await page.waitForTimeout(1500);

    log.push(`${ms()} ShowSigningPayments`);
    await page.evaluate(() => (window as any).ShowSigningPayments());
    await page.waitForTimeout(2000);

    // Snapshot the row before editing, so we can return a clean before/after diff.
    const before = (await readPaymentsPanel(page)).find(p => p.payment_id === args.payment_id);
    if (!before) {
      return ok(
        `Payment ${args.payment_id} not found on signing ${args.signing_id}.\n` +
        `Log: ${log.join(" | ")}`
      );
    }
    log.push(`${ms()} before snapshot: date=${before.date} amount=${before.amount} check=${before.check_number || "-"}`);

    log.push(`${ms()} EditPayment(${args.payment_id})`);
    await page.evaluate((id: string) => (window as any).EditPayment(id), args.payment_id);

    // Wait for the form to populate — txtSPmtAmt holds the amount.
    const formReady = await page.waitForFunction(() => {
      const el = document.getElementById("txtSPmtAmt") as HTMLInputElement | null;
      return !!(el && el.value && el.value.trim().length > 0);
    }, { timeout: 8000 }).then(() => true).catch(() => false);
    log.push(`${ms()} formReady=${formReady}`);

    if (!formReady) {
      return ok(`⏱ Payment edit form did not load.\nLog: ${log.join(" | ")}`);
    }

    const updated: string[] = [];

    if (args.date) {
      const formatted = formatDateMMDDYYYY(args.date);
      await page.fill('#txtSPmtDate', formatted).catch(() => {});
      updated.push(`Date: ${before.date} → ${formatted}`);
    }
    if (args.amount !== undefined) {
      await page.fill('#txtSPmtAmt', String(args.amount)).catch(() => {});
      updated.push(`Amount: $${before.amount} → $${args.amount}`);
    }
    if (args.check_number !== undefined) {
      await page.fill('#txtSPmtChkNo', args.check_number).catch(() => {});
      updated.push(`Check #: ${before.check_number || "(none)"} → ${args.check_number || "(none)"}`);
    }

    if (updated.length === 0) {
      return ok(
        `No fields provided to update — payment ${args.payment_id} unchanged.\n` +
        `Current: date=${before.date} amount=$${before.amount} check=${before.check_number || "(none)"}\n` +
        `Log: ${log.join(" | ")}`
      );
    }

    log.push(`${ms()} SavePayment(${args.payment_id})`);
    await page.evaluate((id: string) => (window as any).SavePayment(id), args.payment_id);
    await page.waitForTimeout(3500);

    // Re-read to verify the change landed
    const after = (await readPaymentsPanel(page)).find(p => p.payment_id === args.payment_id);
    log.push(`${ms()} after snapshot: ${after ? `date=${after.date} amount=${after.amount} check=${after.check_number || "-"}` : "NOT FOUND"}`);

    if (!after) {
      return ok(
        `⚠️ Save called but payment ${args.payment_id} no longer visible on the signing.\n` +
        `Manual check recommended.\nLog: ${log.join(" | ")}`
      );
    }

    // Verify the requested changes actually took.
    const mismatches: string[] = [];
    if (args.date) {
      const expected = formatDateMMDDYYYY(args.date);
      if (after.date !== expected) mismatches.push(`date expected=${expected} got=${after.date}`);
    }
    if (args.amount !== undefined && parseFloat(after.amount) !== args.amount) {
      mismatches.push(`amount expected=${args.amount} got=${after.amount}`);
    }
    if (args.check_number !== undefined && after.check_number !== args.check_number) {
      mismatches.push(`check expected="${args.check_number}" got="${after.check_number}"`);
    }

    if (mismatches.length > 0) {
      return ok(
        `⚠️ Payment ${args.payment_id} saved but post-write verification failed:\n` +
        mismatches.map(m => `  • ${m}`).join("\n") +
        `\n\nApplied: ${updated.join("; ")}\nLog: ${log.join(" | ")}`
      );
    }

    return ok(
      `✅ Payment ${args.payment_id} updated on signing ${args.signing_id}:\n` +
      updated.map(u => `  • ${u}`).join("\n") +
      `\n\nAfter: ${after.date}  |  $${after.amount}${after.check_number ? `  |  Check #${after.check_number}` : ""}`
    );
  } finally {
    await browser.close();
  }
}

export async function notarygadgetDeletePayment(args: {
  signing_id: string;
  payment_id: string;
}): Promise<CallToolResult> {
  const log: string[] = [];
  const t0 = Date.now();
  const ms = () => `+${Date.now() - t0}ms`;

  const { browser, page } = await getPage();

  try {
    page.setDefaultTimeout(10000);

    log.push(`${ms()} goToSignings`);
    await goToSignings(page);

    const row = page.locator(`#trSigning${args.signing_id}`);
    if (await row.count() === 0) {
      return ok(`Signing ${args.signing_id} not found.\nLog: ${log.join(" | ")}`);
    }
    await row.click().catch(() => {});
    await page.waitForTimeout(1500);

    log.push(`${ms()} ShowSigningPayments`);
    await page.evaluate(() => (window as any).ShowSigningPayments());
    await page.waitForTimeout(2000);

    const before = (await readPaymentsPanel(page)).find(p => p.payment_id === args.payment_id);
    if (!before) {
      return ok(
        `Payment ${args.payment_id} not found on signing ${args.signing_id} (already deleted?).\n` +
        `Log: ${log.join(" | ")}`
      );
    }
    log.push(`${ms()} before: date=${before.date} amount=${before.amount} check=${before.check_number || "-"}`);

    // Open the delete-confirm modal.
    log.push(`${ms()} ShowConfirmDeletePayment(${args.payment_id})`);
    await page.evaluate((id: string) => (window as any).ShowConfirmDeletePayment(id), args.payment_id);
    await page.waitForTimeout(1500);

    // Try the most likely confirm functions in order. NotaryGadget's pattern
    // (see ChangeSigningStatus('Deleted') in delete_signing) suggests one of these.
    const confirmAttempts: string[] = [];
    const tryConfirm = async (label: string, fn: () => unknown) => {
      try {
        await page.evaluate(fn);
        confirmAttempts.push(`${label}: ok`);
        return true;
      } catch (e: unknown) {
        confirmAttempts.push(`${label}: ${(e as Error).message.substring(0, 60)}`);
        return false;
      }
    };

    let confirmed = false;
    // Most common pattern observed in NotaryGadget: status-change function.
    if (!confirmed) confirmed = await tryConfirm("DeletePayment", () => (window as any).DeletePayment(args.payment_id));
    if (!confirmed) confirmed = await tryConfirm("ConfirmDeletePayment", () => (window as any).ConfirmDeletePayment(args.payment_id));
    if (!confirmed) confirmed = await tryConfirm("ChangePaymentStatus", () => (window as any).ChangePaymentStatus("Deleted"));
    // Fallback: click any visible "Delete" button in the modal.
    if (!confirmed) {
      const btn = page.locator('button:has-text("Delete"), input[value="Delete"], a:has-text("Delete")').last();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click();
        confirmAttempts.push("modal-delete-button: clicked");
        confirmed = true;
      }
    }

    log.push(`${ms()} confirm attempts: ${confirmAttempts.join(" | ")}`);
    if (!confirmed) {
      return ok(
        `❌ Could not confirm deletion of payment ${args.payment_id}.\n` +
        `Tried: ${confirmAttempts.join(" | ")}\n` +
        `Log: ${log.join(" | ")}`
      );
    }

    await page.waitForTimeout(3000);

    // Re-read the panel to verify the row is gone.
    const after = await readPaymentsPanel(page);
    const stillThere = after.find(p => p.payment_id === args.payment_id);
    log.push(`${ms()} after: ${after.length} payment(s), target ${stillThere ? "STILL PRESENT" : "gone"}`);

    if (stillThere) {
      return ok(
        `⚠️ Delete called but payment ${args.payment_id} still appears on the signing.\n` +
        `Manual check recommended.\nLog: ${log.join(" | ")}`
      );
    }

    return ok(
      `✅ Payment ${args.payment_id} deleted from signing ${args.signing_id}.\n` +
      `Was: ${before.date}  |  $${before.amount}${before.check_number ? `  |  Check #${before.check_number}` : ""}\n` +
      `Remaining payments on signing: ${after.length}`
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

// NotaryGadget calls customers "Contacts" internally. Edit form fields:
// #txtCompany, #txtAddress1, #txtAddress2, #txtCity, #txtState (select),
// #txtZip, #txtFirst, #txtLast, #txtTitle, #txtEmail, #txtOffice, #txtCell,
// #txtFax, #txtWebsite, #txtInvEmail, #txtInstructions, #txtNotes.
// Save fn: SaveContact(<numericId>).
export async function notarygadgetUpdateCustomer(args: {
  customer_id?: string;
  customer_name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  company?: string;
  first?: string;
  last?: string;
  title?: string;
  email?: string;
  office?: string;
  cell?: string;
  fax?: string;
  website?: string;
  invoice_email?: string;
  notes?: string;
  instructions?: string;
}): Promise<CallToolResult> {
  if (!args.customer_id && !args.customer_name) {
    return ok("❌ Must provide either customer_id or customer_name.");
  }

  const { browser, page } = await getPage();
  const log: string[] = [];
  const ms = () => `[+${Math.round(performance.now() / 1000)}s]`;

  try {
    await page.evaluate(() => (window as any).SelectPage("Contacts"));
    await page.waitForTimeout(4000);
    log.push(`${ms()} on Contacts page`);

    // ─── Resolve customer_id ───────────────────────────────────────────────
    let customerId = args.customer_id;
    let resolvedFromSearch = false;

    if (!customerId) {
      const term = (args.customer_name ?? "").trim();
      log.push(`${ms()} searching for "${term}"`);
      await page.fill("#txtSearchValue", term);
      await page.locator("#txtSearchValue").press("Enter").catch(() => {});
      await page.waitForTimeout(2500);

      const matches = await page.evaluate(() => {
        const out: { id: string; text: string }[] = [];
        document.querySelectorAll("tr[onclick*='GetContactData']").forEach((el) => {
          const oc = el.getAttribute("onclick") ?? "";
          const m = oc.match(/GetContactData\((\d+)\)/);
          if (!m) return;
          const txt = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
          out.push({ id: m[1], text: txt });
        });
        return out;
      });

      log.push(`${ms()} search returned ${matches.length} match(es)`);
      if (matches.length === 0) {
        await browser.close();
        return ok(`❌ No customer matching "${term}".\nLog:\n${log.join("\n")}`);
      }
      if (matches.length > 1) {
        await browser.close();
        const listing = matches.map((m) => `  • ID ${m.id} → ${m.text.substring(0, 120)}`).join("\n");
        return ok(
          `❌ Multiple customers match "${term}". Pass customer_id explicitly.\n${listing}\nLog:\n${log.join("\n")}`,
        );
      }
      customerId = matches[0].id;
      resolvedFromSearch = true;
      log.push(`${ms()} resolved ${term} → ID ${customerId}`);
    }

    // ─── Load contact data into in-memory state, then open edit form ──────
    // EditContact crashes if the contact isn't already in CONTACTS[]
    await page.evaluate((cid) => (window as any).GetContactData(parseInt(cid, 10)), customerId);
    await page.waitForTimeout(2500);
    log.push(`${ms()} GetContactData(${customerId}) loaded`);

    await page.evaluate((cid) => (window as any).EditContact(cid), customerId);
    await page.waitForTimeout(2500);
    log.push(`${ms()} EditContact opened`);

    // Confirm the edit form is rendered for the right contact
    await page.waitForSelector("#txtCompany", { timeout: 10000 });
    const formCompany = (await page.locator("#txtCompany").inputValue().catch(() => "")) || "";
    log.push(`${ms()} edit form for company="${formCompany}"`);

    // Capture current values for the diff report
    const before = await page.evaluate(() => ({
      company: (document.getElementById("txtCompany") as HTMLInputElement)?.value ?? "",
      address1: (document.getElementById("txtAddress1") as HTMLInputElement)?.value ?? "",
      address2: (document.getElementById("txtAddress2") as HTMLInputElement)?.value ?? "",
      city: (document.getElementById("txtCity") as HTMLInputElement)?.value ?? "",
      state: (document.getElementById("txtState") as HTMLSelectElement)?.value ?? "",
      zip: (document.getElementById("txtZip") as HTMLInputElement)?.value ?? "",
      first: (document.getElementById("txtFirst") as HTMLInputElement)?.value ?? "",
      last: (document.getElementById("txtLast") as HTMLInputElement)?.value ?? "",
      title: (document.getElementById("txtTitle") as HTMLInputElement)?.value ?? "",
      email: (document.getElementById("txtEmail") as HTMLInputElement)?.value ?? "",
      office: (document.getElementById("txtOffice") as HTMLInputElement)?.value ?? "",
      cell: (document.getElementById("txtCell") as HTMLInputElement)?.value ?? "",
      fax: (document.getElementById("txtFax") as HTMLInputElement)?.value ?? "",
      website: (document.getElementById("txtWebsite") as HTMLInputElement)?.value ?? "",
      invEmail: (document.getElementById("txtInvEmail") as HTMLInputElement)?.value ?? "",
      notes: (document.getElementById("txtNotes") as HTMLTextAreaElement)?.value ?? "",
      instructions: (document.getElementById("txtInstructions") as HTMLTextAreaElement)?.value ?? "",
    }));

    // ─── Fill provided fields ─────────────────────────────────────────────
    const fieldMap: [keyof typeof args, string, "text" | "select" | "textarea"][] = [
      ["company", "#txtCompany", "text"],
      ["address1", "#txtAddress1", "text"],
      ["address2", "#txtAddress2", "text"],
      ["city", "#txtCity", "text"],
      ["state", "#txtState", "select"],
      ["zip", "#txtZip", "text"],
      ["first", "#txtFirst", "text"],
      ["last", "#txtLast", "text"],
      ["title", "#txtTitle", "text"],
      ["email", "#txtEmail", "text"],
      ["office", "#txtOffice", "text"],
      ["cell", "#txtCell", "text"],
      ["fax", "#txtFax", "text"],
      ["website", "#txtWebsite", "text"],
      ["invoice_email", "#txtInvEmail", "text"],
      ["notes", "#txtNotes", "textarea"],
      ["instructions", "#txtInstructions", "textarea"],
    ];

    const changed: string[] = [];
    for (const [key, selector, kind] of fieldMap) {
      const val = args[key];
      if (val === undefined || val === null) continue;
      if (kind === "select") {
        await page.selectOption(selector, String(val)).catch(() => {});
      } else {
        await page.fill(selector, String(val)).catch(() => {});
      }
      changed.push(`${key}=${val}`);
    }
    log.push(`${ms()} filled ${changed.length} field(s): ${changed.join(" | ")}`);

    if (changed.length === 0) {
      await page.evaluate(() => (window as any).CloseOperationWindow && (window as any).CloseOperationWindow());
      await browser.close();
      return ok(`⚠️ No fields to update were provided. Current values:\n${JSON.stringify(before, null, 2)}`);
    }

    // ─── Save ─────────────────────────────────────────────────────────────
    await page.evaluate((cid) => (window as any).SaveContact(parseInt(cid, 10)), customerId);
    await page.waitForTimeout(4000);
    log.push(`${ms()} SaveContact(${customerId}) fired`);

    // Re-open the contact to verify saved values
    await page.evaluate((cid) => (window as any).GetContactData(parseInt(cid, 10)), customerId);
    await page.waitForTimeout(2500);
    await page.evaluate((cid) => (window as any).EditContact(cid), customerId);
    await page.waitForTimeout(2500);
    await page.waitForSelector("#txtCompany", { timeout: 10000 });

    const after = await page.evaluate(() => ({
      company: (document.getElementById("txtCompany") as HTMLInputElement)?.value ?? "",
      address1: (document.getElementById("txtAddress1") as HTMLInputElement)?.value ?? "",
      address2: (document.getElementById("txtAddress2") as HTMLInputElement)?.value ?? "",
      city: (document.getElementById("txtCity") as HTMLInputElement)?.value ?? "",
      state: (document.getElementById("txtState") as HTMLSelectElement)?.value ?? "",
      zip: (document.getElementById("txtZip") as HTMLInputElement)?.value ?? "",
      first: (document.getElementById("txtFirst") as HTMLInputElement)?.value ?? "",
      last: (document.getElementById("txtLast") as HTMLInputElement)?.value ?? "",
      title: (document.getElementById("txtTitle") as HTMLInputElement)?.value ?? "",
      email: (document.getElementById("txtEmail") as HTMLInputElement)?.value ?? "",
      office: (document.getElementById("txtOffice") as HTMLInputElement)?.value ?? "",
      cell: (document.getElementById("txtCell") as HTMLInputElement)?.value ?? "",
      fax: (document.getElementById("txtFax") as HTMLInputElement)?.value ?? "",
      website: (document.getElementById("txtWebsite") as HTMLInputElement)?.value ?? "",
      invEmail: (document.getElementById("txtInvEmail") as HTMLInputElement)?.value ?? "",
      notes: (document.getElementById("txtNotes") as HTMLTextAreaElement)?.value ?? "",
      instructions: (document.getElementById("txtInstructions") as HTMLTextAreaElement)?.value ?? "",
    }));

    // Build diff for the fields we changed
    const diffLines: string[] = [];
    const verifyFailures: string[] = [];
    const argKeyToFieldKey: Record<string, keyof typeof after> = {
      company: "company",
      address1: "address1",
      address2: "address2",
      city: "city",
      state: "state",
      zip: "zip",
      first: "first",
      last: "last",
      title: "title",
      email: "email",
      office: "office",
      cell: "cell",
      fax: "fax",
      website: "website",
      invoice_email: "invEmail",
      notes: "notes",
      instructions: "instructions",
    };
    for (const [argKey, _sel, _kind] of fieldMap) {
      const provided = args[argKey];
      if (provided === undefined || provided === null) continue;
      const fk = argKeyToFieldKey[argKey as string];
      const beforeVal = (before as any)[fk] ?? "";
      const afterVal = (after as any)[fk] ?? "";
      diffLines.push(`  ${argKey}: "${beforeVal}" → "${afterVal}"`);
      if (String(afterVal).trim() !== String(provided).trim()) {
        verifyFailures.push(`${argKey} expected="${provided}" actual="${afterVal}"`);
      }
    }

    await page.evaluate(() => (window as any).CloseOperationWindow && (window as any).CloseOperationWindow());

    const header =
      verifyFailures.length === 0
        ? `✅ Customer updated and verified (NG ID ${customerId})`
        : `⚠️ Customer save returned but ${verifyFailures.length} field(s) did not persist as expected`;
    const summary =
      `${header}\n` +
      `Company: ${after.company || "(empty)"}\n` +
      `Resolved via: ${resolvedFromSearch ? "search" : "direct id"}\n\n` +
      `Changes:\n${diffLines.join("\n")}` +
      (verifyFailures.length > 0 ? `\n\nVerify failures:\n  ${verifyFailures.join("\n  ")}` : "");

    return ok(summary);
  } finally {
    await browser.close();
  }
}
