import { createClaimDriveFolder } from "../dist/tools/claim_drive_folder.js";

console.log("=== TEST 1: Re-create Eric Zhang folder (should be idempotent) ===");
const t1 = await createClaimDriveFolder({
  request_date: "2026-05-07",
  insured_name: "Eric Zhang",
  client_short: "PCAS",
  carrier_short: "DBI",
  loss_type: "Water",
});
console.log(JSON.stringify(t1, null, 2));
if (!t1.ok) process.exit(1);
if (!t1.already_existed) {
  console.error("\n✗ Expected already_existed=true for Eric Zhang folder built earlier");
  process.exit(1);
}
console.log("✓ Idempotent — folder already existed.\n");

console.log("=== TEST 2: New supplement folder for fictional 'Test Supplement' ===");
const t2 = await createClaimDriveFolder({
  request_date: "2026-05-04",
  insured_name: "TEST SUPPLEMENT — please delete",
  client_short: "TEST",
  carrier_short: "TEST",
  loss_type: "Water",
  work_type: "supplement",
});
console.log(JSON.stringify(t2, null, 2));
if (!t2.ok) process.exit(1);
console.log(`✓ Created at: ${t2.path}`);
console.log(`  Claim folder ID: ${t2.claim_folder.id}`);
console.log(`  Photos subfolder ID: ${t2.photos_folder.id}`);
console.log(`\nDelete this with the Drive UI or drive_delete_file when done.`);
