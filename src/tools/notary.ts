import { google } from "googleapis";
import { getNotaryGmailClient } from "../auth/google-notary.js";
import { getGoogleAuthClient } from "../auth/google.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// ─── Notary Email (drupenterprise1@gmail.com) ─────────────────────────────────

export async function notaryGetNewEmails(args: {
  max_results?: number;
  include_read?: boolean;
}): Promise<CallToolResult> {
  const auth = await getNotaryGmailClient();
  const gmail = google.gmail({ version: "v1", auth });

  const query = args.include_read ? "" : "is:unread";
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query || undefined,
    maxResults: args.max_results ?? 20,
  });

  const messages = res.data.messages ?? [];
  if (messages.length === 0) return ok("No new emails in notary inbox.");

  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "full",
      })
    )
  );

  const summaries = details.map((d) => {
    const headers = d.data.payload?.headers ?? [];
    const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";

    let body = "";
    const parts = d.data.payload?.parts ?? [];
    const textPart = parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, "base64").toString("utf-8").slice(0, 2000);
    } else if (d.data.payload?.body?.data) {
      body = Buffer.from(d.data.payload.body.data, "base64").toString("utf-8").slice(0, 2000);
    }

    return [
      `MESSAGE ID: ${d.data.id}`,
      `From: ${get("From")}`,
      `Date: ${get("Date")}`,
      `Subject: ${get("Subject")}`,
      `---`,
      body || "(no plain-text body)",
    ].join("\n");
  });

  return ok(summaries.join("\n\n════════════════════════════════\n\n"));
}

export async function notarySendEmail(args: {
  to: string;
  subject: string;
  body: string;
  reply_to_message_id?: string;
  thread_id?: string;
}): Promise<CallToolResult> {
  const auth = await getNotaryGmailClient();
  const gmail = google.gmail({ version: "v1", auth });

  const lines = [
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    args.reply_to_message_id ? `In-Reply-To: ${args.reply_to_message_id}` : null,
    args.reply_to_message_id ? `References: ${args.reply_to_message_id}` : null,
    "",
    args.body,
  ].filter(Boolean).join("\r\n");

  const raw = Buffer.from(lines).toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      ...(args.thread_id && { threadId: args.thread_id }),
    },
  });

  return ok(`Email sent from drupenterprise1@gmail.com\nMessage ID: ${res.data.id}`);
}

export async function notaryMarkEmailRead(args: {
  message_id: string;
}): Promise<CallToolResult> {
  const auth = await getNotaryGmailClient();
  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.messages.modify({
    userId: "me",
    id: args.message_id,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });
  return ok(`Email ${args.message_id} marked as read.`);
}

export async function gmailNotaryFindEmail(args: {
  query: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const auth = await getNotaryGmailClient();
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    q: args.query,
    maxResults: args.max_results ?? 10,
  });

  const messages = res.data.messages ?? [];
  if (messages.length === 0) return ok("No emails found matching that query.");

  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      })
    )
  );

  const summaries = details.map((d) => {
    const headers = d.data.payload?.headers ?? [];
    const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
    return `ID: ${d.data.id}\nFrom: ${get("From")}\nDate: ${get("Date")}\nSubject: ${get("Subject")}`;
  });

  return ok(summaries.join("\n\n---\n\n"));
}

export async function gmailNotaryGetEmail(args: {
  message_id: string;
}): Promise<CallToolResult> {
  const auth = await getNotaryGmailClient();
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.get({
    userId: "me",
    id: args.message_id,
    format: "full",
  });

  const headers = res.data.payload?.headers ?? [];
  const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";

  let body = "";
  const parts = res.data.payload?.parts ?? [];
  const textPart = parts.find((p) => p.mimeType === "text/plain");
  if (textPart?.body?.data) {
    body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
  } else if (res.data.payload?.body?.data) {
    body = Buffer.from(res.data.payload.body.data, "base64").toString("utf-8");
  }

  return ok([
    `From: ${get("From")}`,
    `To: ${get("To")}`,
    `Date: ${get("Date")}`,
    `Subject: ${get("Subject")}`,
    `Thread ID: ${res.data.threadId}`,
    `Message ID: ${res.data.id}`,
    "",
    body || "(no plain-text body)",
  ].join("\n"));
}

export async function gmailNotaryReplyToEmail(args: {
  message_id: string;
  body: string;
}): Promise<CallToolResult> {
  const auth = await getNotaryGmailClient();
  const gmail = google.gmail({ version: "v1", auth });

  const original = await gmail.users.messages.get({
    userId: "me",
    id: args.message_id,
    format: "metadata",
    metadataHeaders: ["Subject", "From", "Message-ID"],
  });

  const headers = original.data.payload?.headers ?? [];
  const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
  const subject = get("Subject").startsWith("Re:") ? get("Subject") : `Re: ${get("Subject")}`;

  const lines = [
    `To: ${get("From")}`,
    `From: drupenterprise1@gmail.com`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    `In-Reply-To: ${get("Message-ID")}`,
    `References: ${get("Message-ID")}`,
    "",
    args.body,
  ].join("\r\n");

  const raw = Buffer.from(lines).toString("base64url");
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: original.data.threadId! },
  });

  return ok(`Reply sent from drupenterprise1@gmail.com. Message ID: ${res.data.id}`);
}

