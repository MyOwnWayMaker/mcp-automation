// orchestrator.mjs — claim-pipeline main loop.
//
// For each unprocessed Gmail message that looks claim-relevant:
//   1. Classify (parseAssignmentEmail, with our new Harbor parser).
//   2. Resolve the target Drive folder:
//      - new_assignment    → create a fresh claim folder.
//      - supplement_request → year-wide search for prior supplements →
//        ordinal-prefixed new folder. Recovers identity (insured, client,
//        carrier, loss_type) from the matched prior folder so we don't
//        have to re-parse from the supplement email.
//   3. Backfill: download attachments + render the thread to PDF, upload all
//      to the folder.
//   4. Mirror to Queststar `claims-business`: create row for new claims,
//      prepend a dated note for supplements.
//   5. Mark message processed (state file) + (later) ntfy.
//
// Reads compiled tool functions from /Users/dino/mcp-automation/dist/.
// Run via `node scripts/process-new-mail.mjs` (or with --dry-run).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClaimFolderOrdinal } from "./folder-resolver.mjs";
import { findClaimRowByKey, createClaimRow, appendClaimNote, rowFields as qsRowFields } from "./queststar.mjs";
import { proposeInspectionSms } from "./scheduler.mjs";

// ─── Lazy tool import (so the orchestrator file itself is import-safe) ────────

// Resolve dist/ relative to this file (works in worktrees and main checkout).
// Override with PIPELINE_DIST=<absolute-path>/dist for one-off testing.
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "../..");
const DIST = process.env.PIPELINE_DIST ?? path.join(REPO_ROOT, "dist");

let _tools;
async function tools() {
  if (_tools) return _tools;
  const [{ gmailFindEmail, gmailGetEmail, gmailDownloadAttachment },
         { parseAssignmentEmail },
         { driveFindFile, driveUploadFile },
         { createClaimDriveFolder },
         { gmailEmailToPdf },
         { filetracListClaims, filetracGetClaim, filetracListDocuments, filetracDownloadReport }] = await Promise.all([
    import(`${DIST}/tools/gmail.js`),
    import(`${DIST}/tools/assignment_email.js`),
    import(`${DIST}/tools/drive.js`),
    import(`${DIST}/tools/claim_drive_folder.js`),
    import(`${DIST}/tools/gmail_email_to_pdf.js`),
    import(`${DIST}/tools/filetrac.js`),
  ]);
  _tools = {
    gmailFindEmail, gmailGetEmail, gmailDownloadAttachment,
    parseAssignmentEmail,
    driveFindFile, driveUploadFile,
    createClaimDriveFolder,
    gmailEmailToPdf,
    filetracListClaims, filetracGetClaim, filetracListDocuments, filetracDownloadReport,
  };
  return _tools;
}

// Tool functions return CallToolResult = { content: [{ type: "text", text }] }.
// Extract the text payload.
function callText(r) {
  return r?.content?.find(c => c.type === "text")?.text ?? "";
}

// Some tool fns return a CallToolResult wrapper ({content:[{text}]}); others
// (e.g. createClaimDriveFolder, called directly off dist) return a plain result
// object. Normalize to the plain object so callers don't crash on JSON.parse of
// an empty string (the "Unexpected end of JSON input" trap that turned a real
// "ok:false" folder error into a misleading parse error).
function asResultObject(r) {
  if (r && typeof r === "object" && !Array.isArray(r) && !("content" in r)) return r;
  const t = callText(r);
  if (!t) return {};
  try { return JSON.parse(t); } catch { return { ok: false, error: `unparseable tool result: ${t.slice(0, 120)}` }; }
}

// driveFindFile output: blocks separated by `\n\n---\n\n`, each with
// "ID: ...\nName: ...\nType: ...\nModified: ...\nLink: ..."
function parseDriveSearchResults(text) {
  if (!text || /^No files found/.test(text)) return [];
  return text.split(/\n\n---\n\n/).map(block => {
    const id = block.match(/^ID:\s*(.+)$/m)?.[1].trim();
    const name = block.match(/^Name:\s*(.+)$/m)?.[1].trim();
    const type = block.match(/^Type:\s*(.+)$/m)?.[1].trim();
    const modified = block.match(/^Modified:\s*(.+)$/m)?.[1].trim();
    return { id, name, type, modified };
  }).filter(r => r.id && r.name);
}

// Adapter so folder-resolver.mjs receives a plain async (q, limit) → rows.
function makeDriveFinder() {
  return async (query, max_results = 50) => {
    const t = await tools();
    const r = await t.driveFindFile({ query, max_results });
    return parseDriveSearchResults(callText(r));
  };
}

// ─── State (processed message IDs) ──────────────────────────────────────────

const STATE_PATH = process.env.PIPELINE_STATE_PATH ?? "/Users/dino/mcp-automation/data/pipeline_state.json";

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { processed: {} };
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return { processed: {} }; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Short-code mappers (free-text → standard folder code) ──────────────────

const CLIENT_BY_SENDER = {
  filetrac_template_pcsadj: "PCAS",
  filetrac_template_uscs:   "USCS",
  ianet:                    "IANet",
  harbor_claims:            "SLG",
  straightline:             "SLG",
};

export function deriveClientShort(parsed, msg) {
  // Accept either a msg object (preferred) or a bare from-address string.
  const fromAddr = typeof msg === "string" ? msg : (msg?.from ?? "");
  const body = typeof msg === "object" ? (msg?.body ?? "") : "";
  // XactWare-routed assignments arrive From donotreply@xactware.com, but the
  // real IA firm shows up as the reply-to in the body ("Please email any
  // replies to: <name>@straightlineglobal.com"), so scan From + body.
  const hay = `${fromAddr} ${body}`.toLowerCase();
  if (parsed.sender_kind === "filetrac_template") {
    if (hay.includes("pcsadj.com")) return "PCAS";
    if (hay.includes("usclaimsolutions")) return "USCS";
  }
  const byKind = CLIENT_BY_SENDER[parsed.sender_kind];
  if (byKind) return byKind;
  // Body-based IA-firm detection (covers XactWare-routed SLG/Fortegra, etc.).
  const isPCAS = hay.includes("pcsadj.com") || hay.includes("pcsadjusting");
  if (hay.includes("associatedadjusting") || /\baan\b/.test(hay)) return isPCAS ? "AAN/PCAS" : "AAN";
  if (hay.includes("straightlineglobal") || hay.includes("harborclaims")) return "SLG";
  if (hay.includes("usclaimsolutions")) return "USCS";
  if (hay.includes("ianetwork")) return "IANet";
  if (isPCAS) return "PCAS";
  return null;
}

