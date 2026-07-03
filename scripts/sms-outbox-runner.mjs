#!/usr/bin/env node
/**
 * sms-outbox-runner.mjs — consumes Hakiel's approval replies and fires the
 * gated outbound SMS (plus the on-send CMS write-back).
 *
 * Loop (launchd com.hakiel.sms-outbox, every 5 min):
 *   1. Poll the approvals ntfy topic since the stored cursor.
 *   2. Parse commands: send <id> [slot N] | edit <id>: <text> | skip <id>.
 *   3. For a send: staleness-check the slot (>2h lead required) — a stale
 *      approval re-proposes fresh slots instead of texting a dead time.
 *   4. voiceSendSms (≤2 attempts; NEW-number picker can throttle — on failure
 *      the entry parks as awaiting_manual_send and Hakiel gets the exact text
 *      to send by hand; the thread id t.<E164> is deterministic so the reply
 *      monitor works either way).
 *   5. On verified send, for kind=new_assignment ONLY: write First Date of
 *      Contact (today, LA) to FileTrac via the INTERNAL claimID — only if the
 *      field is currently empty (read-before-write). PCAS/USCS = FileTrac;
 *      SLG/XA date writes are not wired yet (flagged in the ntfy instead).
 *      Per Hakiel 2026-07-01: First Contact is set on VERIFIED SEND, before
 *      the insured confirms. Re-inspections never touch date fields.
 *   6. Register the outbound in data/sms_tracker.json (sms-register-pending)
 *      so the 30-min monitor handles replies + the 2h no-reply check-back.
 *   7. ntfy a sent-summary quoting exactly what was sent + written.
 *
 * kind=cms_note entries (re-inspection agreement notes) post a FileTrac diary
 * note (visible_to_client:false) instead of an SMS — same approval gate.
 *
 * Env:
 *   CLAIM_APPROVALS_NTFY_TOPIC  default `hakiel-claim-approvals`
 *   SMS_OUTBOX_PATH             default data/sms_outbox.json
 *   OUTBOX_DRY_RUN=1            poll + parse but skip send/writes/ntfy
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  loadOutbox, saveOutbox, addProposal, parseApprovalCommand, isProposalStale,
  ntfyPoll, ntfyPublish, APPROVALS_TOPIC,
} from "./pipeline/outbox.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), "..");
for (const f of [".env.local", ".env"]) {
  const p = path.join(REPO, f);
  if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
}
const DIST = process.env.PIPELINE_DIST ?? path.join(REPO, "dist");
const DRY_RUN = process.env.OUTBOX_DRY_RUN === "1";
const LA_TZ = "America/Los_Angeles";

function callText(r) {
  return r?.content?.find(c => c.type === "text")?.text ?? "";
}
function asJson(r) {
  try { return JSON.parse(callText(r)); } catch { return null; }
}

let _tools;
async function tools() {
  if (_tools) return _tools;
  const [voice, ft, drafter] = await Promise.all([
    import(path.join(DIST, "tools/voice.js")),
    import(path.join(DIST, "tools/filetrac.js")),
    import(path.join(DIST, "tools/sms_drafter.js")),
  ]);
  _tools = {
    voiceSendSms: voice.voiceSendSms,
    voiceGetThread: voice.voiceGetThread,
    filetracGetClaim: ft.filetracGetClaim,
    filetracUpdateClaimDates: ft.filetracUpdateClaimDates,
    filetracAddNote: ft.filetracAddNote,
    draftInspectionSms: drafter.draftInspectionSms,
  };
  return _tools;
}

export function todayLA(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LA_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** "9am-10am" / "10:30am-11:30am" window string from slot ISO bounds (LA). */
export function windowFromSlot(slot) {
  const part = (iso) => {
    const d = new Date(iso);
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: LA_TZ, hour: "numeric", minute: "2-digit", hour12: true,
    }).formatToParts(d).map(x => [x.type, x.value]));
    const dp = (p.dayPeriod ?? "").replace(/\s/g, "").toLowerCase();
    return p.minute === "00" ? `${p.hour}${dp}` : `${p.hour}:${p.minute}${dp}`;
  };
  return `${part(slot.start)}-${part(slot.end)}`;
}

