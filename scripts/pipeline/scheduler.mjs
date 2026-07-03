// scheduler.mjs — post-filing proposer stage of the claim pipeline.
//
// After a new assignment is filed (Drive folder + Queststar mirror), this
// module prepares everything needed to schedule the inspection and parks it
// behind Hakiel's approval gate:
//
//   1. Resolve the FileTrac INTERNAL claimID (list_claims match on File #) —
//      the date-write tools only accept the internal id, never the File #.
//   2. Geocode the loss + quadrant + calendar scan + pickInspectionSlots
//      (furthest-first routing and busy blocks live inside the picker).
//   3. draftInspectionSms (includes the "tomorrow," wording rule).
//   4. Write an outbox proposal (data/sms_outbox.json) and ntfy the approval
//      prompt to the approvals topic.
//
// NOTHING is sent from here. The outbox runner (scripts/sms-outbox-runner.mjs)
// sends only after Hakiel replies "send <id>" on the topic. The approval
// prompt discloses that approving the send also sets First Date of Contact
// (new assignments only — reinspections never touch date fields).
//
// Soft-fail contract: every gap (no POC phone, no slots, FT session down)
// returns { skipped } and ntfys a flag — never throws into the orchestrator.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadOutbox, saveOutbox, addProposal, findOpenProposal,
  ntfyPublish, APPROVALS_TOPIC,
} from "./outbox.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "../..");
const DIST = process.env.PIPELINE_DIST ?? path.join(REPO_ROOT, "dist");

let _tools;
async function schedTools() {
  if (_tools) return _tools;
  const [{ pickInspectionSlots }, { draftInspectionSms }, { filetracListClaims }] =
    await Promise.all([
      import(`${DIST}/tools/slot_picker.js`),
      import(`${DIST}/tools/sms_drafter.js`),
      import(`${DIST}/tools/filetrac.js`),
    ]);
  _tools = { pickInspectionSlots, draftInspectionSms, filetracListClaims };
  return _tools;
}

function callText(r) {
  return r?.content?.find(c => c.type === "text")?.text ?? "";
}

// Same regex as orchestrator.extractClaimIdByFileNumber (duplicated to keep
// the import graph acyclic — orchestrator imports THIS module).
function extractClaimIdByFileNumber(listText, fileNumber) {
  if (!fileNumber) return null;
  const fn = String(fileNumber);
  const re = new RegExp(`File #:\\s*${fn.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\|\\s*Claim ID:\\s*(\\d+)`, "i");
  return listText.match(re)?.[1] ?? null;
}

export function formatAddressString(a) {
  if (!a) return null;
  if (typeof a === "string") return a;
  return [a.street, a.address2, a.city, a.state, a.zip].filter(Boolean).join(", ") || null;
}

function normalizePhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function slotLabel(s) {
  return `${s.weekday} ${s.date} ${s.start_label}-${s.end_label}`;
}

/** Build the rich claim_context blob consumed by sms-register-pending. */
export function buildClaimContext({ parsed, folderResult, lossAddressStr }) {
  const da = parsed.desk_adjuster ?? {};
  return {
    loss_type: parsed.loss_type ?? null,
    loss_description: parsed.loss_description ?? null,
    date_of_loss: parsed.date_of_loss ?? null,
    claim_number: parsed.carrier_claim_number ?? null,
    file_number: parsed.claim_number ?? null,
    loss_address: lossAddressStr,
    insured_email: parsed.insured_email ?? null,
    da_name: da.name ?? null,
    da_email: da.email ?? null,
    da_phone: da.phone ?? null,
    drive_folder_url: folderResult?.claim_folder?.link ?? null,
    drive_folder_id: folderResult?.claim_folder?.id ?? null,
  };
}

/** Compose the approval-prompt ntfy body. Everything Hakiel needs to say yes. */
export function buildApprovalPrompt(p, topic = APPROVALS_TOPIC) {
  const c = p.claim;
  const slotLines = p.slots.map((s, i) =>
    `Slot ${i + 1}${i === 0 ? " (primary)" : ""}: ${s.label}`);
  const dateWriteLine = c.first_contact_on_send
    ? `Approving SEND also sets First Date of Contact (${c.ia_firm ?? "CMS"}) on verified send.`
    : `Re-inspection: no CMS date fields will be touched.`;
  return [
    `${c.loss_address ?? "?"}${c.quadrant ? ` — ${c.quadrant}` : ""}${c.distance_miles != null ? `, ${c.distance_miles} mi` : ""}`,
    `POC: ${p.insured_name} ${p.to_phone}`,
    slotLines.join("\n"),
    `--- DRAFT ---`,
    p.draft_text,
    `--- REPLY ON '${topic}' ---`,
    `send ${p.id}   |   send ${p.id} slot 2   |   edit ${p.id}: <new text>   |   skip ${p.id}`,
    dateWriteLine,
  ].join("\n\n");
}

