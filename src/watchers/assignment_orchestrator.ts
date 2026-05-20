/**
 * Assignment orchestrator (queue #22, scaffold slice).
 *
 * Wired into claim_monitor so that every [NEW]/[SUPP]/[REINSP] tier triggers
 * a non-destructive automation pass:
 *   1. Parse the email body via parseAssignmentEmail (handles FileTrac /
 *      XactAnalysis / IANet / AAN / SLG / manual).
 *   2. Find-or-create the per-claim Drive folder via createClaimDriveFolder
 *      (ordinal naming for repeat supplements is already in that tool).
 *   3. If a loss address parsed, geocode + classify quadrant relative to
 *      Hakiel's home so the approval ntfy knows the drive direction.
 *   4. Push a "ready-to-act" ntfy carrying everything Hakiel needs to
 *      act: Drive folder link, examiner contact, quadrant, msg link.
 *
 * What this scaffold deliberately does NOT do (deferred to follow-ups):
 *   - Create a calendar event for the inspection slot — needs slot-pick logic
 *   - Draft an SMS to the insured — needs voice-tuned templates
 *   - Send approved SMS automatically — Voice send still broken (#20)
 *   - 3hr no-reply follow-up — needs persistent state to track replies
 *
 * Disable via env: ORCHESTRATOR_ENABLED=0. Default ENABLED.
 *
 * Idempotent: createClaimDriveFolder reuses existing folders rather than
 * duplicating. If the orchestrator fires twice for the same email (e.g.,
 * a redeploy resets claim_monitor's alerted-map), nothing destructive
 * happens; the second pass returns already_existed=true.
 */

import { parseAssignmentEmail } from "../tools/assignment_email.js";
import { createClaimDriveFolder } from "../tools/claim_drive_folder.js";
import { geocode, classifyPoint, haversineMiles, HOME_LAT, HOME_LNG, HOME_LABEL } from "../tools/maps.js";

const NTFY_TOPIC = process.env.ORCHESTRATOR_NTFY_TOPIC
  ?? process.env.CLAIM_MONITOR_NTFY_TOPIC
  ?? "dino-claims-alerts-fpx";
const NTFY_SERVER = process.env.ORCHESTRATOR_NTFY_SERVER
  ?? process.env.CLAIM_MONITOR_NTFY_SERVER
  ?? "https://ntfy.sh";

export type OrchTier = "HIGH" | "SUPP" | "REINSP";

function asciiSafe(s: string): string {
  return (s || "").replace(/[^\x00-\x7F]/g, "").trim();
}

