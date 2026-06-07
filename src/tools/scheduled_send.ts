/**
 * Local persistence + launchd sweep for Gmail "scheduled send."
 *
 * Gmail's API has NO native scheduled-send. There are two firing paths on this
 * server now and they're complementary, not competing:
 *
 *   IN-PROCESS TIMER  — armed by gmail_create_draft_scheduled in gmail.ts.
 *                       Fires on time while the MCP server is running. If the
 *                       server is down at send_at the timer misses it.
 *
 *   LAUNCHD SWEEP     — this file's runScheduledSendSweep(), run every 5 min
 *                       by ~/Library/LaunchAgents/com.hakiel.scheduled-send.plist.
 *                       Catches anything the timer missed (server was down).
 *                       Worst-case latency = sweep interval.
 *
 * The queue file scheduled_sends.json is the durable record both paths share.
 * gmail_create_draft_scheduled APPENDS an entry here after arming its timer;
 * the sweep reads matured entries here and fires them via drafts.send. If the
 * in-process timer already fired, the sweep gets a 404 from drafts.send and
 * drops the entry — idempotent.
 *
 * SEND POLICY (re-derived at send time, not just trusted from schedule time):
 *   - All recipients on GMAIL_INTERNAL_DOMAINS (default erseville.com): the
 *     sweep AUTO-SENDS via drafts.send.
 *   - Any external recipient: the sweep does NOT auto-send. It surfaces the
 *     current draft to ntfy (tap-to-open in Gmail) and leaves the queue entry
 *     in place marked surfaced. Mirrors the strict-send guardrail's "third-
 *     party requires a human in the loop" rule — see src/util/send_guardrail.ts.
 *
 * CO-LOCATION REQUIREMENT: scheduled_sends.json is LOCAL. The MCP server that
 * writes it and the launchd sweep that reads it MUST share a filesystem (both
 * the Mac-mini local server). If gmail_create_draft_scheduled is ever served
 * by the remote Railway server, its entry lands on Railway's ephemeral disk
 * and the local cron never sees it → silent never-send. Override the path
 * with SCHEDULED_SENDS_PATH if you genuinely need a shared location.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getGmailClient, pushDraftSnapshotNtfy } from "./gmail.js";
import { allRecipientsInternal } from "../util/send_guardrail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTextContent(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

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
    if (e?.code === "ENOENT") return [];
    console.error(`[scheduled-send] could not read ${p}: ${e?.message || e}`);
    return [];
  }
}

// Atomic write: tmp file then rename, so a concurrent reader never sees a
// half-written file. Single low-frequency writer; we accept the small
// read-modify-write race between the MCP server and the cron tick.
export function writeSchedule(list: ScheduledSend[]): void {
  const p = getSchedulePath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

/**
 * Called by gmail.ts's gmailCreateDraftScheduled after it creates the draft +
 * arms the in-process timer. Persists the same entry to the queue so the
 * launchd sweep can act as a backstop if the timer misses (server down at
 * send_at). De-dupes on draft_id so a re-arm on boot doesn't add ghosts.
 */
export function appendToSchedule(entry: ScheduledSend): void {
  const list = readSchedule();
  const idx = list.findIndex(e => e.draft_id === entry.draft_id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  writeSchedule(list);
}

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

export async function gmailCancelScheduledSend(args: { draft_id: string }): Promise<CallToolResult> {
  if (!args.draft_id) return makeTextContent("❌ draft_id is required.");
  const list = readSchedule();
  const next = list.filter(e => e.draft_id !== args.draft_id);
  if (next.length === list.length) {
    return makeTextContent(`No scheduled send found for draft ${args.draft_id}. (The underlying Gmail draft, if any, is untouched.)`);
  }
  writeSchedule(next);
  return makeTextContent(
    `✅ Removed scheduled send for draft ${args.draft_id} from the queue. ` +
    `The Gmail draft itself was NOT deleted — use gmail_delete_draft to remove it too. ` +
    `Note: the in-process timer for this draft is still armed if the MCP server has been up since it was scheduled — use gmail_delete_draft to also stop that timer.`
  );
}

interface DraftSnapshot {
  exists: boolean;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  link: string;
}

function decodeBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  if (Array.isArray(payload.parts)) {
    const plain = payload.parts.find((p: any) => p.mimeType === "text/plain");
    if (plain?.body?.data) return Buffer.from(plain.body.data, "base64url").toString("utf-8");
    return payload.parts.map(decodeBody).filter(Boolean).join("\n");
  }
  return "";
}

