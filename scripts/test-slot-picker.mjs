import { pickInspectionSlots } from "../dist/tools/slot_picker.js";

// Real-ish loss address — try a Pasadena address (E quadrant) and a
// Tarzana address (W quadrant) to see how the picker chooses.
const cases = [
  { label: "S quadrant — Inglewood", address: "1 W Manchester Blvd, Inglewood, CA 90301" },
  { label: "E quadrant — Pasadena", address: "300 E Green St, Pasadena, CA 91101" },
  { label: "N quadrant — Santa Clarita", address: "27201 Tourney Rd, Valencia, CA 91355" },
];

for (const c of cases) {
  console.log("\n========================================================");
  console.log(`CASE: ${c.label}`);
  console.log(`Address: ${c.address}`);
  console.log("========================================================");
  const result = await pickInspectionSlots({
    loss_address: c.address,
    days: 3,
    max_slots: 5,
  });

  if (!result.ok) {
    console.error("FAIL:", result.error);
    continue;
  }

  console.log(`Loss → ${result.loss.formatted_address}`);
  console.log(`Quadrant: ${result.loss.quadrant}, ${result.loss.distance_miles_from_home} mi from home`);
  console.log(`Same-quadrant match in calendar: ${result.same_quadrant_match}`);
  console.log(`Considered days: ${result.considered_days.join(", ")}`);
  console.log(`Slots (${result.slots.length}):`);
  for (const s of result.slots) {
    const flag = s.feasible === false ? "✗ INFEASIBLE" : s.feasible === true ? "✓" : "-";
    let line = `  ${flag}  ${s.weekday} ${s.date}  ${s.start_label} – ${s.end_label}  [${s.rationale}]`;
    if (s.adjacent_event) {
      line += `  adj→ ${s.adjacent_event.summary ?? "(no title)"}`;
    }
    console.log(line);
    if (s.prev_leg) {
      const slack = Math.round(s.prev_leg.slack_seconds / 60);
      console.log(`      prev_leg: ${s.prev_leg.duration_text} drive (${s.prev_leg.distance_text}), ${slack}m slack`);
    }
    if (s.next_leg) {
      const slack = Math.round(s.next_leg.slack_seconds / 60);
      console.log(`      next_leg: ${s.next_leg.duration_text} drive (${s.next_leg.distance_text}), ${slack}m slack`);
    }
    if (s.infeasible_reason) console.log(`      reason: ${s.infeasible_reason}`);
  }
}
