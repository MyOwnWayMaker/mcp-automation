/**
 * Local "scheduled send" for Gmail.
 *
 * Gmail's API has NO native scheduled-send (the UI's "Schedule send" is backed
 * by Google-internal infra not reachable via users.drafts.* / users.messages.*
 * — see commit 37f6516). So we build it locally:
 *
 *   1. gmail_create_draft_scheduled creates a normal Gmail DRAFT (reusing the
 *      exact create-draft path, including the ntfy review snapshot) and records
 *      a {draft_id, send_at_iso, ...} entry in scheduled_sends.json at repo root.
 *   2. A periodic launchd agent (com.hakiel.scheduled-send.plist →
 *      scripts/scheduled-send-cron.sh → `node dist/tools/scheduled_send.js`)
 *      runs runScheduledSendSweep(): for each MATURED entry (send_at_iso <= now)
 *      it routes through the EXISTING draft-send path (users.drafts.send via
 *      sendDraftStructured — NEVER a raw users.messages.send), then removes the
 *      entry.
 *
 * SEND POLICY (mirrors the gmail_send_email strict-send guardrail, commit
 * 37f6516):
 *   - INTERNAL-ONLY recipients (every address on a GMAIL_INTERNAL_DOMAINS
 *     domain, default erseville.com): AUTO-SEND at maturity. Low risk, no
 *     client-facing exposure, retractable from Gmail's own UI.
 *   - ANY EXTERNAL (third-party) recipient: do NOT auto-send. At maturity the
 *     draft is SURFACED for manual approval — the current draft body is pushed
 *     to ntfy (tap-to-open/edit/send in Gmail) and the entry is left in place
 *     marked surfaced. This keeps the same loud, draft-first, human-in-the-loop
 *     posture that prevented the Paul-Kuhr direct-send bypass.
 *
 * The policy gate is re-derived from the stored recipients at SEND time (not
 * just trusted from schedule time) so a later GMAIL_INTERNAL_DOMAINS change is
 * honored.
 *
 * CO-LOCATION REQUIREMENT: the JSON file is LOCAL. The MCP server that serves
 * gmail_create_draft_scheduled and the launchd sweep MUST share a filesystem
 * (both the Mac-mini local server). If the tool is ever called on the remote
 * Railway server, its entry lands on Railway's ephemeral disk and the local
 * cron will never see it. Override the path with SCHEDULED_SENDS_PATH if you
 * need a shared location.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createDraftStructured,
  sendDraftStructured,
  getDraftSnapshot,
  allRecipientsInternal,
  pushDraftSnapshotNtfy,
  INTERNAL_SEND_DOMAINS,
} from "./gmail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTextContent(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// ─── Storage ────────────────────────────────────────────────────────────────

/**
 * One queued scheduled send. The file is a JSON array of these.
 *
 *   draft_id                  Gmail draft ID — the thing we send at maturity.
 *   message_id                Underlying message ID (informational).
 *   to / cc / bcc / subject   Snapshot at schedule time (server-verified). Used
 *                             for the file's human readability + the surface
 *                             notification fallback; the live draft is re-read
 *                             from Gmail at send time so edits are honored.
 *   link                      Deep link to open the draft in Gmail.
 *   send_at_iso               When to send. ISO-8601 (UTC "Z" or with offset).
 *   auto_send                 Policy decision recorded at schedule time:
 *                             true = internal-only (auto-send), false = has an
 *                             external recipient (surface for manual approval).
 *   recipients_internal_only  Same signal, named for clarity in the file.
 *   created_at_iso            When the entry was queued.
 *   surfaced_at_iso           For external entries: when we pushed the
 *                             surface-for-approval ntfy (null until surfaced).
 *   last_error                Last auto-send failure message, if any (retried
 *                             on the next sweep tick).
 */
export interface ScheduledSend {
  draft_id: string;
  message_id?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  link: string;
  send_at_iso: string;
  auto_send: boolean;
  recipients_internal_only: boolean;
  created_at_iso: string;
  surfaced_at_iso?: string | null;
  last_error?: string;
}

// Default location: repo root (../../ from dist/tools/scheduled_send.js).
// SCHEDULED_SENDS_PATH overrides for tests or a shared location.
export function getSchedulePath(): string {
  return process.env.SCHEDULED_SENDS_PATH || path.resolve(__dirname, "../../scheduled_sends.json");
}

export function readSchedule(): ScheduledSend[] {
  const p = getSchedulePath();
  try {
    const raw = fs.readFileSync(p, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScheduledSend[]) : [];
  } catch (e: any) {
    if (e?.code === "ENOENT") return []; // not created yet — empty queue
    console.error(`[scheduled-send] could not read ${p}: ${e?.message || e}`);
    return [];
  }
}

