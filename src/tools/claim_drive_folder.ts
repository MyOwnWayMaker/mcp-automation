import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { driveCreateFolder, driveFindFile } from "./drive.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// MCP tool helpers return CallToolResult with plain-text bodies — extract.
function extractText(r: CallToolResult): string {
  const c0 = r.content?.[0];
  return c0 && c0.type === "text" ? c0.text : "";
}

function extractFolderId(text: string): string | null {
  const m = text.match(/^ID:\s*(\S+)/m);
  return m?.[1] ?? null;
}

function extractFolderLink(text: string): string | null {
  const m = text.match(/^Link:\s*(\S+)/m);
  return m?.[1] ?? null;
}

// ─── Tree-name derivation per locked 2026-05-04 convention ──────────────

const QUARTER_LABELS: Record<number, string> = {
  1: "Q1 (Jan–Mar)",
  2: "Q2 (Apr–Jun)",
  3: "Q3 (Jul–Sep)",
  4: "Q4 (Oct–Dec)",
};

function quarterFromMonth(monthZeroBased: number): number {
  return Math.floor(monthZeroBased / 3) + 1;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Returns { yearLabel, quarterLabel, monthLabel } for the given ISO date
 * string in LA-local time. Uses Intl so it's DST-correct + portable.
 */
function deriveTreeLabels(requestDateIso: string): {
  year: string;
  quarter: string;
  monthYearMonth: string;
  yearMonthDay: string;
} {
  // Parse the input — accept full ISO or YYYY-MM-DD; treat the latter as
  // LA-local midnight to avoid TZ slip.
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(requestDateIso);
  const parsed = isDateOnly
    ? new Date(`${requestDateIso}T12:00:00-07:00`)  // noon LA, safe from DST edges
    : new Date(requestDateIso);
  if (isNaN(parsed.getTime())) {
    throw new Error(`bad request_date: ${requestDateIso}`);
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(parsed).map((p) => [p.type, p.value]));
  const y = parts.year;
  const m = parts.month;
  const d = parts.day;
  const monthZero = parseInt(m) - 1;
  return {
    year: y,
    quarter: QUARTER_LABELS[quarterFromMonth(monthZero)],
    monthYearMonth: `${y}-${m}`,
    yearMonthDay: `${y}-${m}-${d}`,
  };
}

/**
 * Build the claim-folder name per locked 2026-05-04 convention:
 *   {YYYY-MM-DD}_(work-type) Insured_Client_Carrier_LossType
 * Original new assignments — no parenthetical:
 *   2026-05-04_Raymond Rodriguez_PCAS_DBI_Water
 * Supplements / reinspections / reopens — parenthetical BEFORE name:
 *   2026-04-21_(supplement) Cheryl Groves_SLG_NARS_Water
 */
function buildClaimFolderName(args: {
  request_date: string;
  insured_name: string;
  client_short: string;
  carrier_short: string;
  loss_type: string;
  work_type?: "supplement" | "reinspection" | "reopen";
}): string {
  const labels = deriveTreeLabels(args.request_date);
  const wt = args.work_type ? `(${args.work_type}) ` : "";
  return `${labels.yearMonthDay}_${wt}${args.insured_name}_${args.client_short}_${args.carrier_short}_${args.loss_type}`;
}

// ─── Find-or-create helper ───────────────────────────────────────────────

async function findFolderByNameInParent(parentId: string, name: string): Promise<string | null> {
  // Drive query is single-quote-sensitive — escape any apostrophes in name.
  const safe = name.replace(/'/g, "\\'");
  const q = `'${parentId}' in parents and name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await driveFindFile({ query: q, max_results: 5 });
  const text = extractText(res);
  if (text === "No files found.") return null;
  // First result block.
  return extractFolderId(text);
}

async function findOrCreateFolder(parentId: string, name: string): Promise<{ id: string; created: boolean; link?: string }> {
  const existing = await findFolderByNameInParent(parentId, name);
  if (existing) {
    return { id: existing, created: false };
  }
  const created = await driveCreateFolder({ name, parent_id: parentId });
  const text = extractText(created);
  const id = extractFolderId(text);
  if (!id) throw new Error(`drive_create_folder did not return an ID for ${name}: ${text}`);
  return { id, created: true, link: extractFolderLink(text) ?? undefined };
}

// ─── Public API ──────────────────────────────────────────────────────────

export type CreateClaimDriveFolderArgs = {
  /** Root "Claims" folder ID. Default: looks up the folder named "Claims" at Drive root. */
  claims_root_id?: string;
  /**
   * The date the work was REQUESTED (not the inspection date). Drives the
   * year/quarter/month placement + the leading YYYY-MM-DD on the claim
   * folder. Accepts ISO datetime or YYYY-MM-DD (treated as LA-local noon).
   */
  request_date: string;
  /** Insured display name as it should appear in the folder name. */
  insured_name: string;
  /** Short client code, e.g. "PCAS", "SLG", "USCS". */
  client_short: string;
  /** Short carrier code, e.g. "DBI", "Fortegra". */
  carrier_short: string;
  /** Loss type, e.g. "Water", "Wind", "Vehicle". */
  loss_type: string;
  /** Set for supplements / reinspections / reopens — adds the parenthetical prefix. */
  work_type?: "supplement" | "reinspection" | "reopen";
};

export type CreateClaimDriveFolderResult =
  | {
      ok: true;
      // IDs and links for every level
      year_folder: { id: string; name: string; created: boolean };
      quarter_folder: { id: string; name: string; created: boolean };
      month_folder: { id: string; name: string; created: boolean };
      claim_folder: { id: string; name: string; created: boolean; link?: string };
      photos_folder: { id: string; name: string; created: boolean };
      // Full path for human reference
      path: string;
      already_existed: boolean;   // true if claim_folder was found rather than created
    }
  | { ok: false; error: string };

/**
 * D4 — per-claim Drive folder creator. Idempotent: reuses existing
 * year/quarter/month folders, returns existing claim folder if found
 * (with `already_existed: true`).
 *
 * Tree built per locked 2026-05-04 drive_folder_convention:
 *   Claims/{YYYY}/Q{n} (MMM–MMM)/{YYYY-MM}/{YYYY-MM-DD}_{(work-type) }Insured_Client_Carrier_LossType/
 *     Photos for Xactimate/
 *
 * Notary signings get NO Drive folder per the same convention — caller
 * should not invoke this for notary work.
 */
export async function createClaimDriveFolder(args: CreateClaimDriveFolderArgs): Promise<CreateClaimDriveFolderResult> {
  // 1. Locate the Claims root.
  let claimsRootId = args.claims_root_id;
  if (!claimsRootId) {
    const findRoot = await driveFindFile({
      query: `name = 'Claims' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      max_results: 5,
    });
    const text = extractText(findRoot);
    claimsRootId = extractFolderId(text) ?? undefined;
    if (!claimsRootId) {
      return { ok: false, error: "Could not locate root 'Claims' folder. Pass claims_root_id explicitly." };
    }
  }

  // 2. Derive the tree labels.
  let labels;
  try {
    labels = deriveTreeLabels(args.request_date);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  // 3. Walk / create each level.
  try {
    const yearFolder = await findOrCreateFolder(claimsRootId, labels.year);
    const quarterFolder = await findOrCreateFolder(yearFolder.id, labels.quarter);
    const monthFolder = await findOrCreateFolder(quarterFolder.id, labels.monthYearMonth);

    const claimFolderName = buildClaimFolderName({
      request_date: args.request_date,
      insured_name: args.insured_name,
      client_short: args.client_short,
      carrier_short: args.carrier_short,
      loss_type: args.loss_type,
      work_type: args.work_type,
    });
    const claimFolder = await findOrCreateFolder(monthFolder.id, claimFolderName);

    // Photos for Xactimate is a standard subfolder per claim — create even
    // if claim folder pre-existed (in case it was missing).
    const photosFolder = await findOrCreateFolder(claimFolder.id, "Photos for Xactimate");

    return {
      ok: true,
      year_folder: { id: yearFolder.id, name: labels.year, created: yearFolder.created },
      quarter_folder: { id: quarterFolder.id, name: labels.quarter, created: quarterFolder.created },
      month_folder: { id: monthFolder.id, name: labels.monthYearMonth, created: monthFolder.created },
      claim_folder: {
        id: claimFolder.id,
        name: claimFolderName,
        created: claimFolder.created,
        link: claimFolder.link,
      },
      photos_folder: { id: photosFolder.id, name: "Photos for Xactimate", created: photosFolder.created },
      path: `Claims/${labels.year}/${labels.quarter}/${labels.monthYearMonth}/${claimFolderName}/`,
      already_existed: !claimFolder.created,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function createClaimDriveFolderTool(args: CreateClaimDriveFolderArgs): Promise<CallToolResult> {
  const result = await createClaimDriveFolder(args);
  return ok(JSON.stringify(result, null, 2));
}
