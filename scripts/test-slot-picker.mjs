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
    let line = `  • ${s.weekday} ${s.date}  ${s.start_label} – ${s.end_label}  [${s.rationale}]`;
    if (s.adjacent_event) {
      line += `  adj→ ${s.adjacent_event.summary ?? "(no title)"} @ ${s.adjacent_event.location ?? "?"}`;
    }
    console.log(line);
    if (s.prev_event_with_location) {
      console.log(`      prev: ${s.prev_event_with_location.summary ?? "(no title)"} @ ${s.prev_event_with_location.location} (ends ${s.prev_event_with_location.end})`);
    }
    if (s.next_event_with_location) {
      console.log(`      next: ${s.next_event_with_location.summary ?? "(no title)"} @ ${s.next_event_with_location.location} (starts ${s.next_event_with_location.start})`);
    }
  }
}