// Atomic write: write to a temp file then rename, so a concurrent reader never
// sees a half-written file. (Single low-frequency user; we accept the small
// read-modify-write race between the MCP server and the cron tick.)
export function writeSchedule(list: ScheduledSend[]): void {
  const p = getSchedulePath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

// ─── Tool: create a scheduled send ───────────────────────────────────────────

export async function gmailCreateDraftScheduled(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  send_at_iso: string;
}): Promise<CallToolResult> {
  if (!args.to || !args.subject || !args.send_at_iso) {
    return makeTextContent("❌ to, subject, and send_at_iso are required.");
  }

  // Validate the send time: must parse and be in the future.
  const sendMs = Date.parse(args.send_at_iso);
  if (!Number.isFinite(sendMs)) {
    return makeTextContent(
      `❌ send_at_iso is not a valid ISO-8601 timestamp: "${args.send_at_iso}".\n` +
      `Example: "2026-05-22T15:00:00-07:00" or "2026-05-22T22:00:00Z".`
    );
  }
  if (sendMs <= Date.now()) {
    return makeTextContent(
      `❌ send_at_iso (${new Date(sendMs).toISOString()}) is in the past. ` +
      `Pick a future time, or use gmail_send_draft to send now.`
    );
  }

  // Create the draft via the SAME path as gmail_create_draft (also fires the
  // standard draft-review ntfy snapshot so Hakiel sees what was composed).
  const d = await createDraftStructured({
    to: args.to, subject: args.subject, body: args.body, cc: args.cc, bcc: args.bcc,
  });
  if (!d.draftId) {
    return makeTextContent("❌ Draft creation failed (no draft ID returned); nothing scheduled.");
  }

  // Policy decision, from the SERVER-stored recipients.
  const internalOnly = allRecipientsInternal(d.snapTo, d.snapCc, d.snapBcc);

  const entry: ScheduledSend = {
    draft_id: d.draftId,
    message_id: d.messageId,
    to: d.snapTo,
    cc: d.snapCc,
    bcc: d.snapBcc,
    subject: d.snapSubject,
    link: d.link,
    send_at_iso: new Date(sendMs).toISOString(),
    auto_send: internalOnly,
    recipients_internal_only: internalOnly,
    created_at_iso: new Date().toISOString(),
    surfaced_at_iso: null,
  };

  const list = readSchedule();
  list.push(entry);
  writeSchedule(list);

  const policyLine = internalOnly
    ? "✅ AUTO-SEND at maturity (all recipients internal — sent automatically by the sweep)."
    : "🔸 SURFACE-FOR-APPROVAL at maturity (external recipient present — the sweep will push the draft to ntfy for you to review and send manually; it will NOT auto-send).";

  return makeTextContent(
    `📅 Scheduled send queued.\n` +
    `Draft ID: ${entry.draft_id}\nSend at: ${entry.send_at_iso}\n` +
    `Recipients: to=${entry.to}${entry.cc ? ` | cc=${entry.cc}` : ""}${entry.bcc ? ` | bcc=${entry.bcc}` : ""}\n` +
    `Internal domains (auto-send set): ${[...INTERNAL_SEND_DOMAINS].join(", ") || "(none)"}\n` +
    `Policy: ${policyLine}\n` +
    `Draft snapshot ntfy: ${d.ntfyStatus}\nOpen in Gmail: ${entry.link}\n\n` +
    `The local launchd sweep (com.hakiel.scheduled-send) sends matured entries. ` +
    `Until it fires you can still send/cancel manually via gmail_send_draft / gmail_delete_draft.\n\n` +
    `--- VERIFIED DRAFT SNAPSHOT ---\n${d.snapHeaders}\n\n${d.snapBody}`
  );
}

// ─── Tool: list scheduled sends ───────────────────────────────────────────────

export async function gmailListScheduledSends(): Promise<CallToolResult> {
  const list = readSchedule();
  if (list.length === 0) return makeTextContent("No scheduled sends queued.");
  const now = Date.now();
  const lines = list.map((e, i) => {
    const due = Date.parse(e.send_at_iso);
    const status = !Number.isFinite(due)
      ? "⚠️ bad send_at_iso"
      : due > now
        ? `⏳ in ${Math.round((due - now) / 60000)} min`
        : e.surfaced_at_iso
          ? "🔸 surfaced (awaiting manual send)"
          : "⌛ due";
    return `${i + 1}. [${status}] ${e.send_at_iso} — ${e.auto_send ? "auto" : "manual"} — ${e.subject} → ${e.to}` +
      `${e.last_error ? ` (last error: ${e.last_error})` : ""} (draft ${e.draft_id})`;
  });
  return makeTextContent(`Scheduled sends (${list.length}):\n${lines.join("\n")}`);
}

// ─── Tool: cancel a scheduled send ────────────────────────────────────────────

export async function gmailCancelScheduledSend(args: { draft_id: string }): Promise<CallToolResult> {
  if (!args.draft_id) return makeTextContent("❌ draft_id is required.");
  const list = readSchedule();
  const next = list.filter(e => e.draft_id !== args.draft_id);
  if (next.length === list.length) {
    return makeTextContent(`No scheduled send found for draft ${args.draft_id}. (The underlying draft, if any, is untouched.)`);
  }
  writeSchedule(next);
  return makeTextContent(
    `✅ Removed scheduled send for draft ${args.draft_id} from the queue. ` +
    `The Gmail draft itself was NOT deleted — use gmail_delete_draft to remove it too.`
  );
}

