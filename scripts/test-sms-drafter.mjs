import { draftInspectionSms } from "../dist/tools/sms_drafter.js";

const cases = [
  {
    label: "Single insured, top-of-hour slot",
    args: { insured_name: "OSCAR RUIZ RAMIREZ", slot_start: "2026-05-05T07:00:00-07:00", slot_end: "2026-05-05T08:00:00-07:00" },
    expect_date: "Tuesday May 5th",
    expect_time: "7am-8am",
    expect_first: "Oscar",
  },
  {
    label: "Two insureds slash-delimited",
    args: { insured_name: "Kathleen Lowe / Margarita Patino", slot_start: "2026-05-05T07:00:00-07:00", slot_end: "2026-05-05T08:00:00-07:00" },
    expect_first: "Kathleen and Margarita",
    expect_date: "Tuesday May 5th",
    expect_time: "7am-8am",
  },
  {
    label: "Three insureds (explicit array)",
    args: { insured_first_names: ["Kathleen", "Margarita", "Carlos"], slot_start: "2026-05-12T13:00:00-07:00", slot_end: "2026-05-12T14:00:00-07:00" },
    expect_first: "Kathleen, Margarita, and Carlos",
    expect_date: "Tuesday May 12th",
    expect_time: "1pm-2pm",
  },
  {
    label: "11th — ordinal -th not -st",
    args: { insured_first_names: ["Joe"], slot_start: "2026-05-11T09:00:00-07:00", slot_end: "2026-05-11T10:00:00-07:00" },
    expect_date: "Monday May 11th",
    expect_first: "Joe",
    expect_time: "9am-10am",
  },
  {
    label: "23rd ordinal",
    args: { insured_first_names: ["Lisa"], slot_start: "2026-05-23T08:00:00-07:00", slot_end: "2026-05-23T09:00:00-07:00" },
    expect_date: "Saturday May 23rd",
    expect_time: "8am-9am",
  },
  {
    label: "Half-hour adjacency slot — should keep colon",
    args: { insured_first_names: ["Raymond"], slot_start: "2026-05-04T10:30:00-07:00", slot_end: "2026-05-04T11:30:00-07:00" },
    expect_time: "10:30am-11:30am",
  },
  {
    label: "Crossing noon",
    args: { insured_first_names: ["Sam"], slot_start: "2026-05-05T11:00:00-07:00", slot_end: "2026-05-05T12:00:00-07:00" },
    expect_time: "11am-12pm",
  },
  {
    label: "Afternoon slot",
    args: { insured_first_names: ["Eric"], slot_start: "2026-05-07T13:00:00-07:00", slot_end: "2026-05-07T14:00:00-07:00" },
    expect_time: "1pm-2pm",
    expect_date: "Thursday May 7th",
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  console.log(`\n— ${c.label}`);
  const r = draftInspectionSms(c.args);
  if (!r.ok) {
    console.log(`  ✗ FAIL: ${r.error}`);
    fail++;
    continue;
  }
  let caseFail = false;
  for (const [field, expected] of [["first_name_or_names", c.expect_first], ["proposed_date", c.expect_date], ["proposed_time_frame", c.expect_time]]) {
    if (expected === undefined) continue;
    if (r[field] === expected) {
      console.log(`  ✓ ${field} = ${expected}`);
    } else {
      console.log(`  ✗ ${field} = ${JSON.stringify(r[field])}  expected ${JSON.stringify(expected)}`);
      caseFail = true;
    }
  }
  if (caseFail) { fail++; } else {
    pass++;
    console.log("  --- rendered SMS ---");
    console.log(r.sms_text.split("\n").map(l => "  " + l).join("\n"));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