/** Read FileTrac's current First Contact value. null = unreadable. */
export function parseFirstContact(detailText) {
  const m = String(detailText ?? "").match(/Date of First Contact:[ \t]*(.*)/);
  if (!m) return null;
  const v = m[1].trim();
  return v === "" || /\(not set\)/i.test(v) ? "" : v;
}

/**
 * First Contact write-back (new assignments only; on verified send).
 * Only-if-empty: an existing date is never overwritten.
 * Returns a one-line outcome string for the ntfy summary.
 */
async function writeFirstContact(proposal) {
  const c = proposal.claim ?? {};
  if (!c.first_contact_on_send) return "First Contact: not applicable (re-inspection — dates untouched)";
  if (c.ia_firm === "SLG") return "First Contact: SKIPPED — XA write-back not wired (set manually in XA)";
  if (!c.ft_internal_claim_id || c.company_index == null) {
    return "First Contact: SKIPPED — no FileTrac internal claimID resolved (set manually)";
  }
  const t = await tools();
  // Read-before-write: never clobber an existing date.
  const detail = callText(await t.filetracGetClaim({
    claim_id: c.ft_internal_claim_id, company_index: c.company_index,
  }));
  const current = parseFirstContact(detail);
  if (current === null) return "First Contact: SKIPPED — could not read claim (FT session?)";
  if (current !== "") return `First Contact: already ${current} (left as-is)`;
  // First Contact = the day the ASSIGNMENT was received (Hakiel 2026-07-03),
  // regardless of when the approval fires. Send-day is only the fallback.
  const date = c.assignment_received ?? todayLA();
  await t.filetracUpdateClaimDates({
    claim_id: c.ft_internal_claim_id, company_index: c.company_index,
    first_contact_date: date,
  });
  return `First Contact: SET ${date} (FT claim ${c.ft_internal_claim_id})`;
}

/** Register the sent SMS with the reply monitor (sms-register-pending CLI). */
function registerWithMonitor(proposal, slot, sendIso) {
  const c = proposal.claim ?? {};
  const ctx = {
    ...(proposal.claim_context ?? {}),
    kind: proposal.kind,
    ia_firm: c.ia_firm,
    company_index: c.company_index,
    ft_internal_claim_id: c.ft_internal_claim_id,
    queststar_row_id: c.queststar_row_id,
    first_contact_on_send: c.first_contact_on_send,
  };
  const args = [
    path.join(REPO, "scripts/sms-register-pending.mjs"),
    "--thread", `t.${proposal.to_phone}`,
    "--contact", proposal.insured_name,
    "--claim", String(c.file_number ?? c.carrier_claim_number ?? proposal.to_phone),
    "--send-iso", sendIso,
    "--phone", proposal.to_phone,
    ...(c.ia_firm ? ["--ia-firm", c.ia_firm] : []),
    ...(c.company_index != null ? ["--company-index", String(c.company_index)] : []),
    ...(slot ? ["--proposed-date", slot.date, "--window", windowFromSlot(slot)] : []),
    "--claim-context-json", JSON.stringify(ctx),
  ];
  const r = spawnSync("node", args, { cwd: REPO, encoding: "utf8" });
  return r.status === 0
    ? "Monitor: registered (2h check-back armed)"
    : `Monitor: REGISTER FAILED (${(r.stderr || r.stdout || "").trim().slice(0, 120)})`;
}

/**
 * After a counter_reply goes out, sync the tracker entry:
 *   - accepted_slot set (we accepted THEIR time): the agreement completed at
 *     our send → update the entry's date/window and run the confirmation
 *     write-backs (calendar + Planned Inspection Date + Queststar) right now,
 *     using the monitor's own guarded helpers.
 *   - offered a new slot instead: update the entry's proposal fields so the
 *     monitor classifies their NEXT reply against the new offer.
 */