// ─── The sweep (run by the launchd cron AND the run-sweep tool) ───────────────

export interface SweepSummary {
  checked: number;
  matured: number;
  sent: number;
  surfaced: number;
  dropped: number;
  errors: number;
  kept: number;
  details: string[];
}

export async function runScheduledSendSweep(): Promise<SweepSummary> {
  const list = readSchedule();
  const now = Date.now();
  const summary: SweepSummary = { checked: list.length, matured: 0, sent: 0, surfaced: 0, dropped: 0, errors: 0, kept: 0, details: [] };
  const keep: ScheduledSend[] = [];

  for (const entry of list) {
    const due = Date.parse(entry.send_at_iso);
    if (!Number.isFinite(due)) {
      entry.last_error = `unparseable send_at_iso: ${entry.send_at_iso}`;
      summary.errors++;
      summary.kept++;
      summary.details.push(`⚠️ ${entry.draft_id}: ${entry.last_error} — kept for inspection`);
      keep.push(entry);
      continue;
    }
    if (due > now) {
      summary.kept++;
      keep.push(entry); // not matured yet
      continue;
    }

    // Matured. Re-derive the policy gate from the stored recipients so a later
    // GMAIL_INTERNAL_DOMAINS change is respected.
    summary.matured++;
    const internalOnly = allRecipientsInternal(entry.to, entry.cc, entry.bcc);

    if (internalOnly) {
      // AUTO-SEND via the existing draft-send path (drafts.send, not raw send).
      const r = await sendDraftStructured(entry.draft_id);
      if (r.ok) {
        summary.sent++;
        summary.details.push(`✅ sent ${entry.draft_id} → ${entry.to} (msg ${r.messageId})`);
        // entry dropped (not kept)
      } else if (r.draftMissing) {
        summary.dropped++;
        summary.details.push(`🗑️ dropped ${entry.draft_id}: draft gone (sent/deleted out of band)`);
        // entry dropped
      } else {
        entry.last_error = r.error || "send failed";
        summary.errors++;
        summary.kept++;
        summary.details.push(`❌ ${entry.draft_id} send failed: ${entry.last_error} — will retry next tick`);
        keep.push(entry);
      }
    } else {
      // SURFACE-FOR-APPROVAL: never auto-send an external recipient.
      const snap = await getDraftSnapshot(entry.draft_id);
      if (!snap.exists) {
        summary.dropped++;
        summary.details.push(`🗑️ dropped ${entry.draft_id}: draft gone (sent/deleted out of band)`);
        // entry dropped
      } else if (!entry.surfaced_at_iso) {
        const status = await pushDraftSnapshotNtfy({
          to: snap.to || entry.to,
          subject: snap.subject || entry.subject,
          body: snap.body || "(draft body empty — open in Gmail)",
          cc: snap.cc ?? entry.cc,
          bcc: snap.bcc ?? entry.bcc,
          link: snap.link,
        });
        entry.surfaced_at_iso = new Date().toISOString();
        summary.surfaced++;
        summary.kept++;
        summary.details.push(`🔸 surfaced ${entry.draft_id} → ${entry.to} for manual send (ntfy: ${status})`);
        keep.push(entry);
      } else {
        // Already surfaced; awaiting Hakiel's manual send. Keep, don't re-notify.
        summary.kept++;
        keep.push(entry);
      }
    }
  }

  writeSchedule(keep);
  return summary;
}

// MCP tool wrapper for an on-demand sweep (manual flush / debugging without
// waiting for the launchd tick).
export async function gmailRunScheduledSweep(): Promise<CallToolResult> {
  const s = await runScheduledSendSweep();
  return makeTextContent(
    `Scheduled-send sweep complete.\n` +
    `checked=${s.checked} matured=${s.matured} sent=${s.sent} surfaced=${s.surfaced} dropped=${s.dropped} errors=${s.errors} kept=${s.kept}\n` +
    (s.details.length ? s.details.join("\n") : "(no matured entries)")
  );
}

// ─── CLI entry (the launchd cron target: `node dist/tools/scheduled_send.js`) ──

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || "").href;
  } catch {
    return false;
  }
})();

if (isMain) {
  // Load .env so Google creds / GMAIL_INTERNAL_DOMAINS resolve the same way the
  // MCP server resolves them (the bash wrapper also exports the cred paths).
  dotenv.config({ path: path.resolve(__dirname, "../../.env"), quiet: true });
  runScheduledSendSweep()
    .then((s) => {
      console.log(
        `[scheduled-send] ${new Date().toISOString()} ` +
        `checked=${s.checked} matured=${s.matured} sent=${s.sent} surfaced=${s.surfaced} dropped=${s.dropped} errors=${s.errors} kept=${s.kept}`
      );
      for (const d of s.details) console.log(`  ${d}`);
      process.exit(s.errors > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(`[scheduled-send] sweep crashed: ${e?.stack || e}`);
      process.exit(2);
    });
}
