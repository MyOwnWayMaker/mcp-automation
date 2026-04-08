import { getQuickBooksToken } from "../auth/quickbooks.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const QB_BASE = "https://quickbooks.api.intuit.com/v3/company";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

async function qbRequest(method: string, path: string, body?: unknown): Promise<any> {
  const { access_token, realm_id } = await getQuickBooksToken();
  const url = `${QB_BASE}/${realm_id}${path}?minorversion=65`;

  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${access_token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) throw new Error(`QuickBooks API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function qbQuery(query: string): Promise<any> {
  const { access_token, realm_id } = await getQuickBooksToken();
  const url = `${QB_BASE}/${realm_id}/query?query=${encodeURIComponent(query)}&minorversion=65`;

  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${access_token}`,
      "Accept": "application/json",
    },
  });

  if (!res.ok) throw new Error(`QuickBooks query error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Customers ────────────────────────────────────────────────────────────────

export async function qbFindCustomer(args: { name: string }): Promise<CallToolResult> {
  const res = await qbQuery(`SELECT * FROM Customer WHERE DisplayName LIKE '%${args.name}%' MAXRESULTS 10`);
  const customers = res.QueryResponse?.Customer ?? [];
  if (!customers.length) return ok(`No customer found matching: ${args.name}`);
  const lines = customers.map((c: any) =>
    `ID: ${c.Id}\nName: ${c.DisplayName}\nEmail: ${c.PrimaryEmailAddr?.Address ?? "N/A"}\nPhone: ${c.PrimaryPhone?.FreeFormNumber ?? "N/A"}\nBalance: $${c.Balance ?? 0}`
  );
  return ok(lines.join("\n\n---\n\n"));
}

export async function qbCreateCustomer(args: {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
}): Promise<CallToolResult> {
  const res = await qbRequest("POST", "/customer", {
    DisplayName: args.name,
    CompanyName: args.company,
    PrimaryEmailAddr: args.email ? { Address: args.email } : undefined,
    PrimaryPhone: args.phone ? { FreeFormNumber: args.phone } : undefined,
  });
  const c = res.Customer;
  return ok(`Customer created:\nID: ${c.Id}\nName: ${c.DisplayName}`);
}

export async function qbUpdateCustomer(args: {
  customer_id: string;
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
}): Promise<CallToolResult> {
  const existing = await qbRequest("GET", `/customer/${args.customer_id}`);
  const c = existing.Customer;
  const res = await qbRequest("POST", "/customer", {
    ...c,
    sparse: true,
    Id: args.customer_id,
    SyncToken: c.SyncToken,
    ...(args.name && { DisplayName: args.name }),
    ...(args.company && { CompanyName: args.company }),
    ...(args.email && { PrimaryEmailAddr: { Address: args.email } }),
    ...(args.phone && { PrimaryPhone: { FreeFormNumber: args.phone } }),
  });
  return ok(`Customer updated:\nID: ${res.Customer.Id}\nName: ${res.Customer.DisplayName}`);
}

// ─── Vendors ──────────────────────────────────────────────────────────────────

export async function qbFindVendor(args: { name: string }): Promise<CallToolResult> {
  const res = await qbQuery(`SELECT * FROM Vendor WHERE DisplayName LIKE '%${args.name}%' MAXRESULTS 10`);
  const vendors = res.QueryResponse?.Vendor ?? [];
  if (!vendors.length) return ok(`No vendor found matching: ${args.name}`);
  const lines = vendors.map((v: any) =>
    `ID: ${v.Id}\nName: ${v.DisplayName}\nEmail: ${v.PrimaryEmailAddr?.Address ?? "N/A"}\nBalance: $${v.Balance ?? 0}`
  );
  return ok(lines.join("\n\n---\n\n"));
}

export async function qbCreateVendor(args: {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
}): Promise<CallToolResult> {
  const res = await qbRequest("POST", "/vendor", {
    DisplayName: args.name,
    CompanyName: args.company,
    PrimaryEmailAddr: args.email ? { Address: args.email } : undefined,
    PrimaryPhone: args.phone ? { FreeFormNumber: args.phone } : undefined,
  });
  return ok(`Vendor created:\nID: ${res.Vendor.Id}\nName: ${res.Vendor.DisplayName}`);
}

// ─── Invoices ─────────────────────────────────────────────────────────────────

export async function qbFindInvoice(args: {
  customer_name?: string;
  invoice_number?: string;
  max_results?: number;
}): Promise<CallToolResult> {
  let query = `SELECT * FROM Invoice`;
  if (args.invoice_number) query += ` WHERE DocNumber = '${args.invoice_number}'`;
  query += ` MAXRESULTS ${args.max_results ?? 10}`;

  const res = await qbQuery(query);
  const invoices = res.QueryResponse?.Invoice ?? [];
  if (!invoices.length) return ok("No invoices found.");

  const lines = invoices.map((inv: any) =>
    `ID: ${inv.Id}\nInvoice #: ${inv.DocNumber}\nCustomer: ${inv.CustomerRef?.name}\nAmount: $${inv.TotalAmt}\nBalance: $${inv.Balance}\nStatus: ${inv.EmailStatus}\nDue: ${inv.DueDate ?? "N/A"}`
  );
  return ok(lines.join("\n\n---\n\n"));
}

