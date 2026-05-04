import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export type EmailKind =
  | "new_assignment"
  | "status_update"
  | "supplement_request"
  | "note_added"
  | "unknown";

export type SenderKind =
  | "filetrac_template"   // info@pcsadj.com, newclaim@usclaimsolutions.co
  | "xactware_xa"         // donotreply@xactware.com (XactAnalysis-driven)
  | "aan_portal"          // noreply@app.associatedadjusting.com
  | "straightline"        // claims@straightlineglobal.com (forwards)
  | "personal"            // human senders (crr2day@gmail.com)
  | "unknown";

export type Platform = "filetrac" | "xactanalysis" | "aan" | "manual";

export type ParsedAddress = {
  street?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
};

export type ParseAssignmentEmailResult =
  | {
      ok: true;
      sender_kind: SenderKind;
      email_kind: EmailKind;
      platform: Platform;
      // Platform identifier (FileTrac File #, XA Claim #) — caller passes
      // this to filetrac_get_claim or xact_get_assignment.
      claim_number?: string;
      // Carrier-side claim number — sometimes the same as claim_number,
      // sometimes a separate "Client Claim #" field on FileTrac emails.
      carrier_claim_number?: string;
      carrier?: string;
      insured_name?: string;
      insured_phone?: string;
      insured_alt_phone?: string;
      loss_address?: ParsedAddress;
      claimant_name?: string;
      date_of_loss?: string;
      date_received?: string;
      loss_type?: string;
      loss_description?: string;
      desk_adjuster?: { name?: string; email?: string; phone?: string };
      manual_fetch_required?: boolean;  // true for AAN; structured info lives behind a portal
      raw_subject: string;
      raw_from: string;
      notes?: string;
    }
  | { ok: false; error: string };

// ─── Helpers ───────────────────────────────────────────────────────────────────

