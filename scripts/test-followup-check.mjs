// D3 smoke test — fires a [FOLLOWUP] ntfy alert for a fake "TEST" claim.
// Uses force_fire so we don't wait 3 hours, and uses a non-existent
// thread_id so voice_get_thread returns no inbound messages.
import { checkFollowupDue } from "../dist/tools/followup_check.js";

const result = await checkFollowupDue({
  // Fake phone — voice_get_thread will find no inbound replies because
  // the thread doesn't exist.
  insured_phone: "+15555550199",
  sent_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),  // 1 hr ago
  insured_name: "TEST FOLLOWUP — please ignore",
  force_fire: true,                                                // skip 3hr threshold
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