export async function qbCreateInvoice(args: {
  customer_id: string;
  line_items: Array<{ description: string; amount: number; quantity?: number }>;
  due_date?: string;
  memo?: string;
}): Promise<CallToolResult> {
  const lines = args.line_items.map((item) => ({
    Amount: item.amount,
    DetailType: "SalesItemLineDetail",
    Description: item.description,
    SalesItemLineDetail: {
      Qty: item.quantity ?? 1,
      UnitPrice: item.amount / (item.quantity ?? 1),
    },
  }));

  const res = await qbRequest("POST", "/invoice", {
    CustomerRef: { value: args.customer_id },
    Line: lines,
    DueDate: args.due_date,
    CustomerMemo: args.memo ? { value: args.memo } : undefined,
  });

  const inv = res.Invoice;
  return ok(`Invoice created:\nID: ${inv.Id}\nInvoice #: ${inv.DocNumber}\nAmount: $${inv.TotalAmt}\nCustomer: ${inv.CustomerRef?.name}`);
}

export async function qbSendInvoice(args: { invoice_id: string; email: string }): Promise<CallToolResult> {
  const { access_token, realm_id } = await getQuickBooksToken();
  const url = `${QB_BASE}/${realm_id}/invoice/${args.invoice_id}/send?sendTo=${encodeURIComponent(args.email)}&minorversion=65`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${access_token}`, "Content-Type": "application/octet-stream" },
  });

  if (!res.ok) throw new Error(`Send invoice error: ${await res.text()}`);
  return ok(`Invoice ${args.invoice_id} sent to ${args.email}`);
}

export async function qbVoidInvoice(args: { invoice_id: string }): Promise<CallToolResult> {
  const existing = await qbRequest("GET", `/invoice/${args.invoice_id}`);
  const inv = existing.Invoice;
  await qbRequest("POST", `/invoice?operation=void`, {
    Id: args.invoice_id,
    SyncToken: inv.SyncToken,
  });
  return ok(`Invoice ${args.invoice_id} voided.`);
}

export async function qbUpdateInvoice(args: {
  invoice_id: string;
  due_date?: string;
  memo?: string;
}): Promise<CallToolResult> {
  const existing = await qbRequest("GET", `/invoice/${args.invoice_id}`);
  const inv = existing.Invoice;

  const res = await qbRequest("POST", "/invoice", {
    ...inv,
    sparse: true,
    Id: args.invoice_id,
    SyncToken: inv.SyncToken,
    ...(args.due_date && { DueDate: args.due_date }),
    ...(args.memo && { CustomerMemo: { value: args.memo } }),
  });
  return ok(`Invoice updated:\nID: ${res.Invoice.Id}\nAmount: $${res.Invoice.TotalAmt}`);
}

// ─── Expenses ─────────────────────────────────────────────────────────────────

export async function qbCreateExpense(args: {
  vendor_id?: string;
  amount: number;
  account_name?: string;
  memo?: string;
  payment_type?: "Cash" | "Check" | "CreditCard";
}): Promise<CallToolResult> {
  const res = await qbRequest("POST", "/purchase", {
    PaymentType: args.payment_type ?? "Cash",
    AccountRef: { name: args.account_name ?? "Cash and cash equivalents" },
    VendorRef: args.vendor_id ? { value: args.vendor_id } : undefined,
    PrivateNote: args.memo,
    Line: [{
      Amount: args.amount,
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: {
        AccountRef: { name: args.account_name ?? "Uncategorized Expense" },
      },
    }],
  });
  return ok(`Expense created:\nID: ${res.Purchase.Id}\nAmount: $${res.Purchase.TotalAmt}`);
}

export async function qbFindExpenses(args: { max_results?: number }): Promise<CallToolResult> {
  const res = await qbQuery(`SELECT * FROM Purchase MAXRESULTS ${args.max_results ?? 20}`);
  const purchases = res.QueryResponse?.Purchase ?? [];
  if (!purchases.length) return ok("No expenses found.");
  const lines = purchases.map((p: any) =>
    `ID: ${p.Id}\nDate: ${p.TxnDate}\nAmount: $${p.TotalAmt}\nType: ${p.PaymentType}\nMemo: ${p.PrivateNote ?? "N/A"}`
  );
  return ok(lines.join("\n\n---\n\n"));
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export async function qbCreatePayment(args: {
  customer_id: string;
  amount: number;
  invoice_id?: string;
  memo?: string;
}): Promise<CallToolResult> {
  const body: any = {
    CustomerRef: { value: args.customer_id },
    TotalAmt: args.amount,
    PrivateNote: args.memo,
  };

  if (args.invoice_id) {
    body.Line = [{
      Amount: args.amount,
      LinkedTxn: [{ TxnId: args.invoice_id, TxnType: "Invoice" }],
    }];
  }

  const res = await qbRequest("POST", "/payment", body);
  return ok(`Payment recorded:\nID: ${res.Payment.Id}\nAmount: $${res.Payment.TotalAmt}\nCustomer: ${res.Payment.CustomerRef?.name}`);
}

export async function qbFindPayments(args: { max_results?: number }): Promise<CallToolResult> {
  const res = await qbQuery(`SELECT * FROM Payment MAXRESULTS ${args.max_results ?? 20}`);
  const payments = res.QueryResponse?.Payment ?? [];
  if (!payments.length) return ok("No payments found.");
  const lines = payments.map((p: any) =>
    `ID: ${p.Id}\nDate: ${p.TxnDate}\nCustomer: ${p.CustomerRef?.name}\nAmount: $${p.TotalAmt}`
  );
  return ok(lines.join("\n\n---\n\n"));
}

// ─── Reports ──────────────────────────────────────────────────────────────────

async function qbReport(reportType: string, params: Record<string, string> = {}): Promise<any> {
  const { access_token, realm_id } = await getQuickBooksToken();
  const query = new URLSearchParams({ ...params, minorversion: "65" }).toString();
  const url = `${QB_BASE}/${realm_id}/reports/${reportType}?${query}`;

  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${access_token}`, "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`Report error: ${await res.text()}`);
  return res.json();
}