async function settleCounterReply(p) {
  const trackerPath = path.join(REPO, "data/sms_tracker.json");
  if (!fs.existsSync(trackerPath)) return "Monitor: tracker file missing — sync manually";
  const tracker = JSON.parse(fs.readFileSync(trackerPath, "utf8"));
  const entry = (tracker.pending ?? []).find(e =>
    (p.tracker_entry_id && e.id === p.tracker_entry_id) || e.thread_id === p.thread_id);
  if (!entry) return "Monitor: no tracker entry found for this thread — sync manually";

  const lines = [];
  if (p.accepted_slot) {
    entry.proposed_date_iso = p.accepted_slot.date_iso;
    entry.proposed_time_window = p.accepted_slot.window;
    entry.window_adjusted_from_reply = true;
    // The insured named this time and we just told them it works — that IS
    // the agreement. Run the confirm write-backs now (all guarded/once-only).
    const monitor = await import(path.join(REPO, "scripts/sms-monitor.mjs"));
    try {
      const cal = await monitor.createInspectionCalendarEvent(entry);
      if (cal?.event_id) { entry.calendar_event_id = cal.event_id; lines.push(`Calendar: event ${cal.event_id}`); }
      else lines.push(`Calendar: ${cal?.reason ?? "created"}`);
    } catch (e) { lines.push(`Calendar: ERROR ${String(e.message).slice(0, 80)}`); }
    try { lines.push(await monitor.writeInspectionDate(entry)); }
    catch (e) { lines.push(`FT date: WRITE FAILED (${String(e.message).slice(0, 80)})`); }
    try { lines.push(await monitor.updateQueststarOnConfirm(entry)); }
    catch (e) { lines.push(`Queststar: failed (${String(e.message).slice(0, 80)})`); }
    entry.resolved = true;
  } else if (p.slots?.[0]) {
    entry.proposed_date_iso = p.slots[0].date;
    entry.proposed_time_window = windowFromSlot(p.slots[0]);
    entry.two_hour_warned = false; // re-arm the check-back for the new offer
    entry.resolved = false;
    lines.push(`Monitor: entry re-armed for the new offer (${entry.proposed_date_iso} ${entry.proposed_time_window})`);
  }
  fs.writeFileSync(trackerPath, JSON.stringify(tracker, null, 2));
  return lines.join("\n") || "Monitor: tracker synced";
}

/**
 * `inspected <file#-or-name> [date]` — Hakiel reporting a COMPLETED
 * inspection. Sets the CMS completed date/time via the monitor's shared
 * writer (FT date for PCAS/USCS, XA Site Inspected date+time for SLG),
 * ledgers it so the calendar sweep doesn't redo it. Date defaults to today.
 */