async function pushOrchNtfy(args: { title: string; message: string; tags?: string[] }) {
  try {
    const url = `${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`;
    await fetch(url, {
      method: "POST",
      headers: {
        "Title": asciiSafe(args.title) || "Orchestrator",
        "Priority": "5",
        "Tags": (args.tags ?? []).map(asciiSafe).filter(Boolean).join(","),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: args.message,
    });
  } catch (e: any) {
    console.error(`[orchestrator] ntfy push failed: ${e?.message || e}`);
  }
}

// Map claim_monitor's tier label to createClaimDriveFolder's work_type arg.
function workTypeFor(tier: OrchTier): "supplement" | "reinspection" | undefined {
  switch (tier) {
    case "SUPP": return "supplement";
    case "REINSP": return "reinspection";
    case "HIGH": default: return undefined;
  }
}

// Build the comma-joined single-line address for geocoding + display.
function joinAddress(addr: {
  street?: string; street2?: string; city?: string; state?: string; zip?: string;
}): string | null {
  const street = [addr.street, addr.street2].filter(Boolean).join(" ").trim();
  const cityStateZip = [addr.city, addr.state].filter(Boolean).join(", ");
  const tail = [cityStateZip, addr.zip].filter(Boolean).join(" ").trim();
  const full = [street, tail].filter(Boolean).join(", ");
  return full || null;
}

export type OrchestratorInput = {
  tier: OrchTier;
  fromHeader: string;
  subject: string;
  body: string;
  msgId: string;
  threadId?: string;
};

export async function runOrchestrator(input: OrchestratorInput): Promise<void> {
  if (process.env.ORCHESTRATOR_ENABLED === "0") {
    console.log("[orchestrator] disabled via ORCHESTRATOR_ENABLED=0");
    return;
  }

  const { tier, fromHeader, subject, body, msgId } = input;
  const log = (msg: string) => console.log(`[orchestrator][${tier}] ${msg}`);

  // ─── 1. Parse the email ────────────────────────────────────────────────
  const parsed = parseAssignmentEmail({ from: fromHeader, subject, body });
  if (!parsed.ok) {
    log(`parse failed: ${parsed.error}`);
    await pushOrchNtfy({
      title: `[ORCH][${tier}] parse failed — manual review`,
      message:
        `Could not parse assignment metadata.\n` +
        `From: ${fromHeader}\nSubject: ${subject}\n` +
        `Reason: ${parsed.error}\n` +
        `Gmail: https://mail.google.com/mail/u/0/#inbox/${msgId}\n` +
        `[id: ${msgId}]`,
      tags: ["warning"],
    });
    return;
  }

  log(`parsed platform=${parsed.platform} claim=${parsed.claim_number ?? "?"} insured=${parsed.insured_name ?? "?"}`);

  // ─── 2. Resolve folder name fields + create Drive folder ───────────────
  // request_date: use the email's date_received if parsed; otherwise today.
  const requestDate = parsed.date_received || new Date().toISOString().slice(0, 10);
  // Carrier-short: parsed.carrier may be a long string; the existing tools
  // expect a short code. For now, just pass the carrier verbatim and let
  // the user clean it up if needed. Falls back to "Unknown" if missing.
  const insured = parsed.insured_name?.trim() || parsed.claimant_name?.trim() || "Unknown Insured";
  const carrierShort = (parsed.carrier || "Unknown").trim().split(/\s+/).slice(0, 3).join(" ");
  const clientShort = platformToClient(parsed.platform, parsed.raw_from);
  const lossType = (parsed.loss_type || "Unknown").trim().split(/\s+/).slice(0, 3).join(" ");

  const folderArgs = {
    request_date: requestDate,
    insured_name: insured,
    client_short: clientShort,
    carrier_short: carrierShort,
    loss_type: lossType,
    work_type: workTypeFor(tier),
  };

  let folderResult: Awaited<ReturnType<typeof createClaimDriveFolder>>;
  try {
    folderResult = await createClaimDriveFolder(folderArgs);
  } catch (e: any) {
    log(`folder create threw: ${e?.message || e}`);
    folderResult = { ok: false, error: String(e?.message || e) };
  }

  let folderLine = "❌ folder creation FAILED";
  let folderLink: string | undefined;
  if (folderResult.ok) {
    folderLine = folderResult.already_existed
      ? `📁 folder existed: ${folderResult.claim_folder.name}`
      : `📁 folder CREATED: ${folderResult.claim_folder.name}`;
    folderLink = folderResult.claim_folder.link;
  } else {
    folderLine = `❌ folder create failed: ${folderResult.error}`;
  }
  log(folderLine);

  // ─── 3. Geocode + classify quadrant if we got a loss address ───────────
  let quadrantLine = "🗺  loss address: (not parsed)";
  if (parsed.loss_address) {
    const lossAddrStr = joinAddress(parsed.loss_address);
    if (lossAddrStr) {
      try {
        const g = await geocode(lossAddrStr);
        if (g.ok) {
          const target = { lat: g.lat, lng: g.lng };
          const origin = { lat: HOME_LAT, lng: HOME_LNG };
          const quadrant = classifyPoint(target, origin);
          const miles = haversineMiles(origin, target).toFixed(1);
          quadrantLine = `🗺  ${quadrant} • ${miles}mi from home • ${lossAddrStr}`;
        } else {
          quadrantLine = `🗺  geocode failed (${g.error}): ${lossAddrStr}`;
        }
      } catch (e: any) {
        quadrantLine = `🗺  geocode threw: ${e?.message || e}`;
      }
    }
  }

  // ─── 4. Build approval ntfy ────────────────────────────────────────────
  const examiner = parsed.desk_adjuster
    ? `${parsed.desk_adjuster.name || "?"}` +
      (parsed.desk_adjuster.phone ? ` • ${parsed.desk_adjuster.phone}` : "") +
      (parsed.desk_adjuster.email ? ` • ${parsed.desk_adjuster.email}` : "")
    : "(no examiner parsed)";

  const insuredContactLine = parsed.insured_phone
    ? `📞 insured ${parsed.insured_name || ""} ${parsed.insured_phone}`
    : `📞 insured: (no phone parsed)`;

  const gmailLink = `https://mail.google.com/mail/u/0/#inbox/${msgId}`;
  const folderLinkLine = folderLink ? `🔗 ${folderLink}` : "";

  const titlePrefix =
    tier === "HIGH" ? "[ORCH][NEW]" :
    tier === "SUPP" ? "[ORCH][SUPP]" :
    "[ORCH][REINSP]";

  const title = `${titlePrefix} ${insured} • ${clientShort} • ${parsed.claim_number || "?"}`;

  const messageLines = [
    `${folderLine}`,
    folderLinkLine,
    `${quadrantLine}`,
    `${insuredContactLine}`,
    `👤 examiner: ${examiner}`,
    `🧾 claim#: ${parsed.claim_number || "?"}` +
      (parsed.carrier_claim_number && parsed.carrier_claim_number !== parsed.claim_number
        ? ` (carrier#: ${parsed.carrier_claim_number})` : ""),
    `🪶 loss type: ${lossType}`,
    parsed.date_of_loss ? `📅 DOL: ${parsed.date_of_loss}` : "",
    "",
    `Gmail: ${gmailLink}`,
    `[id: ${msgId}]`,
  ].filter(Boolean);

  await pushOrchNtfy({
    title,
    message: messageLines.join("\n"),
    tags: tier === "HIGH" ? ["rotating_light"] : tier === "SUPP" ? ["heavy_plus_sign"] : ["mag"],
  });
}

// Best-effort platform → short client code map. Falls back to "Unknown" for
// anything we don't recognize so the folder name doesn't end up blank.
// Refinement is a follow-up: parseAssignmentEmail returns the parsed
// platform but client identity sometimes lives in the body (e.g., PCAS as
// FileTrac client). Good enough for tonight's MVP — Hakiel can rename in
// Drive if the auto-pick is wrong.
function platformToClient(platform: string, rawFrom: string): string {
  const from = (rawFrom || "").toLowerCase();
  if (platform === "ianet" || from.includes("ianetwork")) return "IANet";
  if (from.includes("pcsadj") || from.includes("pcas")) return "PCAS";
  if (from.includes("usclaimsolutions")) return "USCS";
  if (from.includes("straightlineglobal") || from.includes("straightline")) return "SLG";
  if (from.includes("xactware") || platform === "xactanalysis") return "XA";
  if (from.includes("filetrac") || platform === "filetrac") return "FileTrac";
  if (from.includes("aan") || platform === "aan") return "AAN";
  return "Unknown";
}
