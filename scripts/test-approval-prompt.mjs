// Live ntfy smoke test for D1 — sends a real approval prompt to
// dino-claims-alerts-fpx for the Eric Zhang 5/7 inspection. Hakiel will
// see it on his phone via the iOS Dispatch app.
import { sendApprovalPrompt } from "../dist/tools/approval_prompt.js";
import { draftInspectionSms } from "../dist/tools/sms_drafter.js";

const slot_start = "2026-05-07T11:00:00-07:00";
const slot_end   = "2026-05-07T12:00:00-07:00";

const drafted = draftInspectionSms({
  insured_first_names: ["Eric"],
  slot_start,
  slot_end,
});
if (!drafted.ok) { console.error(drafted.error); process.exit(1); }

const result = await sendApprovalPrompt({
  insured_name: "Eric Zhang",
  carrier: "DB Insurance Company",
  client: "Premier Claims",
  claim_number: "1095281",
  file_number: "81030440",
  claim_phone: "415-385-7761",
  loss_address: "1226 LA CRESTA DR, LA HABRA HEIGHTS, CA 90631-8530",
  sms_text: drafted.sms_text,
  slot: {
    date: "2026-05-07",
    weekday: "Thu",
    start_label: "11:00 AM",
    end_label: "12:00 PM",
    rationale: "earliest_free",
    feasible: true,
    prev_event_with_location: undefined,  // no prior trip on 5/7 morning
    prev_leg: undefined,
    next_event_with_location: undefined,
    next_leg: undefined,
  },
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
