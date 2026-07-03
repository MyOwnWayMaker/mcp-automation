// Regression tests for scripts/pipeline/queststar.mjs HTTP wire format.
//
// What this guards against:
//   - The PATCH-replace bug discovered 2026-07-02: the API stores row data under
//     a nested `fields` object, and PATCH {fields:{...}} REPLACES that whole
//     object — a partial wrapped PATCH silently drops every omitted key (wiped
//     row 1103), and a flat-key PATCH is a silent no-op (200, nothing written).
//     updateClaimRow must therefore read-merge-write: GET /rows/:id → spread in
//     the changes → PATCH the COMPLETE merged fields object.
//     (This inverts the 2026-06-09 flat-keys contract — the app changed.)
//   - POST createClaimRow still uses the `{fields:{...}}` wrapper on create.
//   - findClaimRowByKey must read row data via rowFields() so it matches both
//     current nested-fields rows and legacy flat rows.
//   - Bearer auth + JSON content-type are present on every request.
//   - appendClaimNote prepends a `[YYYY-MM-DD]` line to existing notes
//     (and creates a fresh notes field when notes are empty).
//   - On non-2xx the helpers throw with the status code surfaced in the
//     message (so the orchestrator's soft-fail try/catch can log usefully).
//
// Run with: npm test (or: node --test tests/queststar_wire.test.mjs)

import test from "node:test";
import assert from "node:assert/strict";

// Env must be set BEFORE importing queststar.mjs — assertCreds reads
// process.env at call time, but we also want to skip the .env.local read.
process.env.QUESTSTAR_BASE = "https://queststar.test";
process.env.QUESTSTAR_TOKEN = "qs_TEST_TOKEN";
process.env.PIPELINE_ENV_PATH = "/tmp/__nonexistent_env__"; // skip real .env load

const { createClaimRow, updateClaimRow, appendClaimNote, listClaimRows, findClaimRowByKey, rowFields } =
  await import("../scripts/pipeline/queststar.mjs");

// Per-test fetch mock. Each test installs a captor; cleanup happens at end.
function installFetchMock(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init }, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