async function getDraftSnapshot(draftId: string): Promise<DraftSnapshot> {
  const link = `https://mail.google.com/mail/u/0/#drafts?compose=${draftId}`;
  try {
    const gmail = await getGmailClient();
    const got = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
    const payload = got.data.message?.payload;
    const headers = payload?.headers ?? [];
    const h = (n: string) => headers.find((x: any) => (x.name ?? "").toLowerCase() === n)?.value ?? "";
    return {
      exists: true,
      to: h("to") || undefined,
      cc: h("cc") || undefined,
      bcc: h("bcc") || undefined,
      subject: h("subject") || undefined,
      body: decodeBody(payload),
      link,
    };
  } catch (e: any) {
    if (e?.code === 404 || e?.response?.status === 404) return { exists: false, link };
    throw e;
  }
}

interface SendResult {
  ok: boolean;
  messageId?: string;
  draftMissing?: boolean;
  error?: string;
}

async function sendDraft(draftId: string): Promise<SendResult> {
  try {
    const gmail = await getGmailClient();
    const res = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
    return { ok: true, messageId: res.data.id ?? undefined };
  } catch (e: any) {
    if (e?.code === 404 || e?.response?.status === 404) return { ok: false, draftMissing: true };
    return { ok: false, error: e?.message || String(e) };
  }
}

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
  const summary: SweepSummary = {
    checked: list.length, matured: 0, sent: 0, surfaced: 0, dropped: 0, errors: 0, kept: 0, details: [],
  };
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
      keep.push(entry);
      continue;
    }

    summary.matured++;
    const internalOnly = allRecipientsInternal(entry.to, entry.cc, entry.bcc);

    if (internalOnly) {
      const r = await sendDraft(entry.draft_id);
      if (r.ok) {
        summary.sent++;
        summary.details.push(`✅ sent ${entry.draft_id} → ${entry.to} (msg ${r.messageId})`);
      } else if (r.draftMissing) {
        summary.dropped++;
        summary.details.push(`🗑️ dropped ${entry.draft_id}: draft gone (already sent/deleted)`);
      } else {
        entry.last_error = r.error || "send failed";
        summary.errors++;
        summary.kept++;
        summary.details.push(`❌ ${entry.draft_id} send failed: ${entry.last_error} — will retry next tick`);
        keep.push(entry);
      }
    } else {
      const snap = await getDraftSnapshot(entry.draft_id);
      if (!snap.exists) {
        summary.dropped++;
        summary.details.push(`🗑️ dropped ${entry.draft_id}: draft gone (already sent/deleted)`);
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
        summary.kept++;
        keep.push(entry);
      }
    }
  }

  writeSchedule(keep);
  return summary;
}

export async function gmailRunScheduledSweep(): Promise<CallToolResult> {
  const s = await runScheduledSendSweep();
  return makeTextContent(
    `Scheduled-send sweep complete.\n` +
    `checked=${s.checked} matured=${s.matured} sent=${s.sent} surfaced=${s.surfaced} dropped=${s.dropped} errors=${s.errors} kept=${s.kept}\n` +
    (s.details.length ? s.details.join("\n") : "(no matured entries)")
  );
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || "").href;
  } catch {
    return false;
  }
})();

if (isMain) {
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
