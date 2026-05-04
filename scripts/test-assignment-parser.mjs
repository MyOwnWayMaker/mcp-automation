import { parseAssignmentEmail } from "../dist/tools/assignment_email.js";

// Real fixtures captured from the inbox 2026-05-03.

const fixtures = [
  {
    name: "PCS Adjusting (FileTrac template)",
    expect: { sender_kind: "filetrac_template", platform: "filetrac", claim_number: "81030678", carrier: "DB Insurance Company", has_address: true, insured_phone: "323-314-7963" },
    email: {
      from: "info@pcsadj.com",
      subject: "New Claim Assignment - File #81030678",
      body: `<p><b>File #</b><a target='_BLANK' href='https://claims.filetrac.net/system/claimList.asp?allBranches=1&searchType=claimFileID&searchTgt=81030678'><b>81030678</b></a> has been assigned to you.</p><p><font size='4'><b>Claim Information</b></font></p>Client Company: DB Insurance Company<br>Client Name: Ashley  Wood<br>File #: 81030678<br>Secondary File #: <br>Client Claim #: 1095887<br>Date Received: 4/21/2026<br>Special Instructions: <br><br><b>Primary Insured's Information</b><br>First Name: OSCAR RUIZ<br>Last Name: RAMIREZ<br>Company: <br>Email: <br>Policy Type: <br>Policy #: 02031009277<br>Phone #: 323-314-7963<br>Alternate Phone #: <br>Street Address: <br>Address 2: <br>City: <br>State:  <br>Zip: <br>Loss Address:<br>Street Address: 1257 E 76TH PL<br>Address 2: <br>City: LOS ANGELES<br>State: CA<br>Zip:90001-2418<br><br><b>Claimant Information (if applicable)</b><br>First Name: <br>Last Name: <br>Company: <br>Email: <br>Phone: <br>Street Address: <br>Address 2: <br>City:  <br>State:  <br>Zip: <br><br><b>Loss Information</b><br>Date of Loss: 10/25/2025<br>Type of Loss: VEHICLE DAMAGE<br>Unit: <br>Loss Description: Someone's car hit the insured's fence.<br>`,
    },
  },
  {
    name: "US Claim Solutions (FileTrac template, commercial insured)",
    expect: { sender_kind: "filetrac_template", platform: "filetrac", claim_number: "US226107", carrier: "HCC Casualty Insurance Services", has_address: true, insured_name: "Pure Water for Life" },
    email: {
      from: "newclaim@usclaimsolutions.co",
      subject: "New Claim Assignment - File #US226107",
      body: `<p><b>File #</b><a target='_BLANK' href='https://data.filetrac.net/system/claimList.asp?allBranches=1&searchType=claimFileID&searchTgt=US226107'><b>US226107</b></a> has been assigned to you.</p><p><font size='4'><b>Claim Information</b></font></p>Client Company: HCC Casualty Insurance Services<br>Client Name: Annie Ramirez<br>File #: US226107<br>Secondary File #: <br>Client Claim #: ARC-25-11879<br>Date Received: 4/21/2026<br>Special Instructions: <br><br><b>Primary Insured's Information</b><br>First Name: <br>Last Name: <br>Company: Pure Water for Life<br>Email: <br>Policy Type: <br>Policy #: <br>Phone #: <br>Alternate Phone #: <br>Street Address: <br>Address 2: <br>City: <br>State:  <br>Zip: <br>Loss Address:<br>Street Address: 5278 Nettle Place<br>Address 2: <br>City: Fontana<br>State: CA<br>Zip:92336<br><br><b>Claimant Information (if applicable)</b><br>First Name: Jesse<br>Last Name: Astorge<br>Company: <br>Email: <br>Phone: <br>Street Address: <br>Address 2: <br>City:  <br>State:  <br>Zip: <br><br><b>Loss Information</b><br>Date of Loss: <br>Type of Loss: Property<br>Unit: Other<br>Loss Description: water intrusion<br>`,
    },
  },
  {
    name: "Xactware (XactAnalysis-driven)",
    expect: { sender_kind: "xactware_xa", platform: "xactanalysis", claim_number: "030665", carrier: "Fortegra", insured_name: "Kathleen Lowe or Margarita Patino" },
    email: {
      from: "donotreply@xactware.com",
      subject: "New Fortegra  Claim # 030665",
      body: `This email was sent from XactAnalysis on behalf of: Val Reuter Please email any replies to: vreuter@straightlineglobal.com Claim # - 030665 Property Owner - Kathleen Lowe or Margarita Patino Date of Loss - Apr 25, 2026 2:00:00 AM New Fortegra Claim # 030665 Field Adjuster Hakiel Mcqueen 424-235-5797 hakiel.mcqueen@erseville.com Justin Dean Fortegra Desk Adjuster jdean@fortegra.com Mainline: 800-888-2738 Direct: 904-659-5192 Attachments: EMBARK-DEC-DEC PAGE-NO CERT-20240820-RMH137581_412826889.pdf`,
    },
  },
  {
    name: "Associated Adjusting (AAN portal)",
    expect: { sender_kind: "aan_portal", platform: "aan", manual_fetch_required: true, email_kind: "new_assignment" },
    email: {
      from: 'Associated Adjusting APP - Claim Assignment <noreply@app.associatedadjusting.com>',
      subject: "AAN - New Claim Assignment",
      body: `<h3>Please DO NOT REPLY to this message!</h3><p>You have been assigned to a claim.  Please log in to see details of the claim.</p><p><a href="https://app.associatedadjusting.com/dashboards/adjuster">YOUR CLAIM DASHBOARD</a></p>`,
    },
  },
  {
    name: "AAN claim update (subject has number)",
    expect: { sender_kind: "aan_portal", platform: "aan", manual_fetch_required: true, email_kind: "status_update", claim_number: "1096275" },
    email: {
      from: 'Associated Adjusting APP - Claim Update <noreply@app.associatedadjusting.com>',
      subject: "AAN - Claim Update - 1096275",
      body: "<html><body><p>Hakiel McQueen,</p><p>SHOULD YOUR LOSS EXCEED $75,000...</p></body></html>",
    },
  },
  {
    name: "StraightLine Global supplement forward",
    expect: { sender_kind: "straightline", platform: "xactanalysis", claim_number: "KWSKWS26030053" },
    email: {
      from: "Claims <claims@straightlineglobal.com>",
      subject: "FW: KWSKWS26030053",
      body: "Good Morning Hakiel, Please see the below supplemental request.",
    },
  },
  {
    name: "Personal email (crr2day)",
    expect: { sender_kind: "personal", platform: "manual", claim_number: "25J13M991347" },
    email: {
      from: "Rollon Rhoane <crr2day@gmail.com>",
      subject: "Re: Cl# 25J13M991347 DOL 9/10/2025 - BR 497 PALM SPRINGS, CA",
      body: "Some reply text...",
    },
  },
];

let pass = 0, fail = 0;
for (const f of fixtures) {
  const r = parseAssignmentEmail(f.email);
  const errors = [];
  if (!r.ok) {
    errors.push(`parse error: ${r.error}`);
  } else {
    for (const [k, v] of Object.entries(f.expect)) {
      if (k === "has_address") {
        if (!r.loss_address || !r.loss_address.street) errors.push(`expected loss_address.street to be set`);
      } else if (r[k] !== v) {
        errors.push(`${k}: got ${JSON.stringify(r[k])} expected ${JSON.stringify(v)}`);
      }
    }
  }
  if (errors.length === 0) {
    pass++;
    console.log(`✓ ${f.name}`);
  } else {
    fail++;
    console.log(`✗ ${f.name}`);
    for (const e of errors) console.log(`  - ${e}`);
    if (r.ok) console.log(`  full result:\n${JSON.stringify(r, null, 2).split("\n").map(l => "    " + l).join("\n")}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed of ${fixtures.length}`);
process.exit(fail > 0 ? 1 : 0);
