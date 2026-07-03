// folder-resolver.mjs — year-wide claim-folder resolver
//
// Given a classified email (insured/client/carrier/loss_type + work_type),
// scan Drive for ALL existing folders matching this claim's "fingerprint"
// (the part of the folder name that's stable across supplements) and
// return:
//   - the next-correct ordinal (so the new folder lands at 2nd/3rd/... not 1st)
//   - any existing folder at TODAY's date with the same shape (idempotent)
//
// The shipped resolveWorkTypeOrdinal in claim_drive_folder.ts only probes
// the CURRENT MONTH folder for the new candidate name, so it misses prior
// supplements in earlier months. This resolver does a year-wide name-search.
//
// Folder naming convention (from claim_drive_folder.ts):
//   YYYY-MM-DD_[(ord Work-Type) ]Insured_Client_Carrier_LossType
//
// "fingerprint" = `${Insured}_${Client}_${Carrier}_${LossType}`

const ORDINAL_WORD = /^(\d+)(?:st|nd|rd|th)?$/i;

/** Build the stable claim-identity suffix. */
export function claimFingerprint({ insured_name, client_short, carrier_short, loss_type }) {
  return `${insured_name}_${client_short}_${carrier_short}_${loss_type}`;
}

/**
 * Resolve work-type ordinal + idempotent existing folder for a claim.
 *
 * @param {object} args
 * @param {function} args.driveFindFile  — async (q, max_results) → list of {id,name,...}
 * @param {string} args.insured_name
 * @param {string} args.client_short
 * @param {string} args.carrier_short
 * @param {string} args.loss_type
 * @param {"supplement"|"reinspection"|"reopen"|undefined} args.work_type
 * @param {string} args.request_date — ISO date (YYYY-MM-DD)
 * @returns {Promise<{ordinal:number, existing_folder?:{id:string,name:string}, prior_folders:Array<{id:string,name:string,date:string,ordinal:number,work_type:string|null}>}>}
 */
export async function resolveClaimFolderOrdinal(args) {
  const fingerprint = claimFingerprint(args);
  const fpEsc = fingerprint.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  // Drive name-search across the whole drive — fingerprint is unique enough
  // (full insured + client + carrier + loss-type combination).
  const q =
    `name contains '${fpEsc}' and mimeType = 'application/vnd.google-apps.folder' ` +
    `and trashed = false`;
  const results = await args.driveFindFile(q, 100);

  // Parse each name: YYYY-MM-DD_[(ord Work-Type) ]<fingerprint>
  // ord = "" or "2nd " or "10th "
  const fpEscapeRe = fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matchRe = new RegExp(
    `^(\\d{4}-\\d{2}-\\d{2})_(?:\\((?:(\\d+)(?:st|nd|rd|th)?\\s+)?` +
      `(Supplement|Reinspection|Reopen)\\)\\s+)?` +
      `${fpEscapeRe}$`,
    "i",
  );

  const priorFolders = [];
  for (const r of results) {
    const m = r.name.match(matchRe);
    if (!m) continue;
    const [_, date, ordStr, wtRaw] = m;
    priorFolders.push({
      id: r.id,
      name: r.name,
      date,
      ordinal: ordStr ? parseInt(ordStr, 10) : 1,
      work_type: wtRaw ? wtRaw.toLowerCase() : null,
    });
  }

  // Idempotent existing folder for today's request_date + same work_type
  const existing = priorFolders.find(
    f => f.date === args.request_date && f.work_type === (args.work_type ?? null),
  );

  if (existing) {
    return { ordinal: existing.ordinal, existing_folder: { id: existing.id, name: existing.name }, prior_folders: priorFolders };
  }

  if (!args.work_type) {
    // New assignment — no parenthetical prefix; ordinal is moot.
    return { ordinal: 1, prior_folders: priorFolders };
  }

  // Count prior folders of THIS work_type (regardless of date), pick max+1.
  const sameType = priorFolders.filter(f => f.work_type === args.work_type);
  const max = sameType.reduce((acc, f) => Math.max(acc, f.ordinal), 0);
  return { ordinal: max + 1, prior_folders: priorFolders };
}