function jsonResp(status, bodyObj) {
  return new Response(JSON.stringify(bodyObj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Standard mock for updateClaimRow's read-merge-write: first call (GET) returns
// the current row, second call (PATCH) echoes back.
function mockRowServer(currentRow) {
  return installFetchMock(({ init }) =>
    (init?.method ?? "GET") === "GET" ? jsonResp(200, currentRow) : jsonResp(200, currentRow));
}

// ── rowFields ──────────────────────────────────────────────────────────────

test("rowFields: nested fields win, metadata keys stripped", () => {
  const f = rowFields({ id: 5, database_id: 1, created_at: "x", updated_at: "y", task: "flat", fields: { task: "nested", notes: "n" } });
  assert.deepEqual(f, { task: "nested", notes: "n" });
});

test("rowFields: legacy flat row passes through (minus metadata)", () => {
  const f = rowFields({ id: 5, database_id: 1, created_at: "x", updated_at: "y", task: "A", notes: "old" });
  assert.deepEqual(f, { task: "A", notes: "old" });
});

test("rowFields: null-safe", () => {
  assert.deepEqual(rowFields(null), {});
});

// ── createClaimRow ─────────────────────────────────────────────────────────

test("createClaimRow: POST body is { fields: {...} } (server accepts wrapped on create)", async () => {
  const { calls, restore } = installFetchMock(() => jsonResp(201, { id: 999, fields: { task: "test" } }));
  try {
    const row = await createClaimRow({ task: "Carol Gross", claim_no: "1097520", ia_firm: "PCAS" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://queststar.test/api/databases/claims-business/rows");
    assert.equal(calls[0].init.method, "POST");
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { fields: { task: "Carol Gross", claim_no: "1097520", ia_firm: "PCAS" } });
    assert.equal(row.id, 999);
  } finally { restore(); }
});

test("createClaimRow: auth + content-type headers set", async () => {
  const { calls, restore } = installFetchMock(() => jsonResp(201, { id: 1 }));
  try {
    await createClaimRow({ task: "x" });
    const h = calls[0].init.headers;
    assert.equal(h["authorization"], "Bearer qs_TEST_TOKEN");
    assert.equal(h["content-type"], "application/json");
  } finally { restore(); }
});

// ── updateClaimRow (read-merge-write; the PATCH-replace bug) ───────────────

test("updateClaimRow: GET current row first, then PATCH the COMPLETE merged fields (wrapped)", async () => {
  const { calls, restore } = mockRowServer({
    id: 348,
    fields: { task: "Keep Me", ia_firm: "PCAS", notes: "old", status: "Pending Inspection" },
  });
  try {
    await updateClaimRow(348, { notes: "new", status: "Inspected" });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.method ?? "GET", "GET");
    assert.equal(calls[0].url, "https://queststar.test/api/databases/claims-business/rows/348");
    assert.equal(calls[1].init.method, "PATCH");
    assert.equal(calls[1].url, "https://queststar.test/api/databases/claims-business/rows/348");
    const body = JSON.parse(calls[1].init.body);
    // Wrapped, AND complete: untouched keys must survive the merge.
    assert.deepEqual(body, {
      fields: { task: "Keep Me", ia_firm: "PCAS", notes: "new", status: "Inspected" },
    });
  } finally { restore(); }
});

test("updateClaimRow: a partial PATCH that would drop keys never leaves the client", async () => {
  // If anyone reverts to a blind `req("PATCH", path, {fields: changes})` this fails.
  const { calls, restore } = mockRowServer({ id: 7, fields: { task: "T", section: "Claims" } });
  try {
    await updateClaimRow(7, { status: "Complete" });
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.fields.task, "T", "must carry forward keys not being changed");
    assert.equal(body.fields.section, "Claims");
    assert.equal(body.fields.status, "Complete");
  } finally { restore(); }
});

test("updateClaimRow: string row ids work", async () => {
  const { calls, restore } = mockRowServer({ id: "abc-123", fields: {} });
  try {
    await updateClaimRow("abc-123", { inspection_status: "site_inspected" });
    assert.equal(calls[1].init.method, "PATCH");
    assert.equal(calls[1].url.endsWith("/rows/abc-123"), true);
  } finally { restore(); }
});

// ── appendClaimNote ────────────────────────────────────────────────────────

test("appendClaimNote: prepends dated line, preserves existing notes", async () => {
  const existing = "previous note line";
  const { calls, restore } = mockRowServer({ id: 348, fields: { task: "T", notes: existing } });
  try {
    await appendClaimNote({ id: 348, fields: { task: "T", notes: existing } }, "supplement received");
    const body = JSON.parse(calls[1].init.body);
    assert.equal(typeof body.fields.notes, "string");
    assert.match(body.fields.notes, /^\[\d{4}-\d{2}-\d{2}\] supplement received/);
    assert.ok(body.fields.notes.includes(existing), "must preserve previous notes");
    assert.equal(body.fields.task, "T", "merge must keep unrelated fields");
  } finally { restore(); }
});

test("appendClaimNote: legacy flat row (notes at top level) still works", async () => {
  const { calls, restore } = mockRowServer({ id: 348, fields: { notes: "old flat" } });
  try {
    await appendClaimNote({ id: 348, notes: "old flat" }, "supplement received");
    const body = JSON.parse(calls[1].init.body);
    assert.ok(body.fields.notes.includes("old flat"));
  } finally { restore(); }
});

test("appendClaimNote: empty existing notes → just the dated line", async () => {
  const { calls, restore } = mockRowServer({ id: 1, fields: {} });
  try {
    await appendClaimNote({ id: 1, fields: { notes: "" } }, "first note");
    const body = JSON.parse(calls[1].init.body);
    assert.match(body.fields.notes, /^\[\d{4}-\d{2}-\d{2}\] first note$/);
  } finally { restore(); }
});

// ── error surfacing ────────────────────────────────────────────────────────

test("req: 401 surfaces status code in thrown message (updateClaimRow fails on its read)", async () => {
  const { restore } = installFetchMock(() =>
    new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="Queststar"' } }));
  try {
    await assert.rejects(
      () => updateClaimRow(348, { notes: "x" }),
      (e) => /401/.test(e.message) && /GET/.test(e.message),
    );
  } finally { restore(); }
});

test("req: 401 on the PATCH leg surfaces PATCH", async () => {
  const { restore } = installFetchMock(({ init }) =>
    (init?.method ?? "GET") === "GET"
      ? jsonResp(200, { id: 348, fields: {} })
      : new Response("Unauthorized", { status: 401 }));
  try {
    await assert.rejects(
      () => updateClaimRow(348, { notes: "x" }),
      (e) => /401/.test(e.message) && /PATCH/.test(e.message),
    );
  } finally { restore(); }
});

test("req: 500 surfaces status code", async () => {
  const { restore } = installFetchMock(() =>
    new Response("boom", { status: 500 }));
  try {
    await assert.rejects(
      () => createClaimRow({ task: "x" }),
      (e) => /500/.test(e.message) && /POST/.test(e.message),
    );
  } finally { restore(); }
});

// ── listClaimRows / findClaimRowByKey ──────────────────────────────────────

test("listClaimRows: GET .../rows?limit=500 → array", async () => {
  const { calls, restore } = installFetchMock(() => jsonResp(200, {
    rows: [{ id: 1, fields: { task: "A" } }, { id: 2, fields: { task: "B" } }],
  }));
  try {
    const rows = await listClaimRows();
    assert.equal(rows.length, 2);
    assert.equal(calls[0].url, "https://queststar.test/api/databases/claims-business/rows?limit=500");
    assert.equal(calls[0].init.method, "GET");
  } finally { restore(); }
});

test("findClaimRowByKey: matches by claim_number substring in nested fields.task", async () => {
  const { restore } = installFetchMock(() => jsonResp(200, {
    rows: [
      { id: 1, fields: { task: "Smith (PCAS 1234567)" } },
      { id: 2, fields: { task: "Jones (USCS 9876543)" } },
    ],
  }));
  try {
    const r = await findClaimRowByKey({ claim_number: "9876543" });
    assert.equal(r?.id, 2);
  } finally { restore(); }
});

test("findClaimRowByKey: still matches legacy flat rows", async () => {
  const { restore } = installFetchMock(() => jsonResp(200, {
    rows: [
      { id: 1, task: "Carol Gross (PCAS 1234567)" },
      { id: 2, task: "Cheryl Paller Living Trust (PCAS 1097519)" },
    ],
  }));
  try {
    const r = await findClaimRowByKey({ insured_name: "Carol Gross" });
    assert.equal(r?.id, 1);
  } finally { restore(); }
});

test("findClaimRowByKey: no probes → null (defensive)", async () => {
  const { restore } = installFetchMock(() => jsonResp(200, { rows: [] }));
  try {
    assert.equal(await findClaimRowByKey({}), null);
  } finally { restore(); }
});

test("findClaimRowByKey: no match → null", async () => {
  const { restore } = installFetchMock(() => jsonResp(200, {
    rows: [{ id: 1, fields: { task: "Smith (PCAS 1)" } }],
  }));
  try {
    assert.equal(await findClaimRowByKey({ claim_number: "999" }), null);
  } finally { restore(); }
});