function senderEmail(fromHeader: string): string {
  const m = (fromHeader || "").toLowerCase().match(/<([^>]+)>/);
  return (m ? m[1] : (fromHeader || "").toLowerCase()).trim();
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function fieldAfter(text: string, label: string): string | undefined {
  // Match "Label: value" with value ending at newline. Critical: do NOT use
  // `\s*` after the label — `\s` includes `\n` in JS regex, so an empty
  // field would consume its own newline and the capture would slurp the
  // NEXT line's content. Use `[ \t]*` (horizontal whitespace only).
  const labelEsc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${labelEsc}[ \\t]*([^\\n]*?)(?=\\n|$)`, "i");
  const m = text.match(re);
  if (!m) return undefined;
  const v = m[1].trim();
  return v.length ? v : undefined;
}

function dollarsToBlankIfEmpty(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const cleaned = s.trim();
  return cleaned.length ? cleaned : undefined;
}

// ─── Per-sender parsers ────────────────────────────────────────────────────────

/**
 * FileTrac-generated template (PCS Adjusting, US Claim Solutions, possibly
 * other firms). HTML body with `<b>Label:</b> value<br>` sections.
 *
 * Subject: "New Claim Assignment - File #<id>"
 * Body has labeled fields: Client Company, Client Name, File #, Client
 * Claim #, Insured info (First/Last Name, Phone, etc.), Loss Address,
 * Claimant info, Loss Information.
 */
function parseFileTracTemplate(args: {
  subject: string;
  body: string;
  from: string;
}): ParseAssignmentEmailResult {
  const text = stripHtml(args.body);

  const fileNumMatch = args.subject.match(/File\s*#\s*(\S+)/i);
  const claim_number = fieldAfter(text, "File #:") || fileNumMatch?.[1];

  // Insured info — first/last names are separate fields. If empty, fall back
  // to "Company:" (some commercial claims put the company name in the insured
  // slot). Scope the section to AFTER "Primary Insured" and BEFORE
  // "Loss Address:" — otherwise "Company:" matches the unrelated
  // "Client Company:" header in the claim-info block above, and "Phone #:"
  // would catch any other field with a similar prefix.
  const insuredHeaderIdx = text.search(/Primary Insured/i);
  const lossAddrIdx0 = text.indexOf("Loss Address:");
  const insuredSection = insuredHeaderIdx >= 0
    ? text.slice(insuredHeaderIdx, lossAddrIdx0 > 0 ? lossAddrIdx0 : undefined)
    : text;
  const insuredFirst = fieldAfter(insuredSection, "First Name:");
  const insuredLast = fieldAfter(insuredSection, "Last Name:");
  const insuredCompany = fieldAfter(insuredSection, "Company:");
  const insuredPhone = fieldAfter(insuredSection, "Phone #:");
  const insuredAltPhone = fieldAfter(insuredSection, "Alternate Phone #:");
  let insured_name = [insuredFirst, insuredLast].filter(Boolean).join(" ").trim();
  if (!insured_name && insuredCompany) insured_name = insuredCompany;

  // Loss address. The template puts loss-address fields AFTER a "Loss Address:"
  // header; before that sit the insured's mailing-address fields under the
  // same labels. Slice the text starting from "Loss Address:" to avoid the
  // mailing-address fields polluting our match.
  const lossAddrIdx = text.indexOf("Loss Address:");
  const claimantIdx = text.indexOf("Claimant Information");
  const lossAddrSection = lossAddrIdx >= 0
    ? text.slice(lossAddrIdx, claimantIdx > 0 ? claimantIdx : undefined)
    : "";

  const loss_address: ParsedAddress = lossAddrIdx >= 0
    ? {
        street: fieldAfter(lossAddrSection, "Street Address:"),
        street2: fieldAfter(lossAddrSection, "Address 2:"),
        city: fieldAfter(lossAddrSection, "City:"),
        state: fieldAfter(lossAddrSection, "State:"),
        zip: fieldAfter(lossAddrSection, "Zip:"),
      }
    : {};

  // Claimant info
  const claimantSection = claimantIdx >= 0
    ? text.slice(claimantIdx, text.indexOf("Loss Information") >= 0 ? text.indexOf("Loss Information") : undefined)
    : "";
  const claimantFirst = claimantSection ? fieldAfter(claimantSection, "First Name:") : undefined;
  const claimantLast = claimantSection ? fieldAfter(claimantSection, "Last Name:") : undefined;
  const claimant_name = [claimantFirst, claimantLast].filter(Boolean).join(" ").trim() || undefined;

  return {
    ok: true,
    sender_kind: "filetrac_template",
    email_kind: "new_assignment",
    platform: "filetrac",
    claim_number,
    carrier_claim_number: fieldAfter(text, "Client Claim #:"),
    carrier: fieldAfter(text, "Client Company:"),
    insured_name: insured_name || undefined,
    insured_phone: insuredPhone,
    insured_alt_phone: insuredAltPhone,
    loss_address: Object.values(loss_address).some(Boolean) ? loss_address : undefined,
    claimant_name,
    date_of_loss: fieldAfter(text, "Date of Loss:"),
    date_received: fieldAfter(text, "Date Received:"),
    loss_type: fieldAfter(text, "Type of Loss:"),
    loss_description: fieldAfter(text, "Loss Description:"),
    raw_subject: args.subject,
    raw_from: args.from,
  };
}

/**
 * XactAnalysis email forwarded by Xactware (donotreply@xactware.com).
 * Body is plain text with sentence-style fields.
 *
 * Subject: "New <Carrier> Claim # <id>"
 * Body: "Claim # - <id> Property Owner - <name> Date of Loss - <date>" plus
 * desk-adjuster contact info.
 */
function parseXactwareEmail(args: {
  subject: string;
  body: string;
  from: string;
}): ParseAssignmentEmailResult {
  const text = stripHtml(args.body).replace(/\s+/g, " ").trim();

  // Subject: "New Fortegra  Claim # 030665" — possibly multiple spaces.
  const subjMatch = args.subject.match(/^New\s+(.+?)\s+Claim\s*#\s*(\S+)/i);
  const carrier = subjMatch?.[1].trim();
  const claim_number = subjMatch?.[2] ?? text.match(/Claim\s*#\s*-\s*(\S+)/i)?.[1];

  const property_owner = text.match(/Property Owner\s*-\s*(.+?)(?=Date of Loss|$)/i)?.[1].trim();
  const date_of_loss = text.match(/Date of Loss\s*-\s*(.+?)(?=New|Field Adjuster|$)/i)?.[1].trim();

  // Desk adjuster: appears after the field-adjuster contact block. Pattern
  // varies per carrier; capture liberally.
  const deskMatch = text.match(/([A-Z][a-z]+ [A-Z][a-z]+(?: [A-Z][a-z]+)?)\s+(.+?)\s+Desk Adjuster\s+(\S+@\S+)\s+(?:Mainline:\s*([0-9 \-()]+)\s+)?(?:Direct:\s*([0-9 \-()]+))?/i);
  const desk_adjuster = deskMatch
    ? {
        name: deskMatch[1]?.trim(),
        email: deskMatch[3]?.trim(),
        phone: (deskMatch[5] || deskMatch[4])?.trim(),
      }
    : undefined;

  return {
    ok: true,
    sender_kind: "xactware_xa",
    email_kind: "new_assignment",
    platform: "xactanalysis",
    claim_number,
    carrier,
    insured_name: property_owner,
    date_of_loss,
    desk_adjuster,
    raw_subject: args.subject,
    raw_from: args.from,
    notes: "XactAnalysis emails do not include loss address; fetch via xact_get_assignment with claim_number.",
  };
}

/**
 * AAN portal — body is "log in for details", structured info lives behind
 * the dashboard. Caller must scrape the portal manually (Chrome MCP) or
 * defer to manual processing.
 */
function parseAanEmail(args: {
  subject: string;
  body: string;
  from: string;
}): ParseAssignmentEmailResult {
  // Subject sometimes carries a claim ID, sometimes not. AAN's "Claim Update"
  // emails (e.g. "AAN - Claim Update - 1096275") DO carry it.
  const numMatch = args.subject.match(/(\d{6,})/);
  const isUpdate = /Update/i.test(args.subject);
  return {
    ok: true,
    sender_kind: "aan_portal",
    email_kind: isUpdate ? "status_update" : "new_assignment",
    platform: "aan",
    claim_number: numMatch?.[1],
    manual_fetch_required: true,
    raw_subject: args.subject,
    raw_from: args.from,
    notes: "AAN emails are minimal — log in to https://app.associatedadjusting.com/dashboards/adjuster for full claim details.",
  };
}

/**
 * StraightLine Global forwards. These are NOT new assignments — they're
 * supplements, notes, or status updates on existing claims. Subject line
 * carries the claim number ("FW: <claim>" or similar).
 */
function parseStraightlineEmail(args: {
  subject: string;
  body: string;
  from: string;
}): ParseAssignmentEmailResult {
  // Subject: "FW: KWSKWS26030053" or "Re: An Assignment Note Has Been Added"
  const fwMatch = args.subject.match(/^(?:FW|Fwd):\s*(\S+)/i);
  const claim_number = fwMatch?.[1];

  let email_kind: EmailKind = "unknown";
  if (/supplement/i.test(args.body) || /supplement/i.test(args.subject)) {
    email_kind = "supplement_request";
  } else if (/note/i.test(args.subject)) {
    email_kind = "note_added";
  } else {
    email_kind = "status_update";
  }

  return {
    ok: true,
    sender_kind: "straightline",
    email_kind,
    platform: "xactanalysis",
    claim_number,
    raw_subject: args.subject,
    raw_from: args.from,
    notes: "StraightLine forwards typically reference an existing claim — fetch via xact_get_assignment.",
  };
}

/**
 * Personal sender (e.g. crr2day@gmail.com — Rollon Rhoane, individual
 * communication). Extract claim # from subject if present, otherwise mark
 * as unknown.
 */
function parsePersonalEmail(args: {
  subject: string;
  body: string;
  from: string;
}): ParseAssignmentEmailResult {
  // Subject patterns: "Cl# 25J13M991347 ...", "Re: Claim # X ...", etc.
  const m = args.subject.match(/(?:Cl(?:aim)?\s*#)\s*([A-Za-z0-9-]+)/i);
  return {
    ok: true,
    sender_kind: "personal",
    email_kind: "unknown",
    platform: "manual",
    claim_number: m?.[1],
    raw_subject: args.subject,
    raw_from: args.from,
    notes: "Personal email — no automated parsing beyond the claim # (if visible in subject).",
  };
}

// ─── Dispatcher ────────────────────────────────────────────────────────────────

export function parseAssignmentEmail(args: {
  from: string;
  subject: string;
  body: string;
}): ParseAssignmentEmailResult {
  if (!args.from || !args.subject) {
    return { ok: false, error: "from and subject are required" };
  }
  const sender = senderEmail(args.from);

  if (sender === "info@pcsadj.com" || sender.endsWith("@usclaimsolutions.co")) {
    return parseFileTracTemplate(args);
  }
  if (sender === "donotreply@xactware.com") {
    // Xactware also sends status-update emails ("Status Has Been Updated",
    // "Note Has Been Added", "Reviewed with Exceptions"). Distinguish on the
    // subject — anything starting with "New" is an assignment.
    if (/^New\s+.+\s+Claim\s*#/i.test(args.subject)) {
      return parseXactwareEmail(args);
    }
    return {
      ok: true,
      sender_kind: "xactware_xa",
      email_kind: /Status Has Been Updated/i.test(args.subject) ? "status_update"
        : /Note Has Been Added/i.test(args.subject) ? "note_added"
        : "unknown",
      platform: "xactanalysis",
      claim_number: args.subject.match(/Claim\s*#\s*(\S+)/i)?.[1],
      raw_subject: args.subject,
      raw_from: args.from,
      notes: "XA status update — fetch full state via xact_get_assignment.",
    };
  }
  if (sender === "noreply@app.associatedadjusting.com") {
    return parseAanEmail(args);
  }
  if (sender === "claims@straightlineglobal.com") {
    return parseStraightlineEmail(args);
  }
  if (sender === "crr2day@gmail.com") {
    return parsePersonalEmail(args);
  }

  // Generic fallback — best effort regex.
  return {
    ok: true,
    sender_kind: "unknown",
    email_kind: "unknown",
    platform: "manual",
    claim_number:
      args.subject.match(/(?:Claim\s*#|Cl#|File\s*#)\s*([A-Za-z0-9-]+)/i)?.[1] ??
      stripHtml(args.body).match(/(?:Claim\s*#|File\s*#)\s*([A-Za-z0-9-]+)/i)?.[1],
    raw_subject: args.subject,
    raw_from: args.from,
    notes: "Sender not in the known list — generic parsing used. Add a per-sender parser if this is recurrent.",
  };
}

export async function parseAssignmentEmailTool(args: {
  from: string;
  subject: string;
  body: string;
}): Promise<CallToolResult> {
  const result = parseAssignmentEmail(args);
  return ok(JSON.stringify(result, null, 2));
}
