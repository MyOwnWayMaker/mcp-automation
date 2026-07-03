#!/usr/bin/env node
/**
 * sms-register-pending.mjs — add an outbound first-contact SMS to the
 * tracker so sms-monitor.mjs picks it up on the next poll.
 *
 * Usage:
 *   node scripts/sms-register-pending.mjs \
 *     --thread t.+13104861443 \
 *     --contact "Carol Gross" \
 *     --claim 3708717 \
 *     --company-index 1 \
 *     --ia-firm PCAS \
 *     --send-iso 2026-06-10T02:15:00.000Z \
 *     --proposed-date 2026-06-11 \
 *     --window "10am-11am"
 *
 * Flags are tolerant of `--key=value` and `--key value`. Required: thread,
 * contact, claim, send-iso. Optional: company-index, ia-firm, proposed-date,
 * window, claim-context-json (path to JSON or inline JSON; populates the rich
 * description fields on the auto-created calendar event — see
 * buildEventDescription in sms-monitor.mjs for recognized keys).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKER_PATH = path.join(REPO, "data/sms_tracker.json");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const required = ["thread", "contact", "claim", "send-iso"];
const missing = required.filter((k) => !args[k]);
if (missing.length) {
  console.error(`missing required flag(s): ${missing.map((m) => "--" + m).join(", ")}`);
  process.exit(2);
}

const phoneFromThread = args.thread.startsWith("t.+") ? args.thread.slice(2) : null;

// claim-context-json: either a path to a JSON file, or inline JSON.
let claim_context = null;
if (args["claim-context-json"]) {
  const raw = args["claim-context-json"];
  try {
    if (fs.existsSync(raw)) {
      claim_context = JSON.parse(fs.readFileSync(raw, "utf8"));
    } else {
      claim_context = JSON.parse(raw);
    }
  } catch (e) {
    console.error(`failed to parse --claim-context-json: ${e.message}`);
    process.exit(2);
  }
}

const entry = {
  id: `${args.contact.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${args["send-iso"].slice(0, 10)}`,
  thread_id: args.thread,
  contact_name: args.contact,
  contact_phone: args.phone || phoneFromThread || "",
  claim_id: args.claim,
  company_index: args["company-index"] ? Number(args["company-index"]) : null,
  ia_firm: args["ia-firm"] || null,
  send_iso: args["send-iso"],
  proposed_date_iso: args["proposed-date"] || null,
  proposed_time_window: args.window || null,
  two_hour_warned: false,
  last_processed_inbound_iso: null,
  resolved: false,
  registered_iso: new Date().toISOString(),
  ...(claim_context ? { claim_context } : {}),
};

const tracker = fs.existsSync(TRACKER_PATH)
  ? JSON.parse(fs.readFileSync(TRACKER_PATH, "utf8"))
  : { pending: [] };
if (!Array.isArray(tracker.pending)) tracker.pending = [];

const existingIdx = tracker.pending.findIndex((p) => p.id === entry.id);
if (existingIdx >= 0) {
  console.log(`replacing existing entry ${entry.id}`);
  tracker.pending[existingIdx] = entry;
} else {
  tracker.pending.push(entry);
}

fs.writeFileSync(TRACKER_PATH, JSON.stringify(tracker, null, 2));
console.log("registered:", JSON.stringify(entry, null, 2));
