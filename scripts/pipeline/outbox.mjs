// outbox.mjs — the approval-gated outbound-SMS queue shared by the pipeline
// proposer (writes proposals), the outbox runner (consumes approvals + sends),
// and the SMS monitor (pushes counter-offer reply drafts).
//
// State file: data/sms_outbox.json
//   {
//     next_id: 7,                    // short numeric ids for the approval grammar
//     ntfy_cursor: "m4XyZ...",       // last-seen ntfy message id (approval poll)
//     proposals: [ <proposal> ]
//   }
//
// Proposal lifecycle (status):
//   awaiting_approval → approved → sent
//                     ↘ skipped            (Hakiel: "skip <id>")
//                     ↘ stale              (approved too late; slot no longer offerable)
//   sent → awaiting_manual_send            (send failed after retries; Hakiel sends by hand)
//
// A proposal is the ONLY path to an outbound voice_send_sms in the automated
// loop — every entry requires Hakiel's explicit per-action approval on the
// ntfy topic (TOP RULE: no third-party writes without per-action confirmation).
//
// Shape (fields the runner/monitor rely on):
//   {
//     id: 3,                          // approval grammar target: "send 3"
//     kind: "new_assignment" | "reinspection" | "counter_reply" | "cms_note",
//     status: "awaiting_approval" | ...,
//     created_iso, decided_iso?, sent_iso?,
//     insured_name, to_phone,        // E.164 or 10-digit; POC (the insured)
//     thread_id?,                    // set for counter_reply — send into thread
//     draft_text,                    // the exact text to send (or note to post)
//     slots: [{start, end, date, label}],   // slot 1 = primary; grammar "slot N"
//     chosen_slot_index: 0,
//     claim: {
//       ia_firm, company_index?, ft_internal_claim_id?, file_number?,
//       claim_number?, carrier_claim_number?, loss_address?, quadrant?,
//       distance_miles?, drive_folder_url?, queststar_row_id?,
//       first_contact_on_send: true|false,   // false for reinspection kind
//     },
//     claim_context: {...},          // rich blob for sms-register-pending
//     approval?: { raw, received_iso, slot_index },
//     send_result?: {...},
//     history: ["..."],              // one-line audit trail
//   }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "../..");

export const OUTBOX_PATH =
  process.env.SMS_OUTBOX_PATH ?? path.join(REPO_ROOT, "data/sms_outbox.json");

export const APPROVALS_TOPIC =
  process.env.CLAIM_APPROVALS_NTFY_TOPIC ?? "hakiel-claim-approvals";

export function loadOutbox(p = OUTBOX_PATH) {
  if (!fs.existsSync(p)) return { next_id: 1, ntfy_cursor: "", proposals: [] };
  try {
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    return { next_id: 1, ntfy_cursor: "", proposals: [], ...o };
  } catch {
    // Never clobber a corrupt file silently — surface loudly and start fresh
    // in-memory; the save path writes a .corrupt backup first.
    return { next_id: 1, ntfy_cursor: "", proposals: [], _load_error: true };
  }
}

export function saveOutbox(outbox, p = OUTBOX_PATH) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (outbox._load_error && fs.existsSync(p)) {
    fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`);
  }
  const { _load_error, ...clean } = outbox;
  fs.writeFileSync(p, JSON.stringify(clean, null, 2));
}

/**
 * Idempotency key for "one open proposal per claim". file_number is the most
 * stable identifier across re-runs; phone is the fallback for portals without
 * file numbers.
 */
export function proposalClaimKey(p) {
  return p?.claim?.file_number ?? p?.claim?.claim_number ?? p?.to_phone ?? null;
}

export function findOpenProposal(outbox, claimKey, kind = null) {
  if (!claimKey) return null;
  return outbox.proposals.find(p =>
    ["awaiting_approval", "approved", "awaiting_manual_send"].includes(p.status)
    && (kind === null || p.kind === kind)
    && proposalClaimKey(p) === String(claimKey)) ?? null;
}

export function addProposal(outbox, proposal) {
  const id = outbox.next_id;
  outbox.next_id = id + 1;
  const full = {
    id,
    status: "awaiting_approval",
    created_iso: new Date().toISOString(),
    chosen_slot_index: 0,
    history: [],
    ...proposal,
  };
  full.history.push(`${full.created_iso} created (${full.kind})`);
  outbox.proposals.push(full);
  return full;
}

// ─── ntfy ────────────────────────────────────────────────────────────────────

// ntfy titles ride an HTTP header — non-ASCII (em-dashes etc.) crashes fetch.
export function asciiHeader(s) {
  return String(s ?? "")
    .replace(/[—–]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, "?");
}

export async function ntfyPublish({ topic, title, body, priority = "default", tags = "" }) {
  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      Title: asciiHeader(title),
      Priority: priority,
      ...(tags ? { Tags: tags } : {}),
    },
    body,
  });
  if (!res.ok) throw new Error(`ntfy ${topic} → ${res.status}`);
  return true;
}

/**
 * Poll an ntfy topic's JSON endpoint for messages newer than the cursor.
 * Returns { messages: [{id, time, message}], cursor } — cursor is the last
 * message id seen (pass back on the next poll). ntfy retains messages ~12h,
 * plenty for a 5-min poll loop.
 */
export async function ntfyPoll({ topic, since }) {
  const sinceParam = since ? encodeURIComponent(since) : "all";
  const res = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=${sinceParam}`);
  if (!res.ok) throw new Error(`ntfy poll ${topic} → ${res.status}`);
  const text = await res.text();
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.event === "message" && typeof m.message === "string") {
        messages.push({ id: m.id, time: m.time, message: m.message });
      }
    } catch { /* skip malformed line */ }
  }
  const cursor = messages.length ? messages[messages.length - 1].id : since;
  return { messages, cursor };
}

// ─── Approval-command grammar ────────────────────────────────────────────────

/**
 * Parse one ntfy message into an approval command, or null when it isn't one
 * (the topic may carry our own outbound prompts — those never match).
 *   "send 3"               → { verb: "send", id: 3, slot_index: 0 }
 *   "send 3 slot 2"        → { verb: "send", id: 3, slot_index: 1 }
 *   "edit 3: <full text>"  → { verb: "edit", id: 3, text: "<full text>" }
 *   "skip 3"               → { verb: "skip", id: 3 }
 */
export function parseApprovalCommand(raw) {
  const s = String(raw ?? "").trim();
  let m = s.match(/^send\s+#?(\d+)(?:\s+slot\s+(\d+))?\s*$/i);
  if (m) return { verb: "send", id: Number(m[1]), slot_index: m[2] ? Number(m[2]) - 1 : 0 };
  m = s.match(/^edit\s+#?(\d+)\s*:\s*([\s\S]+)$/i);
  if (m) return { verb: "edit", id: Number(m[1]), text: m[2].trim() };
  m = s.match(/^skip\s+#?(\d+)\s*$/i);
  if (m) return { verb: "skip", id: Number(m[1]) };
  return null;
}

/**
 * Staleness: an approved slot must still be offerable — its start must be
 * at least `minLeadMs` (default 2h) in the future. Text-only entries
 * (counter replies, CMS notes) have no slot and are never stale.
 */
export function isProposalStale(proposal, slotIndex = 0, now = new Date(), minLeadMs = 2 * 60 * 60 * 1000) {
  const slot = proposal.slots?.[slotIndex];
  if (!slot?.start) return false;
  const start = new Date(slot.start);
  if (isNaN(start.getTime())) return false;
  return start.getTime() - now.getTime() < minLeadMs;
}
