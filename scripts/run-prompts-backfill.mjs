/**
 * One-off backfill for the 2026-05-07 prompt batch.
 *
 * Run from repo root via:
 *   railway run node scripts/run-prompts-backfill.mjs
 * (or with NOTION_TOKEN exported locally:
 *   NOTION_TOKEN=secret_... node scripts/run-prompts-backfill.mjs)
 *
 * Does:
 *   1. Archives 3 [REMOVED] database items from the Erseville Task Hub
 *      (replaces the rename hack — uses real PATCH /v1/pages/:id archived).
 *   2. Reorders the database properties into the workflow-correct sequence:
 *      Inspection -> Photo Report -> Sketch -> Estimate -> Narrative
 *      (each with their checkbox + Status + Hours triplet adjacent).
 *
 * Idempotent — re-runs are safe.
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error("NOTION_TOKEN not set. Run via `railway run` or export it locally.");
  process.exit(1);
}

const NOTION_VERSION = "2022-06-28";
const DB_ID = "339257c0-64f6-8015-8c95-ccb80a15a5c6"; // Erseville Task Hub

const PAGES_TO_ARCHIVE = [
  "339257c0-64f6-8194-9ef9-f22ea49db6c2", // Payment Consultants
  "339257c0-64f6-81a1-8aaa-c61eea8c9a9f", // PCAS #81030217
  "339257c0-64f6-81ff-9470-d7aaec1e920b", // PCAS #81030229
];

// Workflow order: inspect -> photos -> sketch -> estimate -> narrative.
// Each subtask has a checkbox column, a Status column, and an Hours column;
// the script discovers them from the schema by name-prefix match so it
// doesn't break if the exact property naming differs slightly.
const SUBTASK_ORDER = ["Inspection", "Photo Report", "Sketch", "Estimate", "Narrative"];

async function notionFetch(path, method = "GET", body = null) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion API error ${res.status}: ${err}`);
  }
  return res.json();
}

async function archivePages() {
  console.log("\n=== Archiving 3 [REMOVED] pages ===");
  for (const pid of PAGES_TO_ARCHIVE) {
    try {
      const before = await notionFetch(`/pages/${pid}`, "GET").catch((e) => ({ _err: e.message }));
      if (before._err) {
        console.log(`  SKIP ${pid} — ${before._err}`);
        continue;
      }
      if (before.archived) {
        console.log(`  SKIP ${pid} — already archived`);
        continue;
      }
      await notionFetch(`/pages/${pid}`, "PATCH", { archived: true });
      console.log(`  OK   ${pid}`);
    } catch (e) {
      console.log(`  FAIL ${pid} — ${e.message}`);
    }
  }
}

async function reorderProperties() {
  console.log("\n=== Reordering Erseville Task Hub columns ===");
  const db = await notionFetch(`/databases/${DB_ID}`, "GET");
  const props = db.properties || {};
  const names = Object.keys(props);

  console.log(`  Existing properties (${names.length}):`);
  for (const n of names) console.log(`    - ${n} (${props[n].type})`);

  // For each subtask in the workflow order, gather any property whose name
  // contains the subtask label. So "Inspection" matches both the checkbox
  // and any "Inspection Status"/"Inspection Hours" sibling. Sort the
  // matches so a bare label (e.g. "Inspection") comes before its qualifiers.
  const ordered = [];
  for (const subtask of SUBTASK_ORDER) {
    const matches = names.filter((n) => n.toLowerCase().includes(subtask.toLowerCase()));
    matches.sort((a, b) => a.length - b.length); // shortest (the bare label) first
    for (const m of matches) {
      if (!ordered.includes(m)) ordered.push(m);
    }
  }

  // Append everything else (Title, Status, Notes, Domain, etc.) at the end
  // in their original relative order.
  const remaining = names.filter((n) => !ordered.includes(n));
  const finalOrder = [...ordered, ...remaining];

  console.log(`\n  Target order:`);
  for (let i = 0; i < finalOrder.length; i++) {
    const tag = i < ordered.length ? "[subtask]" : "[other]  ";
    console.log(`    ${tag} ${finalOrder[i]}`);
  }

  // Build the PATCH payload — re-send each property's existing definition
  // (minus its read-only `id`). Order is determined by JS object insertion.
  const newProps = {};
  for (const name of finalOrder) {
    const { id: _omit, ...def } = props[name];
    newProps[name] = def;
  }

  const res = await notionFetch(`/databases/${DB_ID}`, "PATCH", { properties: newProps });
  const final = Object.keys(res.properties || {});
  console.log(`\n  Notion returned schema order:`);
  for (const n of final) console.log(`    - ${n}`);

  console.log(`\n  Note: Notion's default-view column order generally follows schema order, but you may need to refresh the Notion app/browser to see the change reflected.`);
}

async function main() {
  await archivePages();
  await reorderProperties();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
