import { google } from "googleapis";
import { getGoogleAuthClient } from "../auth/google.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

async function getCalendar() {
  const auth = await getGoogleAuthClient();
  return google.calendar({ version: "v3", auth });
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export async function meetScheduleMeeting(args: {
  title: string;
  start: string;
  end: string;
  attendees?: string[];
  description?: string;
  calendar_id?: string;
}): Promise<CallToolResult> {
  const cal = await getCalendar();

  const res = await cal.events.insert({
    calendarId: args.calendar_id ?? "primary",
    conferenceDataVersion: 1,
    requestBody: {
      summary: args.title,
      description: args.description,
      start: { dateTime: args.start },
      end: { dateTime: args.end },
      attendees: args.attendees?.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  const meetLink = res.data.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video"
  )?.uri ?? "Link not generated yet";

  return ok(
    `Meeting scheduled: ${res.data.summary}\n` +
    `Event ID: ${res.data.id}\n` +
    `Start: ${res.data.start?.dateTime}\n` +
    `End: ${res.data.end?.dateTime}\n` +
    `Google Meet link: ${meetLink}\n` +
    `Calendar link: ${res.data.htmlLink}`
  );
}

export async function meetGetMeeting(args: {
  event_id: string;
  calendar_id?: string;
}): Promise<CallToolResult> {
  const cal = await getCalendar();
  const res = await cal.events.get({
    calendarId: args.calendar_id ?? "primary",
    eventId: args.event_id,
  });

  const meetLink = res.data.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video"
  )?.uri ?? "No Meet link";

  const attendees = res.data.attendees?.map((a) => `  - ${a.email} (${a.responseStatus})`).join("\n") ?? "  None";

  return ok(
    `Title: ${res.data.summary}\n` +
    `Start: ${res.data.start?.dateTime}\n` +
    `End: ${res.data.end?.dateTime}\n` +
    `Meet link: ${meetLink}\n` +
    `Attendees:\n${attendees}`
  );
}

export async function meetCancelMeeting(args: {
  event_id: string;
  calendar_id?: string;
}): Promise<CallToolResult> {
  const cal = await getCalendar();
  await cal.events.delete({
    calendarId: args.calendar_id ?? "primary",
    eventId: args.event_id,
  });
  return ok(`Meeting ${args.event_id} cancelled.`);
}
