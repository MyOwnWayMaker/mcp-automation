// queststar.mjs — thin HTTP client for the Queststar workspace app.
//
// Reads QUESTSTAR_BASE + QUESTSTAR_TOKEN from /Users/dino/mcp-automation/.env.local
// (or from process.env if already set).
//
// Surfaces just what the claim pipeline needs:
//   - findClaimRowByKey({ claim_number, file_number, insured_name }) → row | null
//   - createClaimRow(rowFields) → row
//   - updateClaimRow(rowId, changes) → row  (read-merge-write; safe partial update)
//   - appendClaimNote(row, line) → row  (prepends a dated line to `notes`)
//
// API shape (re-verified 2026-07-02 against rows 1103/1443/1445):
//   GET    /api/databases/claims-business/rows?limit=...   → each row carries its data
//          under a nested `fields` object ({id, created_at, updated_at, fields:{...}}).
//   POST   /api/databases/claims-business/rows   body={fields:{...}}
//   PATCH  /api/databases/claims-business/rows/:id  body={fields:{...}}  ← REPLACES the
//          whole fields object. A partial wrapped PATCH silently DROPS every omitted key
//          (wiped row 1103 on 2026-07-02, restored by hand), and a flat-key PATCH is a
//          silent no-op (200, nothing written). updateClaimRow therefore always
//          read-merges: GET current fields → spread in the changes → PATCH the complete
//          object. (This inverts the 2026-06-09 contract, which wanted flat keys — the
//          app's row storage changed underneath us.)
//
// claims-business field keys (see queststar-token memory):
//   task (text, primary), section (select), ia_firm (select), status (select),
//   carrier (text), assignment_received (date), notes (text),
//   inspection_status (select), domain (select)

import "./env.mjs";

const BASE = process.env.QUESTSTAR_BASE;
const TOKEN = process.env.QUESTSTAR_TOKEN;

function assertCreds() {
  if (!BASE || !TOKEN) {
    throw new Error(
      "QUESTSTAR_BASE / QUESTSTAR_TOKEN not set. Drop them in /Users/dino/mcp-automation/.env.local",
    );
  }
}

async function req(method, p, body) {
  assertCreds();
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      "authorization": `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`Queststar ${method} ${p} → ${res.status} ${res.statusText}: ${txt.slice(0, 500)}`);
  }
  return txt ? JSON.parse(txt) : null;
}

/**
 * Row data may live under a nested `fields` object (current API) or flat on the
 * row (legacy Notion-imported rows keep flat copies too). Merge both views so
 * callers can read `rowFields(r).task` regardless of vintage.
 */
export function rowFields(row) {
  if (!row) return {};
  const { id, database_id, created_at, updated_at, fields, ...flat } = row;
  return { ...flat, ...(fields ?? {}) };
}

/** GET /api/databases/claims-business/rows → list of row objects (data under .fields). */
export async function listClaimRows({ limit = 500 } = {}) {
  const r = await req("GET", `/api/databases/claims-business/rows?limit=${limit}`);
  return r.rows ?? [];
}

/**
 * Find a row matching ANY of the provided identifiers (claim_number, file_number,
 * carrier_claim_number, insured_name). Returns the first match or null.
 *
 * We search loosely against the `task` (title) field + `notes` because the
 * existing seed rows store identifiers in those free-text fields rather than
 * dedicated columns. As schema firms up we can switch to a dedicated
 * `claim_number` field.
 */
export async function findClaimRowByKey({ claim_number, file_number, carrier_claim_number, insured_name } = {}) {
  const rows = await listClaimRows();
  const probes = [claim_number, file_number, carrier_claim_number, insured_name]
    .filter(Boolean)
    .map(s => String(s).toLowerCase());
  if (!probes.length) return null;

  for (const r of rows) {
    const f = rowFields(r);
    const hay = [f.task, f._title, f.notes, f.carrier, f.ia_firm]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (probes.some(p => hay.includes(p))) return r;
  }
  return null;
}

/** POST /api/databases/claims-business/rows */
export async function createClaimRow(fields) {
  return await req("POST", `/api/databases/claims-business/rows`, { fields });
}

/**
 * PATCH /api/databases/claims-business/rows/:id — the API replaces the ENTIRE
 * fields object, so a safe partial update must read-merge-write. Never call the
 * raw PATCH with a subset of keys.
 */
export async function updateClaimRow(rowId, changes) {
  const current = await req("GET", `/api/databases/claims-business/rows/${rowId}`);
  const merged = { ...rowFields(current), ...changes };
  return await req("PATCH", `/api/databases/claims-business/rows/${rowId}`, { fields: merged });
}

/**
 * Prepend a dated line to the row's `notes` field. Used for supplements / notes
 * added — we keep an audit trail in-line rather than scattering events across
 * fields. Returns the updated row.
 */
export async function appendClaimNote(row, line) {
  const stamp = new Date().toISOString().slice(0, 10);
  const prevNotes = rowFields(row).notes;
  const newNote = `[${stamp}] ${line}` + (prevNotes ? `\n\n${prevNotes}` : "");
  return await updateClaimRow(row.id, { notes: newNote });
}