export async function gmailNotaryArchiveEmail(args: {
  message_id: string;
}): Promise<CallToolResult> {
  const auth = await getNotaryGmailClient();
  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.messages.modify({
    userId: "me",
    id: args.message_id,
    requestBody: { removeLabelIds: ["INBOX"] },
  });
  return ok(`Email ${args.message_id} archived from drupenterprise1@gmail.com.`);
}

// ─── Availability Checker ─────────────────────────────────────────────────────

export async function notaryCheckAvailability(args: {
  requested_date: string;
  requested_time: string;
  signing_address: string;
  estimated_duration_minutes?: number;
}): Promise<CallToolResult> {
  const auth = await getGoogleAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const homeAddress = process.env.NOTARY_HOME_ADDRESS ?? "Sherman Oaks, CA";
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  const duration = args.estimated_duration_minutes ?? 60;

  // Parse requested datetime
  const requestedDateTime = new Date(`${args.requested_date} ${args.requested_time}`);
  const dayStart = new Date(requestedDateTime);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(requestedDateTime);
  dayEnd.setHours(23, 59, 59, 999);

  // Get all events for that day
  const eventsRes = await calendar.events.list({
    calendarId: "primary",
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = eventsRes.data.items ?? [];

  // Find the last event before the requested time
  const priorEvents = events.filter((e) => {
    const end = e.end?.dateTime ? new Date(e.end.dateTime) : null;
    return end && end <= requestedDateTime;
  });

  const lastEvent = priorEvents.at(-1);
  const originAddress = lastEvent?.location ?? homeAddress;
  const originLabel = lastEvent
    ? `last job (${lastEvent.summary ?? "event"} ending at ${lastEvent.end?.dateTime?.slice(11, 16)})`
    : "home";

  // Calculate travel time if Maps API key is available
  let travelInfo = "";
  if (mapsKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(originAddress)}&destinations=${encodeURIComponent(args.signing_address)}&departure_time=now&key=${mapsKey}`;
      const res = await fetch(url);
      const data = await res.json() as any;
      const element = data.rows?.[0]?.elements?.[0];

      if (element?.status === "OK") {
        const driveSeconds = element.duration_in_traffic?.value ?? element.duration?.value ?? 0;
        const driveMinutes = Math.ceil(driveSeconds / 60);
        const arrivalTime = new Date(requestedDateTime.getTime() - driveMinutes * 60 * 1000);
        const bufferMinutes = Math.floor((requestedDateTime.getTime() - new Date().getTime()) / 60000) - driveMinutes;

        let assessment = "";
        if (driveMinutes > (requestedDateTime.getTime() - Date.now()) / 60000) {
          assessment = "❌ CANNOT MAKE IT — not enough time to drive there.";
        } else if (bufferMinutes < 15) {
          assessment = "⚠️ TIGHT — you could make it but it will be very close.";
        } else if (bufferMinutes < 45) {
          assessment = "🟡 DOABLE — you can make it with some buffer.";
        } else {
          assessment = "✅ PLENTY OF TIME — no rush at all.";
        }

        travelInfo = [
          `\nTravel Details:`,
          `  From: ${originAddress} (${originLabel})`,
          `  To: ${args.signing_address}`,
          `  Drive time: ~${driveMinutes} min (${element.distance?.text})`,
          `  Need to leave by: ${arrivalTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
          `\n${assessment}`,
        ].join("\n");
      }
    } catch {
      travelInfo = "\n(Travel time calculation unavailable)";
    }
  } else {
    travelInfo = `\nTravel time: Maps API key not set. Origin would be ${originLabel} at ${originAddress}.`;
  }

  // Format day schedule
  const scheduleLines = events.length === 0
    ? ["  Calendar is clear — starting from home."]
    : events.map((e) => {
        const start = e.start?.dateTime?.slice(11, 16) ?? e.start?.date ?? "?";
        const end = e.end?.dateTime?.slice(11, 16) ?? e.end?.date ?? "?";
        return `  ${start}–${end}: ${e.summary ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}`;
      });

  const result = [
    `Availability Check for ${args.requested_date} at ${args.requested_time}`,
    `Signing location: ${args.signing_address}`,
    `\nYour schedule that day:`,
    ...scheduleLines,
    travelInfo,
  ].join("\n");

  return ok(result);
}

// ─── Travel Time Lookup ───────────────────────────────────────────────────────

export async function notaryGetTravelTime(args: {
  origin: string;
  destination: string;
}): Promise<CallToolResult> {
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!mapsKey) return ok("GOOGLE_MAPS_API_KEY not set in environment.");

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(args.origin)}&destinations=${encodeURIComponent(args.destination)}&departure_time=now&key=${mapsKey}`;
  const res = await fetch(url);
  const data = await res.json() as any;
  const element = data.rows?.[0]?.elements?.[0];

  if (!element || element.status !== "OK") {
    return ok(`Could not calculate travel time. Status: ${element?.status ?? "unknown"}`);
  }

  const driveMinutes = Math.ceil((element.duration_in_traffic?.value ?? element.duration?.value ?? 0) / 60);
  return ok(
    `From: ${args.origin}\nTo: ${args.destination}\nDistance: ${element.distance?.text}\nDrive time: ~${driveMinutes} minutes`
  );
}