async function handleInspectedCommand(cmd) {
  const monitor = await import(path.join(REPO, "scripts/sms-monitor.mjs"));

  let dateIso;
  if (!cmd.date) {
    dateIso = todayLA();
  } else if (/^\d{4}-/.test(cmd.date)) {
    dateIso = cmd.date;
  } else {
    const [mm, dd, yy] = cmd.date.split("/");
    const y = yy ? (yy.length === 2 ? `20${yy}` : yy) : String(new Date().getFullYear());
    dateIso = `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  const trackerPath = path.join(REPO, "data/sms_tracker.json");
  const tracker = fs.existsSync(trackerPath)
    ? JSON.parse(fs.readFileSync(trackerPath, "utf8")) : { pending: [] };
  const tl = cmd.target.toLowerCase();
  const entry = (tracker.pending ?? []).find((e) => {
    const ctx = e.claim_context || {};
    return String(ctx.file_number ?? "") === cmd.target
      || String(e.claim_id ?? "") === cmd.target
      || String(e.contact_name ?? "").toLowerCase().includes(tl);
  }) ?? null;
  const ctx = entry?.claim_context || {};

  // Completion TIME (XA wants it): the agreed window's end when we know it,
  // else noon — his explicit command carries the authoritative date anyway.
  let time_hhmm = "12:00";
  if (entry?.proposed_time_window) {
    const end = monitor.buildEventTimes(dateIso, entry.proposed_time_window, process.env.CALENDAR_TIMEZONE || "America/Los_Angeles").end;
    time_hhmm = monitor.laDateTimeParts(end).time_hhmm;
  }

  const isNumeric = /^\d{7,9}$/.test(cmd.target);
  const target = {
    ia_firm: ctx.ia_firm ?? entry?.ia_firm ?? (isNumeric ? "PCAS" : null),
    company_index: ctx.company_index ?? entry?.company_index,
    ft_internal_claim_id: ctx.ft_internal_claim_id ?? null,
    file_number: ctx.file_number ?? entry?.claim_id ?? (isNumeric ? cmd.target : null),
    insured: entry?.contact_name ?? (!isNumeric ? cmd.target : null),
    queststar_row_id: ctx.queststar_row_id ?? null,
  };

  const lines = await monitor.markInspectionCompleted(target, { date_iso: dateIso, time_hhmm });

  const key = monitor.completionKey(target.file_number ?? target.insured ?? cmd.target, dateIso);
  const ledger = monitor.loadCompletionLedger();
  ledger.completed[key] = { date: dateIso, source: "command", at: new Date().toISOString() };
  monitor.saveCompletionLedger(ledger);
  if (entry) {
    entry.inspection_completed_written = true;
    fs.writeFileSync(trackerPath, JSON.stringify(tracker, null, 2));
  }

  await ntfyPublish({
    topic: APPROVALS_TOPIC,
    title: `Inspected - ${target.insured ?? target.file_number ?? cmd.target} ${dateIso}`,
    body: lines.join("\n"),
    tags: "white_check_mark",
  }).catch(() => {});
  return lines;
}

/** Send with read-back verification. ≤2 attempts. */
async function sendSms(proposal, body) {
  const t = await tools();
  const target = proposal.thread_id
    ? { thread_id: proposal.thread_id }
    : { number: proposal.to_phone };
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = asJson(await t.voiceSendSms({ ...target, body }));
    last = res;
    if (res?.ok) return { ok: true, result: res, attempts: attempt };
    // Don't hammer the new-conversation picker — Voice soft-throttles rapid
    // compose retries (2026-06-29 Avicasis incident).
    if (attempt === 1) await new Promise(r => setTimeout(r, 5000));
  }
  return { ok: false, result: last, attempts: 2 };
}

/** Stale approval → park old proposal, spin up a fresh one with new slots. */
async function reproposeFresh(outbox, proposal) {
  const t = await tools();
  let fresh = null;
  try {
    const { pickInspectionSlots } = await import(path.join(DIST, "tools/slot_picker.js"));
    const picked = await pickInspectionSlots({ loss_address: proposal.claim?.loss_address, max_slots: 3 });
    if (picked.ok && picked.slots?.length) {
      const slots = picked.slots.map(s => ({
        start: s.start, end: s.end, date: s.date,
        label: `${s.weekday} ${s.date} ${s.start_label}-${s.end_label}`,
        rationale: s.rationale,
      }));
      const draft = t.draftInspectionSms({
        insured_name: proposal.insured_name,
        slot_start: slots[0].start, slot_end: slots[0].end,
      });
      if (draft.ok) {
        fresh = addProposal(outbox, {
          ...structuredClone({ ...proposal, id: undefined, status: undefined, approval: undefined, history: undefined, created_iso: undefined }),
          kind: proposal.kind,
          draft_text: draft.sms_text,
          slots,
        });
      }
    }
  } catch { /* fall through to manual flag */ }
  return fresh;
}

export async function runOnce({ now = new Date() } = {}) {
  const outbox = loadOutbox();
  const log = [];

  let poll;
  try {
    poll = await ntfyPoll({ topic: APPROVALS_TOPIC, since: outbox.ntfy_cursor || "all" });
  } catch (e) {
    return { log: [`ntfy poll failed: ${e.message}`], mutated: false };
  }
  if (poll.cursor) outbox.ntfy_cursor = poll.cursor;

  for (const m of poll.messages) {
    const cmd = parseApprovalCommand(m.message);
    if (!cmd) continue; // our own prompts / chatter on the topic

    // `inspected <target> [date]` targets a claim, not an outbox proposal.
    if (cmd.verb === "inspected") {
      if (DRY_RUN) { log.push(`would handle: ${m.message}`); continue; }
      try {
        const lines = await handleInspectedCommand(cmd);
        log.push(`inspected '${cmd.target}' → ${lines.join(" | ")}`);
      } catch (e) {
        log.push(`inspected '${cmd.target}' FAILED: ${e.message}`);
        await ntfyPublish({ topic: APPROVALS_TOPIC, title: `inspected ${cmd.target} FAILED`, body: String(e.message).slice(0, 300), priority: "high", tags: "rotating_light" }).catch(() => {});
      }
      continue;
    }

    const p = outbox.proposals.find(x => x.id === cmd.id);
    if (!p) {
      log.push(`cmd '${m.message}' → no proposal #${cmd.id}`);
      if (!DRY_RUN) await ntfyPublish({ topic: APPROVALS_TOPIC, title: `No proposal #${cmd.id}`, body: `Command was: ${m.message}`, tags: "warning" }).catch(() => {});
      continue;
    }
    if (!["awaiting_approval", "awaiting_manual_send"].includes(p.status)) {
      log.push(`#${p.id} '${cmd.verb}' ignored — status ${p.status}`);
      continue;
    }
    p.history.push(`${new Date().toISOString()} cmd: ${m.message}`);

    if (cmd.verb === "skip") {
      p.status = "skipped";
      p.decided_iso = new Date().toISOString();
      log.push(`#${p.id} skipped`);
      if (!DRY_RUN) await ntfyPublish({ topic: APPROVALS_TOPIC, title: `#${p.id} skipped`, body: `${p.insured_name} — nothing sent.`, tags: "no_entry_sign" }).catch(() => {});
      continue;
    }

    // send / edit — both fire the send.
    let slotIdx = cmd.verb === "send" ? cmd.slot_index : (p.chosen_slot_index ?? 0);
    if (p.slots?.length && slotIdx >= p.slots.length) {
      log.push(`#${p.id} slot ${slotIdx + 1} out of range`);
      if (!DRY_RUN) await ntfyPublish({ topic: APPROVALS_TOPIC, title: `#${p.id}: no slot ${slotIdx + 1}`, body: `Only ${p.slots.length} slot(s) proposed. Entry still awaiting approval.`, tags: "warning" }).catch(() => {});
      continue;
    }

    // Staleness — never text a slot that's already (nearly) past.
    if (cmd.verb !== "edit" && isProposalStale(p, slotIdx, now)) {
      p.status = "stale";
      p.decided_iso = new Date().toISOString();
      const fresh = DRY_RUN ? null : await reproposeFresh(outbox, p);
      log.push(`#${p.id} stale${fresh ? ` → re-proposed as #${fresh.id}` : ""}`);
      if (!DRY_RUN) {
        const body = fresh
          ? `Proposed slot has passed. Fresh proposal is #${fresh.id}:\n\n${fresh.slots.map((s, i) => `Slot ${i + 1}: ${s.label}`).join("\n")}\n\n${fresh.draft_text}\n\nsend ${fresh.id} | edit ${fresh.id}: <text> | skip ${fresh.id}`
          : `Proposed slot has passed and re-proposal failed — schedule ${p.insured_name} manually.`;
        await ntfyPublish({ topic: APPROVALS_TOPIC, title: `#${p.id} stale - not sent`, body, priority: "high", tags: "warning" }).catch(() => {});
      }
      continue;
    }

    // Body: edited text wins; else re-draft when a non-primary slot was chosen.
    let body = p.draft_text;
    if (cmd.verb === "edit") {
      body = cmd.text;
      p.draft_text = body;
      p.history.push("draft replaced by edit command");
    } else if (slotIdx !== 0 && p.slots?.[slotIdx]) {
      const t = await tools();
      const d = t.draftInspectionSms({
        insured_name: p.insured_name,
        slot_start: p.slots[slotIdx].start, slot_end: p.slots[slotIdx].end,
      });
      if (d.ok) body = d.sms_text;
    }
    p.chosen_slot_index = slotIdx;
    p.approval = { raw: m.message, received_iso: new Date().toISOString(), slot_index: slotIdx };

    if (DRY_RUN) { log.push(`#${p.id} would send: ${body.slice(0, 60)}...`); continue; }

    // kind=cms_note → FileTrac diary note, not an SMS.
    if (p.kind === "cms_note") {
      const t = await tools();
      try {
        const r = callText(await t.filetracAddNote({
          claim_id: p.claim?.ft_internal_claim_id,
          company_index: p.claim?.company_index,
          note: body,
          visible_to_client: false,   // HARD RULE — never client-visible
        }));
        p.status = "sent";
        p.sent_iso = new Date().toISOString();
        log.push(`#${p.id} CMS note posted`);
        await ntfyPublish({ topic: APPROVALS_TOPIC, title: `#${p.id} note posted - ${p.insured_name}`, body: `FileTrac note (not visible to client):\n${body}\n\n${r.slice(0, 200)}`, tags: "white_check_mark" }).catch(() => {});
      } catch (e) {
        log.push(`#${p.id} note failed: ${e.message}`);
        await ntfyPublish({ topic: APPROVALS_TOPIC, title: `#${p.id} note FAILED`, body: String(e.message).slice(0, 300), priority: "high", tags: "rotating_light" }).catch(() => {});
      }
      continue;
    }

    // The SMS itself.
    const sent = await sendSms(p, body);
    if (!sent.ok) {
      p.status = "awaiting_manual_send";
      p.send_result = sent.result;
      const slot = p.slots?.[slotIdx];
      const reg = registerWithMonitor(p, slot, new Date().toISOString());
      log.push(`#${p.id} send FAILED → awaiting_manual_send`);
      await ntfyPublish({
        topic: APPROVALS_TOPIC,
        title: `#${p.id} send FAILED - text ${p.insured_name} manually`,
        body: `Voice picker would not commit ${p.to_phone} (2 attempts; likely new-number throttling).\n\nSend this text yourself to ${p.to_phone}:\n\n${body}\n\n${reg}\nReply monitor will adopt the thread once your text creates it. First Contact was NOT set (no verified send).`,
        priority: "urgent", tags: "rotating_light",
      }).catch(() => {});
      continue;
    }

    p.status = "sent";
    p.sent_iso = new Date().toISOString();
    p.send_result = { ok: true, verified: sent.result?.verified ?? null, attempts: sent.attempts };

    const slot = p.slots?.[slotIdx];
    let fcLine;
    try { fcLine = await writeFirstContact(p); }
    catch (e) { fcLine = `First Contact: WRITE FAILED (${String(e.message).slice(0, 100)}) — set manually`; }
    const regLine = p.kind === "counter_reply"
      ? await settleCounterReply(p)
      : registerWithMonitor(p, slot, p.sent_iso);

    log.push(`#${p.id} sent (${sent.attempts} attempt${sent.attempts > 1 ? "s" : ""}); ${fcLine}`);
    await ntfyPublish({
      topic: APPROVALS_TOPIC,
      title: `#${p.id} SENT - ${p.insured_name}`,
      body: `To ${p.to_phone}${slot ? ` for ${slot.label}` : ""}:\n\n${body}\n\n${fcLine}\n${regLine}`,
      tags: "white_check_mark",
    }).catch(() => {});
  }

  if (!DRY_RUN) saveOutbox(outbox);
  return { log, mutated: true };
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  (async () => {
    console.log(`=== sms-outbox-runner ${new Date().toISOString()} ===`);
    const { log } = await runOnce();
    for (const line of log) console.log(line);
    if (!log.length) console.log("no approval commands — exit");
  })().catch((e) => {
    console.error("sms-outbox-runner fatal:", e);
    process.exit(1);
  });
}
