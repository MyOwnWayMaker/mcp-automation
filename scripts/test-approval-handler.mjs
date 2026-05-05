// D2 smoke test: skip_sms + skip_notion so we only test the calendar branch.
// Creates a real calendar event but skips the actual SMS send (no spam to insured).
import { handleClaimApproval } from "../dist/tools/approval_handler.js";
import { draftInspectionSms } from "../dist/tools/sms_drafter.js";

// Use a TEST date 60 days out + a fake "TEST" insured so we don't pollute
// the real claim calendar. Caller can delete the resulting event after.
const slot_start = "2026-07-04T07:00:00-07:00";
const slot_end   = "2026-07-04T08:00:00-07:00";

const drafted = draftInspectionSms({
  insured_first_names: ["TestInsured"],
  slot_start,
  slot_end,
});
if (!drafted.ok) { console.error(drafted.error); process.exit(1); }

const result = await handleClaimApproval({
  insured_phone: "+15551234567",
  sms_text: drafted.sms_text,
  insured_name: "TEST CLAIMANT — please delete",
  carrier: "TEST CARRIER",
  client: "TEST CLIENT",
  claim_number: "TEST-D2-SMOKE",
  policy_number: "TEST-POL",
  examiner_name: "Test Examiner",
  examiner_email: "test@example.com",
  examiner_phone: "555-555-5555",
  loss_address: "1226 LA CRESTA DR, LA HABRA HEIGHTS, CA 90631",
  slot_start,
  slot_end,
  special_instructions: "TEST RUN — D2 smoke test, please delete this event.",
  // Skip the actual SMS send and Notion log — only validate calendar branch.
  skip_sms: true,
  skip_notion: true,
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