/**
 * The proposer. Called by the orchestrator after a new assignment files
 * successfully (and by processSupplement for re-inspections, kind override).
 *
 * Returns a summary object that rides in the pipeline run result:
 *   { proposed: {id, slots, to_phone} } | { skipped, detail? }
 */
export async function proposeInspectionSms({
  msg, parsed, folderResult, insured, client_short, loss_type,
  company_index = null, ft_internal_claim_id = null, queststar_row_id = null,
  kind = "new_assignment", dryRun = false,
}) {
  const t = await schedTools();

  const lossAddressStr = formatAddressString(parsed.loss_address);
  if (!lossAddressStr) return { skipped: "no-loss-address" };

  const to_phone = normalizePhone(parsed.insured_phone) ?? normalizePhone(parsed.insured_alt_phone);
  if (!to_phone) {
    if (!dryRun) await flagGap({ insured, client_short, reason: "No POC phone on the assignment — schedule manually." });
    return { skipped: "no-poc-phone" };
  }

  // One open proposal per claim — the 15-min cron re-runs held claims.
  const outbox = loadOutbox();
  const claimKey = parsed.claim_number ?? parsed.carrier_claim_number ?? to_phone;
  const existing = findOpenProposal(outbox, claimKey);
  if (existing) return { skipped: "proposal-already-open", proposal_id: existing.id };

  // FileTrac internal claimID — needed later for the First Contact /
  // inspection-date writes. Resolve now while we have the File #; a miss is
  // non-fatal (the runner just skips the date write and says so in its ntfy).
  let ftId = ft_internal_claim_id;
  if (!ftId && company_index != null && parsed.claim_number) {
    try {
      const listText = callText(await t.filetracListClaims({ company_index, max_results: 50, include_closed: false }));
      ftId = extractClaimIdByFileNumber(listText, parsed.claim_number);
    } catch { /* FT down — runner re-resolves at send time */ }
  }

  // Slots. The picker geocodes + classifies quadrant + walks the calendar.
  const picked = await t.pickInspectionSlots({ loss_address: lossAddressStr, max_slots: 3 });
  if (!picked.ok || !picked.slots?.length) {
    if (!dryRun) await flagGap({ insured, client_short, reason: `No inspection slots found (${picked.ok ? "calendar full" : picked.error}) — schedule manually.` });
    return { skipped: "no-slots", detail: picked.ok ? "no-candidates" : picked.error };
  }
  const slots = picked.slots.map(s => ({
    start: s.start, end: s.end, date: s.date,
    label: slotLabel(s), rationale: s.rationale,
  }));

  // Draft against the primary slot ("tomorrow," rule lives in the drafter).
  const draft = t.draftInspectionSms({
    insured_name: insured,
    slot_start: slots[0].start,
    slot_end: slots[0].end,
  });
  if (!draft.ok) return { skipped: "draft-failed", detail: draft.error };

  const proposal = {
    kind,
    insured_name: insured,
    to_phone,
    draft_text: draft.sms_text,
    slots,
    claim: {
      ia_firm: client_short ?? null,
      company_index,
      ft_internal_claim_id: ftId,
      file_number: parsed.claim_number ?? null,
      carrier_claim_number: parsed.carrier_claim_number ?? null,
      loss_address: lossAddressStr,
      quadrant: picked.loss?.quadrant ?? null,
      distance_miles: picked.loss?.distance_miles_from_home ?? null,
      loss_type: loss_type ?? null,
      drive_folder_url: folderResult?.claim_folder?.link ?? null,
      queststar_row_id,
      first_contact_on_send: kind === "new_assignment",
    },
    claim_context: buildClaimContext({ parsed, folderResult, lossAddressStr }),
    source_message_id: msg?.id ?? null,
  };

  if (dryRun) {
    return { proposed_dry_run: { ...proposal, prompt_preview: buildApprovalPrompt({ id: "?", ...proposal }) } };
  }

  const full = addProposal(outbox, proposal);
  saveOutbox(outbox);

  await ntfyPublish({
    topic: APPROVALS_TOPIC,
    title: `Approval needed - SMS to ${insured} (${client_short ?? "?"} ${parsed.claim_number ?? ""})`,
    body: buildApprovalPrompt(full),
    priority: "high",
    tags: "incoming_envelope",
  }).catch(() => { /* prompt failure must not un-file the claim; runner re-prompts */ });

  return { proposed: { id: full.id, to_phone, slots: slots.map(s => s.label) } };
}

async function flagGap({ insured, client_short, reason }) {
  await ntfyPublish({
    topic: APPROVALS_TOPIC,
    title: `Scheduling gap - ${insured} (${client_short ?? "?"})`,
    body: reason,
    priority: "high",
    tags: "warning",
  }).catch(() => {});
}
