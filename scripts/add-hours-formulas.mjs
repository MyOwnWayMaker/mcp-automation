// One-shot: add Total Hours + Effective $/hr formula columns to Erseville
// Task Hub. Verifies via re-read and spot-checks Orkin LLC. Sends ntfy on
// success. Run with `railway run node scripts/add-hours-formulas.mjs` so
// NOTION_TOKEN is injected from Railway.

const DATABASE_ID = "339257c0-64f6-8015-8c95-ccb80a15a5c6";
const NTFY_TOPIC = "dino-claims-alerts-fpx";
const NTFY_SERVER = "https://ntfy.sh";

const TOTAL_HOURS_EXPR =
  'prop("Inspection Hours") + prop("Photo Report Hours") + prop("Sketch Hours") + prop("Estimate Hours") + prop("Narrative Hours") + prop("Drive Hours")';

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error("NOTION_TOKEN not set. Run via: railway run node scripts/add-hours-formulas.mjs");
  process.exit(1);
}

async function notionFetch(path, method = "GET", body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Notion ${res.status}: ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

async function addFormulaProperty(name, expression) {
  return notionFetch(`/databases/${DATABASE_ID}`, "PATCH", {
    properties: { [name]: { formula: { expression } } },
  });
}

async function ntfy(message) {
  try {
    await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: "Notion schema",
        Priority: "3",
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: message,
    });
    console.log(`ntfy sent: ${message}`);
  } catch (e) {
    console.error(`ntfy failed: ${e.message}`);
  }
}

function fmtNumber(n) {
  if (n == null) return "(empty)";
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}