const CARRIER_LOOKUP = [
  [/db\s*insurance/i, "DBI"],
  [/fortegra/i, "Fortegra"],
  [/nars/i, "NARS"],
  [/harbor/i, "Harbor"],
  [/geico/i, "Geico"],
  [/aspen/i, "Aspen"],
  [/esis/i, "ESIS"],
  [/stewardship/i, "Stewardship"],
  [/accelerated/i, "Accelerated"],
  [/premier/i, "Premier"],
  [/cabrillo|cabgen/i, "Cabrillo"],
  [/first\s*cap/i, "FirstCap"],
  [/sea\s*view/i, "SeaView"],
];

// Generic short-code from a free-text carrier name, for carriers not in the
// lookup table — so an unknown carrier (e.g. one backfilled from FileTrac)
// never blocks filing. Strips corporate suffixes, PascalCase-joins up to two
// remaining significant words. The orchestrator flags any carrier resolved
// this way in its summary so Hakiel can correct the short code.
const CARRIER_STOPWORDS = /^(insurance|company|companies|ins|co|corp|group|grp|mutual|the|of|and|llc|inc|lp|llp|services|adjusting|claims)$/i;
export function genericCarrierShort(text) {
  const words = String(text ?? "")
    .replace(/[^A-Za-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(w => w && !CARRIER_STOPWORDS.test(w));
  if (!words.length) return null;
  return words.slice(0, 2)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("")
    .slice(0, 20);
}

function deriveCarrierShort(parsed) {
  const text = parsed.carrier ?? "";
  for (const [re, code] of CARRIER_LOOKUP) if (re.test(text)) return code;
  return genericCarrierShort(text);
}

// Closed peril vocabulary (Title Case) — Hakiel's standard set
// {Water, Fire, Wind, Vehicle Collision, GL, VMM}. Order matters: the most
// specific perils win before the generic "Water" catch. Weight/wight-of-snow
// maps to Wind (Hakiel's Sean Thomas call; cause is kept as a parenthetical
// elsewhere). Anything that doesn't map cleanly returns "UNKNOWN" so the caller
// flags it for Hakiel rather than guessing.
const PERIL_RULES = [
  [/vandal|malicious\s*mischief|\bvmm\b/i, "VMM"],
  [/vehicle|collision|car\s*accident|auto\s*accident/i, "Vehicle Collision"],
  [/general\s*liab|bodily\s*injur|premises\s*liab|slip\b|trip\s*and\s*fall|\bgl\b/i, "GL"],
  [/fire|smoke|soot/i, "Fire"],
  [/wind|windstorm|gust|tornado|hurricane|wight\s*of\s*snow|weight\s*of\s*snow/i, "Wind"],
  [/water|discharge|leak|plumb|steam|moisture|pipe|slab|sewage|sewer|flood|overflow|saturat/i, "Water"],
];

export function normalizeLossType(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "UNKNOWN";
  for (const [re, code] of PERIL_RULES) if (re.test(s)) return code;
  return "UNKNOWN";
}

// Uniqueness parenthetical (Hakiel 2026-07-03): folder titles carry whatever
// makes the claim unique — "Water (Sewer Backup)", "Wind (Weight of Snow)".
// Derived from the free-text loss description only when a keyword clearly
// matches; returns null (no parenthetical) otherwise — never guess. Order
// matters: specific causes before generic pipe/leak catches.
const CAUSE_RULES = [
  [/sewer|sewage|clogged\s+(?:drain|main)/i, "Sewer Backup"],
  [/slab\s*leak|under\s*(?:the\s*)?slab/i, "Slab Leak"],
  [/water\s*heater/i, "Water Heater Leak"],
  [/roof\s*leak|leak\w*\s+(?:from|in)\s+(?:the\s+)?roof/i, "Roof Leak"],
  [/(?:unit|apartment|apt\.?)\s*(?:#?\d+\s*)?(?:above|upstairs)|from\s+(?:the\s+)?unit\s+above|came\s+down\s+the\s+ceiling/i, "Water From Unit Above"],
  [/w[ei]{1,2}ght\s*of\s*snow/i, "Weight of Snow"],
  [/tree\s+(?:fell|down|downed|came|on\s)/i, "Tree on Structure"],
  [/pipe\s*(?:burst|break|broke)|burst\s*pipe/i, "Pipe Burst"],
  [/pipe\s*leak|supply\s*line/i, "Pipe Leak"],
  [/carport/i, "Carport Damage"],
  [/hail/i, "Hail"],
  [/mold/i, "Mold"],
];
export function deriveCauseParenthetical(lossDescription) {
  const s = String(lossDescription ?? "");
  if (!s) return null;
  for (const [re, label] of CAUSE_RULES) if (re.test(s)) return label;
  return null;
}

export function deriveLossType(parsed, msg) {
  // The structured loss_type field ALONE decides first — never mixed with the
  // free-text description, whose incidental words outrank it in PERIL_RULES
  // order ("water came down the ... smoke detection" labeled Tracey's water
  // claim Fire on 2026-06-29). Description, then subject + attachment
  // filenames (XA "Benchmark_Wind_*" etc.), are fallbacks only.
  const fromField = normalizeLossType(parsed.loss_type);
  if (fromField !== "UNKNOWN") return fromField;
  const fromDescription = normalizeLossType(parsed.loss_description);
  if (fromDescription !== "UNKNOWN") return fromDescription;
  const fallbackHay = [msg?.subject, ...((msg?.attachments ?? []).map(a => a.filename))].filter(Boolean).join(" ");
  const fb = normalizeLossType(fallbackHay);
  return fb === "UNKNOWN" ? null : fb;
}

// Normalize insured_name to title case + drop a leading "THE " when the
// email split it weirdly. PCAS emails arrive as
//   First="THE CHERYL PALLER LIVING" Last="TRUST"  → "Cheryl Paller Living Trust"
// Normalize whatever date string the parser hands us to YYYY-MM-DD.
//   "2026-05-29"          → "2026-05-29"
//   "2026-05-29T19:15:02Z" → "2026-05-29"
//   "5/29/2026"           → "2026-05-29"
//   "5/29/26"             → "2026-05-29"
//   anything unparseable  → null
export function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already ISO (with or without trailing time)
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // US M/D/YYYY (also accepts 2-digit year)
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (us) {
    const yy = us[3].length === 2 ? `20${us[3]}` : us[3];
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }
  return null;
}

function deriveInsuredName(parsed) {
  let raw = parsed.insured_name ?? "";
  if (!raw) return null;
  // Tighten spacing
  raw = raw.replace(/\s+/g, " ").trim();
  // Title case
  raw = raw.toLowerCase().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  // Drop a leading "The " for FOLDER naming (Hakiel's convention)
  raw = raw.replace(/^The\s+/i, "");
  return raw;
}

// ─── FileTrac doc-library backfill (for FT-template senders) ────────────────
//
// PCAS/USCS new-assignment emails are FileTrac auto-notifications: claim data
// inline in HTML, NO PDF attachments. The carrier-side "Adjuster Assignment
// Worksheet", signed PIA forms, etc. live in the FileTrac doc library.
// This pulls them down into the Drive folder.
//
// Idempotent: lists current folder contents first and skips any doc whose
// target filename is already there.

// Map short client code → FileTrac company_index (per filetrac_list_companies)
const CLIENT_TO_FT_COMPANY = {
  Accelerated: 0,
  PCAS: 1,           // Premier Claims and Adjusting Services
  Premier: 1,
  Stewardship: 2,
  USCS: 3,
};

// Parse filetrac_list_documents text → array of doc metadata blocks.
// Each block format:
//   1. [report_id=20170966] 3707515_20260529115202179.pdf
//      Type: PDF | Date: 5/29/2026 | Size: 1894KB | Cloud: false
//      Desc: Adjuster Assignment Worksheet
//      URL: https://...
export function parseFiletracDocList(text) {
  if (!text || /No documents found|not found/i.test(text)) return [];
  const out = [];
  const blocks = text.split(/\n\s*\n/);
  for (const b of blocks) {
    const head = b.match(/^\s*\d+\.\s+\[report_id=(\d+)\]\s+(.+?)\s*$/m);
    if (!head) continue;
    const meta = b.match(/Type:\s*(\S+)\s*\|\s*Date:\s*(\S+)\s*\|\s*Size:\s*([\d.]+)\s*KB\s*\|\s*Cloud:\s*(true|false)/i);
    const desc = b.match(/^\s*Desc:\s*(.+?)\s*$/m)?.[1];
    out.push({
      report_id: head[1],
      filename: head[2],
      file_type: meta?.[1],
      date: meta?.[2],
      size_kb: meta ? parseFloat(meta[3]) : null,
      on_cloud: meta?.[4] === "true",
      description: desc,
    });
  }
  return out;
}

// Extract FileTrac numeric claim_id from filetrac_list_claims text, matching
// on the email-extracted file # (which the FT-template parser puts in
// parsed.claim_number — confusing field naming inherited from the parser).
export function extractClaimIdByFileNumber(listText, fileNumber) {
  if (!fileNumber) return null;
  const fn = String(fileNumber);
  const re = new RegExp(`File #:\\s*${fn.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\|\\s*Claim ID:\\s*(\\d+)`, "i");
  return listText.match(re)?.[1] ?? null;
}

// Find a FileTrac Claim ID by matching a free-text token (client claim #, file
// #, or insured surname) anywhere in that claim's row. filetrac_list_claims
// renders one claim per block separated by lines of dashes; we locate the block
// that contains the token (case-insensitive, whole-token) and read its Claim ID.
export function extractClaimIdByToken(listText, token) {
  if (!listText || !token) return null;
  const tok = String(token).trim();
  if (tok.length < 3) return null;
  const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokRe = new RegExp(`(?:^|[^A-Za-z0-9])${esc}(?:$|[^A-Za-z0-9])`, "i");
  for (const block of listText.split(/\n-{2,}\n|\n---\n/)) {
    if (tokRe.test(block)) {
      const id = block.match(/Claim ID:\s*(\d+)/i)?.[1];
      if (id) return id;
    }
  }
  return null;
}

// Pull a client claim # out of an assignment subject line. PCAS forwards put it
// there even when the body is empty: "FW: First Cap SeaView Claim # SV-0000270 …"
export function extractClientClaimFromSubject(subject) {
  if (!subject) return null;
  // Claim numbers always contain a digit — require one so we don't latch onto
  // the next ordinary word ("...claim here" must NOT match).
  const m = String(subject).match(/claim\s*(?:#|no\.?|number)?\s*:?\s*([A-Za-z0-9-]*\d[A-Za-z0-9-]{2,})/i);
  return m?.[1] ?? null;
}

// Candidate insured-name tokens from a subject (fallback FT match key when no
// claim # is present). Capitalized alphabetic words ≥3 chars, minus routing
// noise and the carrier-ish words that also appear in subjects.
const SUBJECT_NAME_STOP = /^(claim|first|cap|capital|seaview|policy|loss|the|new|assignment|fwd?|re|wind|water|fire|damage|insured)$/i;
export function subjectNameTokens(subject) {
  if (!subject) return [];
  return (String(subject).match(/[A-Z][a-zA-Z]{2,}/g) ?? [])
    .filter(w => !SUBJECT_NAME_STOP.test(w));
}

// Parse the filetrac_get_claim detail text into the identity fields we need.
// The detail renders each field as "Label:\n<value>"; labels repeat (top
// summary + the structured sections), so we take the first occurrence for
// scalar fields and a section-scoped scan for the loss address.
export function parseFiletracClaimDetail(text) {
  if (!text) return {};
  const first = (label) => {
    const re = new RegExp(`(?:^|\\n)\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n\\s*([^\\n]+?)\\s*$`, "im");
    const v = text.match(re)?.[1]?.trim();
    return v && !/:$/.test(v) ? v : null;  // guard against catching the next label
  };
  // Loss address: scan the "Loss Location" section for the first Street/City/ZIP.
  let loss_address = null;
  const lossIdx = text.search(/Loss Location/i);
  if (lossIdx >= 0) {
    const seg = text.slice(lossIdx, lossIdx + 600);
    const grab = (label) => {
      const re = new RegExp(`${label}\\s*\\n\\s*([^\\n]+?)\\s*$`, "im");
      const v = seg.match(re)?.[1]?.trim();
      return v && !/:$/.test(v) ? v : null;
    };
    const street = grab("Street Address:");
    const city = grab("City:");
    const zip = grab("ZIP:");
    if (street || city || zip) loss_address = { street, city, zip };
  }
  return {
    insured: first("Insured:"),
    carrier: first("Client:"),
    claim_number_client: first("Claim #:"),
    file_number: first("File #:"),
    loss_type: first("Type of Loss:"),
    loss_description: first("Loss Description:"),
    date_of_loss: first("Date of Loss:"),
    date_received: first("Date Received:"),
    policy: first("Policy #:"),
    insured_phone: first("Phone #:"),
    insured_alt_phone: first("Alternate Phone #:"),
    loss_address,
  };
}

// FileTrac identity backfill: PCAS/USCS assignments are often forwarded as
// free-text ("Please see attached wind claim") with the real fields living only
// in FileTrac (+ the attached worksheet). When the email parse is missing
// identity fields, look the claim up in FileTrac and fill the blanks in `parsed`
// in place. Never overwrites a value the email already provided.
async function backfillIdentityFromFiletrac({ parsed, msg, client_short }) {
  const t = await tools();
  if (parsed.sender_kind !== "filetrac_template") return { skipped: "not-ft-template" };
  const company_index = CLIENT_TO_FT_COMPANY[client_short];
  if (company_index === undefined) return { skipped: `unknown-ft-company:${client_short}` };

  const subject = msg?.subject ?? "";
  const clientClaim = parsed.carrier_claim_number
    ?? parsed.claim_number
    ?? extractClientClaimFromSubject(subject);

  // FileTrac calls throw on a missing/expired session; degrade to a clean skip
  // so one FT outage holds the claim for retry instead of crashing the batch.
  let listText;
  try {
    listText = callText(await t.filetracListClaims({ company_index, max_results: 50, include_closed: false }));
  } catch (e) {
    return { error: "ft-session-expired", detail: String(e?.message ?? e).slice(0, 160) };
  }
  if (/session.*(expired|not available|invalid|not found)/i.test(listText)) {
    return { error: "ft-session-expired", detail: listText.slice(0, 160) };
  }

  let claim_id = clientClaim ? extractClaimIdByToken(listText, clientClaim) : null;
  if (!claim_id) {
    for (const tok of subjectNameTokens(subject)) {
      claim_id = extractClaimIdByToken(listText, tok);
      if (claim_id) break;
    }
  }
  if (!claim_id) return { skipped: "ft-claim-not-found", detail: { clientClaim, subject } };

  let d;
  try {
    d = parseFiletracClaimDetail(callText(await t.filetracGetClaim({ claim_id, company_index })));
  } catch (e) {
    return { error: "ft-detail-failed", claim_id, detail: String(e?.message ?? e).slice(0, 160) };
  }
  if (!d.insured && !d.carrier && !d.loss_type) {
    return { skipped: "ft-detail-empty", claim_id };
  }

  // Fill blanks only — a real parse always wins.
  if (!parsed.insured_name && d.insured) parsed.insured_name = d.insured;
  if (!parsed.insured_phone && d.insured_phone) parsed.insured_phone = d.insured_phone;
  if (!parsed.insured_alt_phone && d.insured_alt_phone) parsed.insured_alt_phone = d.insured_alt_phone;
  if (!parsed.carrier && d.carrier) parsed.carrier = d.carrier;
  if (!parsed.loss_type && d.loss_type) parsed.loss_type = d.loss_type;
  if (!parsed.loss_description && d.loss_description) parsed.loss_description = d.loss_description;
  if (!parsed.date_of_loss && d.date_of_loss) parsed.date_of_loss = d.date_of_loss;
  if (!parsed.date_received && d.date_received) parsed.date_received = d.date_received;
  if (!parsed.policy_number && d.policy) parsed.policy_number = d.policy;
  if (!parsed.loss_address && d.loss_address) parsed.loss_address = d.loss_address;
  // FT-template convention: claim_number holds the FT File # (used by the doc
  // backfill to re-find the claim); the client claim # rides carrier_claim_number.
  if (!parsed.claim_number && d.file_number) parsed.claim_number = d.file_number;
  if (!parsed.carrier_claim_number && d.claim_number_client) parsed.carrier_claim_number = d.claim_number_client;

  return { claim_id, file_number: d.file_number, filled: d };
}

// Build a clean Drive filename from FT doc metadata + claim context.
//   Desc present → "{Desc} - {Insured}.{ext}"
//   else         → "{date} {original filename}"  (preserves uniqueness)
export function niceDocName(d, insured) {
  const ext = (d.file_type || d.filename.split(".").pop() || "bin").toLowerCase();
  if (d.description) {
    // Strip an extension that's already in the description (e.g.
    // "1097519 signed pia form.jpg" → "1097519 signed pia form").
    const base = d.description.replace(/\.[a-z0-9]{2,5}$/i, "").trim();
    return `${titleCase(base)} - ${insured}.${ext}`;
  }
  return `${d.date?.replace(/\//g, "-") ?? "FT"} ${d.filename}`;
}

export function titleCase(s) {
  return s.split(/\s+/).map(w =>
    w.length <= 3 && /^[a-z]+$/.test(w) ? w.toUpperCase()
    : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).join(" ");
}

// Heuristic: skip a doc only if it looks like a sender-side signature artifact
// (tiny inline image with name like image001.png). Anything actually uploaded
// by the carrier to FT — even small — we keep.
export function shouldSkipFtDoc(d) {
  if (!d.filename) return true;
  if (/^image\d{3,}\.(jpg|jpeg|png|gif)$/i.test(d.filename) && (d.size_kb ?? 0) < 30) return true;
  return false;
}

async function backfillFiletracDocs({ msg, parsed, folderId, client_short, insured }) {
  const t = await tools();
  if (parsed.sender_kind !== "filetrac_template") {
    return { skipped: "not-ft-template" };
  }
  const company_index = CLIENT_TO_FT_COMPANY[client_short];
  if (company_index === undefined) {
    return { skipped: `unknown-ft-company:${client_short}` };
  }
  const file_number = parsed.claim_number;  // FT-template parser puts File # here
  if (!file_number) {
    return { skipped: "no-file-number" };
  }

  // Find FileTrac claim_id by file_number. Try OPEN claims first — the reliable
  // path; include_closed:true intermittently throws "Execution context
  // destroyed" in the headless FT browser. Widen to closed only if not found.
  // Never throw: a FT hiccup must not undo a claim that's already been filed.
  let listText = "";
  try {
    listText = callText(await t.filetracListClaims({ company_index, max_results: 50, include_closed: false }));
    if (!extractClaimIdByFileNumber(listText, file_number)) {
      const closed = callText(await t.filetracListClaims({ company_index, max_results: 50, include_closed: true }));
      if (extractClaimIdByFileNumber(closed, file_number)) listText = closed;
    }
  } catch (e) {
    return { error: "ft-docs-list-failed", detail: String(e?.message ?? e).slice(0, 160) };
  }
  if (/session.*(expired|not available|invalid|not found)/i.test(listText)) {
    return { error: "ft-session-expired", detail: listText.slice(0, 200) };
  }
  const claim_id = extractClaimIdByFileNumber(listText, file_number);
  if (!claim_id) {
    return { skipped: "ft-claim-not-on-active-list", detail: { file_number, company_index } };
  }

  // List docs in FT (don't let a transient FT browser error block filing)
  let docs;
  try {
    docs = parseFiletracDocList(callText(await t.filetracListDocuments({ claim_id, company_index })));
  } catch (e) {
    return { error: "ft-docs-list-failed", claim_id, detail: String(e?.message ?? e).slice(0, 160) };
  }
  if (!docs.length) {
    return { uploaded: [], detail: "no-docs-in-ft-library", claim_id };
  }

  // Dedup against current folder contents — make this safe to re-run.
  const folderRes = await t.driveFindFile({
    query: `'${folderId}' in parents and trashed = false`,
    max_results: 100,
  });
  const existing = new Set(parseDriveSearchResults(callText(folderRes)).map(f => f.name));

  const uploaded = [];
  const skipped = [];
  for (const d of docs) {
    if (shouldSkipFtDoc(d)) { skipped.push({ filename: d.filename, reason: "sig-artifact" }); continue; }
    const targetName = niceDocName(d, insured);
    if (existing.has(targetName)) { skipped.push({ filename: targetName, reason: "already-in-folder" }); continue; }
    const safe = targetName.replace(/[^A-Za-z0-9._-]+/g, "_");
    const dest = `/tmp/pipeline_ft_${claim_id}_${d.report_id}_${safe}`;
    try {
      await t.filetracDownloadReport({ report_id: d.report_id, company_index, claim_id, dest_path: dest });
      await t.driveUploadFile({
        local_path: dest,
        name: targetName,
        folder_id: folderId,
      });
      uploaded.push({ report_id: d.report_id, name: targetName });
    } catch (e) {
      skipped.push({ filename: targetName, reason: `download-or-upload-failed: ${e?.message ?? e}` });
    }
  }
  return { claim_id, file_number, uploaded, skipped };
}

// ─── Folder identity recovery from a prior folder (for supplements) ─────────

// Extract insured name from a Queststar row's `task` field. Convention:
//   "{insured} ({client} {claim_number} [/ {carrier}]) — {label}"
// Returns the leading insured portion, or null if shape doesn't match.
export function insuredFromQueststarTask(task) {
  if (!task) return null;
  const m = String(task).match(/^([^()]+?)\s*\(/);
  return m?.[1].trim() ?? null;
}

// Parse `YYYY-MM-DD_[(ord Work-Type) ]Insured_Client_Carrier_LossType`
// → { insured, client, carrier, loss_type }
export function parseClaimFolderName(name) {
  const m = name.match(
    /^(\d{4}-\d{2}-\d{2})_(?:\((?:\d+(?:st|nd|rd|th)?\s+)?(?:Supplement|Reinspection|Reopen)\)\s+)?(.+?)_([^_]+)_([^_]+)_(.+)$/i,
  );
  if (!m) return null;
  return { date: m[1], insured: m[2], client: m[3], carrier: m[4], loss_type: m[5] };
}

// ─── The two action paths ──────────────────────────────────────────────────

async function processNewAssignment({ msg, parsed, todayDate, dryRun }) {
  const t = await tools();
  let insured = deriveInsuredName(parsed);
  let client_short = deriveClientShort(parsed, msg);
  let carrier_short = deriveCarrierShort(parsed);
  let loss_type = deriveLossType(parsed, msg);

  // FileTrac identity backfill: PCAS/USCS forwards often arrive as free-text
  // with the real data only in FileTrac. When the email parse is missing
  // identity fields, pull them from the FT claim record, then re-derive.
  let ft_identity = null;
  if ((!insured || !carrier_short || !loss_type)
      && parsed.sender_kind === "filetrac_template" && client_short) {
    ft_identity = await backfillIdentityFromFiletrac({ parsed, msg, client_short });
    if (ft_identity?.error) {
      // FileTrac unreachable/expired — hold the claim for the next cron retry
      // rather than misfiling with half the fields.
      return { skipped: "ft-backfill-error", detail: ft_identity };
    }
    insured = deriveInsuredName(parsed);
    client_short = deriveClientShort(parsed, msg);
    carrier_short = deriveCarrierShort(parsed);
    loss_type = deriveLossType(parsed, msg);
  }

  if (!insured || !client_short || !carrier_short || !loss_type) {
    return {
      skipped: "incomplete-fields-for-new-assignment",
      detail: { insured, client_short, carrier_short, loss_type, ft_identity: ft_identity ?? "not-attempted" },
    };
  }

  // Surface a carrier short-code that fell back to the generic deriver (not in
  // CARRIER_LOOKUP) so Hakiel can correct it from the run summary.
  const carrier_short_flagged = parsed.carrier
    && !CARRIER_LOOKUP.some(([re]) => re.test(parsed.carrier))
    ? carrier_short : null;

  const request_date = normalizeDate(parsed.date_received) ?? normalizeDate(todayDate) ?? todayDate.slice(0, 10);
  // Folder title carries the uniqueness parenthetical when the description
  // yields one — "Water (Sewer Backup)". The bare peril still flows everywhere
  // else (Queststar, scheduler).
  const cause = deriveCauseParenthetical(parsed.loss_description);
  const loss_type_labeled = cause && !String(loss_type).includes("(")
    ? `${loss_type} (${cause})` : loss_type;
  const args = {
    request_date,
    insured_name: insured,
    client_short,
    carrier_short,
    loss_type: loss_type_labeled,
  };
  if (dryRun) {
    // Preview the scheduling proposal too (read-only: geocode + calendar +
    // FT list; no outbox write, no ntfy). Soft-fail like the live path.
    let scheduling = null;
    try {
      scheduling = await proposeInspectionSms({
        msg, parsed, folderResult: null, insured, client_short, loss_type,
        company_index: CLIENT_TO_FT_COMPANY[client_short] ?? null,
        ft_internal_claim_id: ft_identity?.claim_id ?? null,
        request_date,
        dryRun: true,
      });
    } catch (e) {
      scheduling = { skipped: "scheduler-error", detail: String(e?.message ?? e).slice(0, 160) };
    }
    return { action: "new_assignment", dry_run: args, scheduling };
  }

  const fr = await t.createClaimDriveFolder(args);
  const folderResult = asResultObject(fr);
  if (!folderResult.ok) {
    return { skipped: "folder-create-failed", detail: folderResult.error };
  }

  // Backfill: render assignment email to PDF + drop in folder.
  await t.gmailEmailToPdf({
    message_id: msg.id,
    drive_folder_id: folderResult.claim_folder.id,
    filename: `${request_date} Assignment - ${insured}.pdf`,
  });

  // Backfill: pull any FT-doc-library items for FT-template senders
  // (PCAS/USCS). Worksheet, PIA forms, etc. don't ride on the email.
  const ftBackfill = await backfillFiletracDocs({
    msg,
    parsed,
    folderId: folderResult.claim_folder.id,
    client_short,
    insured,
  });

  // Mirror to Queststar (find-or-create).
  const ia_firm = client_short === "PCAS" ? "PCAS"
                : client_short === "USCS" ? "USCS"
                : client_short === "IANet" ? "IANet"
                : client_short === "SLG" ? "SLG"
                : null;
  const titleLine = `${insured} (${client_short} ${parsed.claim_number ?? parsed.carrier_claim_number ?? "?"})`;
  const existing = await findClaimRowByKey({
    claim_number: parsed.claim_number,
    carrier_claim_number: parsed.carrier_claim_number,
    insured_name: insured,
  });
  let row;
  if (existing) {
    row = await appendClaimNote(existing,
      `New-assignment email re-ingested (${msg.id}). Folder: ${folderResult.claim_folder.name}`);
  } else {
    const fields = {
      task: titleLine,
      section: "Claims",
      ...(ia_firm ? { ia_firm } : {}),
      carrier: parsed.carrier ?? carrier_short,
      assignment_received: request_date,
      status: "Pending Inspection",
      domain: "My Claims",
      notes:
        `Insured: ${insured}\n` +
        `Loss address: ${formatAddress(parsed.loss_address)}\n` +
        `Claim #: ${parsed.claim_number ?? "?"} | Carrier claim #: ${parsed.carrier_claim_number ?? "?"}\n` +
        `Loss type: ${parsed.loss_type ?? loss_type} (DOL ${parsed.date_of_loss ?? "?"})\n` +
        `Drive folder: ${folderResult.claim_folder.link ?? folderResult.path}\n` +
        `Pipeline-created from Gmail ${msg.id}.`,
    };
    row = await createClaimRow(fields);
  }

  // Scheduling-assistant proposer: slot pick + SMS draft parked behind the
  // approval gate (ntfy topic). Soft-fail — a scheduling gap must never
  // un-file the claim; the gap itself is ntfy'd for manual scheduling.
  let scheduling = null;
  try {
    scheduling = await proposeInspectionSms({
      msg, parsed, folderResult, insured, client_short, loss_type,
      company_index: CLIENT_TO_FT_COMPANY[client_short] ?? null,
      ft_internal_claim_id: ft_identity?.claim_id ?? null,
      queststar_row_id: row.id,
      request_date,
    });
  } catch (e) {
    scheduling = { skipped: "scheduler-error", detail: String(e?.message ?? e).slice(0, 160) };
  }

  return {
    action: "new_assignment",
    folder: folderResult.claim_folder,
    queststar_row_id: row.id,
    ft_backfill: ftBackfill,
    scheduling,
    ...(ft_identity ? { ft_identity } : {}),
    ...(carrier_short_flagged ? { carrier_short_unverified: carrier_short_flagged } : {}),
  };
}

async function processSupplement({ msg, parsed, todayDate, dryRun }) {
  const t = await tools();
  const driveFind = makeDriveFinder();

  // Try to recover claim identity via prior folder search.
  // We have at least carrier_claim_number from the Harbor classifier.
  // Search Drive for any folder whose name contains the claim # (or the
  // best identifier we have).
  const probes = [parsed.carrier_claim_number, parsed.claim_number, parsed.insured_name]
    .filter(Boolean);
  let priorFolders = [];
  let identity = null;
  for (const p of probes) {
    const hits = await driveFind(`name contains '${String(p).replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, 25);
    const parsedHits = hits.map(h => ({ ...h, parsed: parseClaimFolderName(h.name) })).filter(h => h.parsed);
    if (parsedHits.length) {
      priorFolders = parsedHits;
      identity = parsedHits[0].parsed;
      break;
    }
  }

  // Fallback: many supplements (e.g. Harbor) ride only the claim # — no
  // insured name in the body. Drive folder names contain insured, not the #.
  // Queststar bridges the two: rows have task = "{insured} ({client} ...)" so
  // a claim-# lookup gives us insured_name, which we re-probe Drive by.
  // Soft-fail on Queststar outages — don't crash the orchestrator.
  let queststarFallback = null;
  if (!identity) {
    let row = null;
    try {
      row = await findClaimRowByKey({
        claim_number: parsed.claim_number,
        carrier_claim_number: parsed.carrier_claim_number,
      });
    } catch (e) {
      queststarFallback = { error: `queststar-unreachable: ${e?.message ?? e}`.slice(0, 160) };
    }
    if (row) {
      const rf = qsRowFields(row);
      const insured = insuredFromQueststarTask(rf.task) ?? rf._title;
      if (insured) {
        queststarFallback = { row_id: row.id, insured };
        const hits = await driveFind(`name contains '${insured.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, 25);
        const parsedHits = hits.map(h => ({ ...h, parsed: parseClaimFolderName(h.name) })).filter(h => h.parsed);
        if (parsedHits.length) {
          priorFolders = parsedHits;
          identity = parsedHits[0].parsed;
        }
      }
    }
  }

  if (!identity) {
    return {
      skipped: "no-prior-claim-folder-found",
      detail: { tried_probes: probes, queststar_fallback: queststarFallback },
    };
  }

  const request_date = todayDate.slice(0, 10);
  const resolved = await resolveClaimFolderOrdinal({
    driveFindFile: driveFind,
    insured_name: identity.insured,
    client_short: identity.client,
    carrier_short: identity.carrier,
    loss_type: identity.loss_type,
    work_type: "supplement",
    request_date,
  });

  if (dryRun) {
    return {
      action: "supplement",
      dry_run: {
        identity,
        ordinal: resolved.ordinal,
        prior_folders: resolved.prior_folders.map(f => f.name),
        existing_today: resolved.existing_folder?.name,
      },
    };
  }

  // Create folder with explicit ordinal (bypasses same-month-only built-in resolver).
  const fr = await t.createClaimDriveFolder({
    request_date,
    insured_name: identity.insured,
    client_short: identity.client,
    carrier_short: identity.carrier,
    loss_type: identity.loss_type,
    work_type: "supplement",
    ordinal: resolved.ordinal,
  });
  const folderResult = asResultObject(fr);
  if (!folderResult.ok) {
    return { skipped: "folder-create-failed", detail: folderResult.error };
  }

  // Backfill: thread PDF + every attachment.
  await t.gmailEmailToPdf({
    message_id: msg.id,
    drive_folder_id: folderResult.claim_folder.id,
    filename: `${request_date} Supplement #${resolved.ordinal} - ${identity.insured}.pdf`,
  });
  for (const att of msg.attachments ?? []) {
    if (att.size < 5_000 && /image001\.(jpg|png)/i.test(att.filename)) continue;  // skip Harbor sig logo
    const dest = `/tmp/pipeline_${msg.id}_${att.filename}`;
    await t.gmailDownloadAttachment({ message_id: msg.id, attachment_id: att.attachment_id, dest_path: dest });
    await t.driveUploadFile({
      local_path: dest,
      name: att.filename,
      folder_id: folderResult.claim_folder.id,
      mime_type: att.mime_type,
    });
  }

  // Mirror to Queststar: append a dated supplement note to the matching row.
  let row = await findClaimRowByKey({
    claim_number: parsed.claim_number,
    carrier_claim_number: parsed.carrier_claim_number,
    insured_name: identity.insured,
  });
  if (row) {
    row = await appendClaimNote(row,
      `Supplement #${resolved.ordinal} received via ${parsed.sender_kind} (${msg.id}). Folder: ${folderResult.claim_folder.name}`);
  } // else: don't auto-create a row from a supplement — original claim should already exist

  // Re-inspection scheduling: most supplements are desk reviews — only a
  // request that explicitly asks for a re-visit gets the scheduling chain.
  // kind:"reinspection" makes the whole downstream loop skip CMS date fields
  // (the agreement lands as a GATED note instead).
  let scheduling = null;
  if (REINSPECTION_RE.test([msg.subject, parsed.loss_description, msg.body].filter(Boolean).join(" "))) {
    try {
      const company_index = CLIENT_TO_FT_COMPANY[identity.client] ?? null;
      if (company_index != null && (!parsed.insured_phone || !parsed.loss_address)) {
        await backfillIdentityFromFiletrac({ parsed, msg, client_short: identity.client }).catch(() => null);
      }
      scheduling = await proposeInspectionSms({
        msg, parsed, folderResult,
        insured: identity.insured, client_short: identity.client, loss_type: identity.loss_type,
        company_index, queststar_row_id: row?.id ?? null,
        request_date,
        kind: "reinspection",
      });
    } catch (e) {
      scheduling = { skipped: "scheduler-error", detail: String(e?.message ?? e).slice(0, 160) };
    }
  }

  return {
    action: "supplement",
    ordinal: resolved.ordinal,
    folder: folderResult.claim_folder,
    queststar_row_id: row?.id ?? null,
    ...(scheduling ? { scheduling } : {}),
  };
}

// A supplement email that asks for another site visit (vs. a paper review).
export const REINSPECTION_RE = /re-?inspect\w*|re-?visit|second (?:look|inspection)|go (?:back )?out (?:to|and)|another inspection|inspect (?:the )?(?:additional|new) damage/i;

function formatAddress(a) {
  if (!a) return "?";
  return [a.street, a.street2, a.city, a.state, a.zip].filter(Boolean).join(", ");
}

// ─── Single-message processor ──────────────────────────────────────────────

export async function processMessage(messageId, { dryRun = false, todayDate = new Date().toISOString().slice(0, 10) } = {}) {
  const t = await tools();
  const r = await t.gmailGetEmail({ message_id: messageId });
  const raw = callText(r);
  // gmail_get_email returns headers + body in a structured text dump.
  const from = raw.match(/^From:\s*(.+)$/m)?.[1] ?? "";
  const subject = raw.match(/^Subject:\s*(.+)$/m)?.[1] ?? "";
  const bodyIdx = raw.indexOf("\n\n");
  const body = bodyIdx >= 0 ? raw.slice(bodyIdx + 2) : raw;

  // Extract attachments block: "Attachments (N):" followed by indented lines.
  const attachments = [];
  const attBlock = raw.match(/Attachments \(\d+\):\n([\s\S]*?)(?:\n\n[A-Z]|$)/);
  if (attBlock) {
    const lines = attBlock[1].split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s+(.+)\s+\((.+?),\s+(.+?)\)\s*$/);
      if (m) {
        const filename = m[1];
        const mime_type = m[2];
        const sizeRaw = m[3];
        const size = parseSize(sizeRaw);
        // attachment_id on the next "    attachment_id: X" line
        let attachment_id = null;
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const a = lines[j].match(/attachment_id:\s*(\S+)/);
          if (a) { attachment_id = a[1]; break; }
        }
        attachments.push({ filename, mime_type, size, attachment_id });
      }
    }
  }

  const msg = { id: messageId, from, subject, body, attachments };
  const parsed = t.parseAssignmentEmail({ from, subject, body });
  if (!parsed.ok) {
    return { messageId, skipped: "unparseable", detail: parsed };
  }

  if (parsed.email_kind === "new_assignment") {
    return { messageId, ...await processNewAssignment({ msg, parsed, todayDate, dryRun }) };
  }
  if (parsed.email_kind === "supplement_request") {
    return { messageId, ...await processSupplement({ msg, parsed, todayDate, dryRun }) };
  }
  return { messageId, skipped: `non-actionable-kind=${parsed.email_kind}`, sender_kind: parsed.sender_kind };
}

function parseSize(raw) {
  // "145 KB", "3.0 KB", "411.5 KB", "1.2 MB"
  const m = raw.trim().match(/([\d.]+)\s*(KB|MB|B)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2].toUpperCase() === "MB" ? n * 1024 * 1024 : m[2].toUpperCase() === "KB" ? n * 1024 : n;
}

// ─── Batch driver ──────────────────────────────────────────────────────────

export async function processBatch({ since_days = 7, query, max_messages = 25, dryRun = false } = {}) {
  const t = await tools();
  const state = loadState();
  const sinceISO = new Date(Date.now() - since_days * 24 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "/");
  // Default query — assignments, supplements, status updates from known senders.
  const q = query ?? [
    `after:${sinceISO}`,
    `from:(donotreply@xactware.com OR info@pcsadj.com OR newclaim@usclaimsolutions.co OR assignments@ianetwork.net OR claims@harborclaims.com OR claims@straightlineglobal.com OR noreply@app.associatedadjusting.com)`,
  ].join(" ");

  const r = await t.gmailFindEmail({ query: q, max_results: max_messages });
  const text = callText(r);
  const ids = [...text.matchAll(/^ID:\s*(\S+)/gm)].map(m => m[1]);

  // Skips meaning "couldn't act yet, but might be actionable later" — do NOT
  // persist these as processed, or a parser/field gap makes the claim invisible
  // forever (the Carol-Gross silent-skip trap). They retry every run; folder
  // creation is idempotent so re-runs are safe.
  const RETRY_SKIPS = new Set(["incomplete-fields-for-new-assignment", "ft-backfill-error", "folder-create-failed"]);

  const results = [];
  for (const id of ids) {
    if (state.processed[id]) {
      results.push({ messageId: id, skipped: "already-processed", at: state.processed[id].processed_at });
      continue;
    }
    try {
      const out = await processMessage(id, { dryRun });
      results.push(out);
      // Persist as processed ONLY for a TERMINAL outcome: a real action, or a
      // non-retryable skip (status_update / note_added / …). A returned {error}
      // or a RETRY_SKIP must NOT be marked — otherwise a transient failure (e.g.
      // folder-create not ready, FileTrac down) silently drops the claim forever.
      // This is the Carol-Gross / Johnnie-Ausbon trap: a clean error RETURN (not
      // a throw) was being recorded as `skipped:undefined` and never retried.
      const isRetrySkip = out.skipped && RETRY_SKIPS.has(out.skipped);
      const isTerminal = !out.error && (out.action || (out.skipped && !isRetrySkip));
      if (!dryRun && isTerminal) {
        state.processed[id] = {
          processed_at: new Date().toISOString(),
          action: out.action ?? `skipped:${out.skipped}`,
          folder: out.folder?.name,
          queststar_row_id: out.queststar_row_id,
        };
      }
    } catch (e) {
      results.push({ messageId: id, error: String(e?.message ?? e) });
    }
  }
  if (!dryRun) saveState(state);
  return results;
}
