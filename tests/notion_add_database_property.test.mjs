// Round-trip test for notion_add_database_property formula support.
// Run after `npm run build` with: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { buildPropertyDef } from "../dist/tools/notion.js";

test("buildPropertyDef: number with default format", () => {
  const def = buildPropertyDef({ property_type: "number" });
  assert.deepEqual(def, { number: { format: "number" } });
});

test("buildPropertyDef: number with dollar format", () => {
  const def = buildPropertyDef({ property_type: "number", number_format: "dollar" });
  assert.deepEqual(def, { number: { format: "dollar" } });
});

test("buildPropertyDef: select", () => {
  assert.deepEqual(buildPropertyDef({ property_type: "select" }), { select: { options: [] } });
});

test("buildPropertyDef: formula round-trips expression verbatim", () => {
  const expr = 'prop("A") + prop("B")';
  const def = buildPropertyDef({ property_type: "formula", formula_expression: expr });
  assert.deepEqual(def, { formula: { expression: expr } });
});

test("buildPropertyDef: formula preserves complex if/empty expression", () => {
  const expr = 'if(empty(prop("Billed Amount")) or prop("Total Hours") == 0, 0, prop("Billed Amount") / prop("Total Hours"))';
  const def = buildPropertyDef({ property_type: "formula", formula_expression: expr });
  assert.equal(def.formula.expression, expr);
});

test("buildPropertyDef: formula throws when expression is missing", () => {
  assert.throws(
    () => buildPropertyDef({ property_type: "formula" }),
    /formula_expression is required/
  );
});

test("buildPropertyDef: formula throws when expression is whitespace only", () => {
  assert.throws(
    () => buildPropertyDef({ property_type: "formula", formula_expression: "   " }),
    /formula_expression is required/
  );
});

test("buildPropertyDef: rejects unsupported type", () => {
  assert.throws(
    () => buildPropertyDef({ property_type: "files" }),
    /Unsupported property type/
  );
});