(async () => {
  console.log(`DB: ${DATABASE_ID}`);

  // 1. Pre-check: read schema, list current property names that look relevant.
  const before = await notionFetch(`/databases/${DATABASE_ID}`);
  const propsBefore = Object.keys(before.properties);
  console.log(`Pre-existing property count: ${propsBefore.length}`);
  for (const want of ["Inspection Hours", "Photo Report Hours", "Sketch Hours", "Estimate Hours", "Narrative Hours", "Drive Hours", "Billed Amount"]) {
    const has = propsBefore.includes(want);
    console.log(`  ${has ? "OK" : "MISSING"} ${want}`);
    if (!has) {
      console.error(`Required input property missing: ${want}. Aborting.`);
      process.exit(2);
    }
  }
  if (propsBefore.includes("Total Hours")) console.log('  NOTE: "Total Hours" already exists. Will be overwritten by PATCH.');
  if (propsBefore.includes("Effective $/hr")) console.log('  NOTE: "Effective $/hr" already exists. Will be overwritten by PATCH.');

  // 2. Add Total Hours first (Effective $/hr depends on it).
  console.log("\n[1/2] Adding Total Hours formula...");
  await addFormulaProperty("Total Hours", TOTAL_HOURS_EXPR);
  console.log("  Total Hours added.");

  // 3. Add Effective $/hr. Notion's formula 2.0 won't auto-coerce another
  //    formula's number output, so we can't reference Total Hours from here;
  //    inline the sum instead. Try candidates in order until one sticks.
  console.log("\n[2/2] Adding Effective $/hr formula...");
  // Notion's formula 2.0 won't let us reference Total Hours (a formula prop)
  // from another formula due to a "Type error" — it doesn't auto-coerce a
  // formula's number output. Workaround: inline the sum.
  const SUM_INLINE =
    'prop("Inspection Hours") + prop("Photo Report Hours") + prop("Sketch Hours") + prop("Estimate Hours") + prop("Narrative Hours") + prop("Drive Hours")';
  const candidates = [
    {
      label: "let() with inline sum",
      expr: `let(total, ${SUM_INLINE}, if(total > 0, prop("Billed Amount") / total, 0))`,
    },
    {
      label: "inline sum, if > 0",
      expr: `if((${SUM_INLINE}) > 0, prop("Billed Amount") / (${SUM_INLINE}), 0)`,
    },
    {
      label: "inline sum, ternary > 0",
      expr: `(${SUM_INLINE}) > 0 ? prop("Billed Amount") / (${SUM_INLINE}) : 0`,
    },
  ];
  let added = false;
  for (const cand of candidates) {
    try {
      await addFormulaProperty("Effective $/hr", cand.expr);
      console.log(`  Effective $/hr added (${cand.label}).`);
      added = true;
      break;
    } catch (e) {
      console.log(`  REJECTED [${cand.label}]: ${e.message}`);
      if (e.status !== 400) throw e;
    }
  }
  if (!added) throw new Error("All candidate Effective $/hr expressions rejected.");

  // 4. Verify by re-fetching schema.
  console.log("\nVerifying schema...");
  const after = await notionFetch(`/databases/${DATABASE_ID}`);
  const totalHrs = after.properties["Total Hours"];
  const effRate = after.properties["Effective $/hr"];
  if (!totalHrs || totalHrs.type !== "formula") {
    throw new Error(`Total Hours not found or wrong type after PATCH: ${JSON.stringify(totalHrs)}`);
  }
  if (!effRate || effRate.type !== "formula") {
    throw new Error(`Effective $/hr not found or wrong type after PATCH: ${JSON.stringify(effRate)}`);
  }
  console.log(`  OK Total Hours: type=formula, expression=${totalHrs.formula.expression}`);
  console.log(`  OK Effective $/hr: type=formula, expression=${effRate.formula.expression}`);

  // 5. Spot-check: query for Orkin LLC and 1-2 others with populated Hours.
  //    The title property name is unknown; find it dynamically.
  const titlePropName = Object.entries(after.properties).find(([, v]) => v.type === "title")?.[0];
  console.log(`\nSpot-checking values via ${titlePropName ? `title="${titlePropName}"` : "(no title prop?)"}...`);

  // Pull up to 50 rows with any number in Inspection Hours; sort by last_edited_time.
  const query = await notionFetch(`/databases/${DATABASE_ID}/query`, "POST", {
    page_size: 50,
    filter: {
      property: "Inspection Hours",
      number: { is_not_empty: true },
    },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });

  const rows = query.results || [];
  console.log(`  ${rows.length} row(s) with Inspection Hours populated. Showing up to 5 with hours+formula values:`);

  let printed = 0;
  for (const row of rows) {
    if (printed >= 5) break;
    const p = row.properties;
    const titleArr = (titlePropName && p[titlePropName]?.title) || [];
    const title = titleArr.map((t) => t.plain_text || "").join("") || "(untitled)";
    const insp = p["Inspection Hours"]?.number;
    const photo = p["Photo Report Hours"]?.number;
    const sketch = p["Sketch Hours"]?.number;
    const est = p["Estimate Hours"]?.number;
    const narr = p["Narrative Hours"]?.number;
    const drive = p["Drive Hours"]?.number;
    const billed = p["Billed Amount"]?.number;
    const totalFormula = p["Total Hours"]?.formula?.number;
    const rateFormula = p["Effective $/hr"]?.formula?.number;
    console.log(`  - ${title}`);
    console.log(`      hours: insp=${fmtNumber(insp)} photo=${fmtNumber(photo)} sketch=${fmtNumber(sketch)} est=${fmtNumber(est)} narr=${fmtNumber(narr)} drive=${fmtNumber(drive)}`);
    console.log(`      Total Hours (formula) = ${fmtNumber(totalFormula)}`);
    console.log(`      Billed Amount = ${fmtNumber(billed)}, Effective $/hr (formula) = ${fmtNumber(rateFormula)}`);
    printed++;
  }
  if (printed === 0) console.log("  (no spot-check rows found)");

  // 6. Ntfy confirmation.
  await ntfy("[NOTION] Total Hours and Effective $/hr formulas live");

  console.log("\nDone.");
})().catch((e) => {
  console.error("FAILED:", e.message);
  if (e.body) console.error("Body:", e.body);
  process.exit(1);
});