function formatReport(report: any): string {
  const title = report.Header?.ReportName ?? "Report";
  const dateRange = `${report.Header?.StartPeriod ?? ""} to ${report.Header?.EndPeriod ?? ""}`;
  const rows: string[] = [`${title} (${dateRange})\n`];

  function processRows(rowList: any[]) {
    for (const row of rowList ?? []) {
      if (row.type === "Section" && row.Header) {
        rows.push(`\n${row.Header.ColData?.[0]?.value ?? ""}`);
        processRows(row.Rows?.Row);
        if (row.Summary) {
          rows.push(`  Total: ${row.Summary.ColData?.[1]?.value ?? ""}`);
        }
      } else if (row.type === "Data") {
        const cols = row.ColData ?? [];
        rows.push(`  ${cols[0]?.value ?? ""}: ${cols[1]?.value ?? ""}`);
      }
    }
  }

  processRows(report.Rows?.Row);
  return rows.join("\n");
}

export async function qbProfitAndLoss(args: {
  start_date?: string;
  end_date?: string;
}): Promise<CallToolResult> {
  const report = await qbReport("ProfitAndLoss", {
    ...(args.start_date && { start_date: args.start_date }),
    ...(args.end_date && { end_date: args.end_date }),
  });
  return ok(formatReport(report));
}

export async function qbCashFlow(args: {
  start_date?: string;
  end_date?: string;
}): Promise<CallToolResult> {
  const report = await qbReport("CashFlow", {
    ...(args.start_date && { start_date: args.start_date }),
    ...(args.end_date && { end_date: args.end_date }),
  });
  return ok(formatReport(report));
}

export async function qbBalanceSheet(args: {
  as_of_date?: string;
}): Promise<CallToolResult> {
  const report = await qbReport("BalanceSheet", {
    ...(args.as_of_date && { date_macro: args.as_of_date }),
  });
  return ok(formatReport(report));
}
