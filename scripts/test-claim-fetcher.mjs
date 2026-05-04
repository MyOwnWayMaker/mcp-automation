import { parseAssignmentEmail } from "../dist/tools/assignment_email.js";
import { fetchClaimDetails } from "../dist/tools/claim_fetcher.js";

// Real PCS Adjusting fixture (FileTrac platform). Skip live fetch since
// we're just verifying the dispatch logic + fallback merge.

const email = {
  from: "info@pcsadj.com",
  subject: "New Claim Assignment - File #81030678",
  body: `<p><b>File #</b><a href='https://claims.filetrac.net/system/claimList.asp?searchTgt=81030678'><b>81030678</b></a> has been assigned to you.</p>Client Company: DB Insurance Company<br>File #: 81030678<br>Client Claim #: 1095887<br>Date Received: 4/21/2026<br><br><b>Primary Insured's Information</b><br>First Name: OSCAR RUIZ<br>Last Name: RAMIREZ<br>Phone #: 323-314-7963<br>Loss Address:<br>Street Address: 1257 E 76TH PL<br>City: LOS ANGELES<br>State: CA<br>Zip:90001-2418<br><br><b>Loss Information</b><br>Date of Loss: 10/25/2025<br>Type of Loss: VEHICLE DAMAGE<br>`,
};

console.log("--- Parsed email (B1) ---");
const parsed = parseAssignmentEmail(email);
console.log(JSON.stringify(parsed, null, 2));

if (!parsed.ok) {
  console.error("\nParse failed");
  process.exit(1);
}

console.log("\n--- Fetched details (B2, refresh=false to skip live fetch) ---");
const details = await fetchClaimDetails({
  platform: parsed.platform,
  claim_number: parsed.claim_number,
  fallback: parsed,
  refresh: false,
});
console.log(JSON.stringify(details, null, 2));

if (!details.ok) {
  console.error("\nFetch failed");
  process.exit(1);
}

// Sanity check: details should carry forward the fallback fields
const checks = [
  ["claim_number", "81030678"],
  ["carrier", "DB Insurance Company"],
  ["insured_name", "OSCAR RUIZ RAMIREZ"],
  ["insured_phone", "323-314-7963"],
  ["platform", "filetrac"],
];
let pass = 0, fail = 0;
for (const [k, v] of checks) {
  if (details[k] === v) { pass++; console.log(`✓ ${k} = ${v}`); }
  else { fail++; console.log(`✗ ${k} = ${JSON.stringify(details[k])} expected ${JSON.stringify(v)}`); }
}
if (details.loss_address?.street === "1257 E 76TH PL") { pass++; console.log("✓ loss_address.street propagated"); }
else { fail++; console.log(`✗ loss_address.street: got ${JSON.stringify(details.loss_address)}`); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
