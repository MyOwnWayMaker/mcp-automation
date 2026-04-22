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

export async function calendarListEvents(args: {
  calendar_id?: string;
  time_min?: string;
  time_max?: string;
  query?: string;
  max_results?: number;
}): Promise<CallToolResult> {
  const cal = await getCalendar();
  const res = await cal.events.list({
    calendarId: args.calendar_id ?? "primary",
    timeMin: args.time_min ?? new Date().toISOString(),
    timeMax: args.time_max,
    q: args.query,
    maxResults: args.max_results ?? 20,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = res.data.items ?? [];
  if (events.length === 0) return ok("No events found.");

  const lines = events.map((e) => {
    const start = e.start?.dateTime ?? e.start?.date ?? "?";
    const end = e.end?.dateTime ?? e.end?.date ?? "?";
    return `ID: ${e.id}\n${e.summary ?? "(no title)"}\nStart: ${start}\nEnd: ${end}\n${e.location ? `Location: ${e.location}` : ""}`.trim();
  });

  return ok(lines.join("\n\n---\n\n"));
}

type ReminderOverride = { method: "popup" | "email" | "sms"; minutes?: number; hours?: number };

function buildReminders(reminders?: ReminderOverride[]) {
  if (!reminders || reminders.length === 0) return undefined;
  return {
    useDefault: false,
    overrides: reminders.map((r) => ({
      method: r.method,
      minutes: r.hours !== undefined ? r.hours * 60 : (r.minutes ?? 30),
    })),
  };
}

export async function calendarCreateEvent(args: {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  calendar_id?: string;
  color_id?: number;
  reminders?: ReminderOverride[];
}): Promise<CallToolResult> {
  const cal = await getCalendar();
  const reminders = buildReminders(args.reminders);
  const res = await cal.events.insert({
    calendarId: args.calendar_id ?? "primary",
    requestBody: {
      summary: args.title,
      description: args.description,
      location: args.location,
      start: { dateTime: args.start },
      end: { dateTime: args.end },
      attendees: args.attendees?.map((email) => ({ email })),
      ...(args.color_id !== undefined && { colorId: String(args.color_id) }),
      ...(reminders && { reminders }),
    },
  });

  const reminderStr = args.reminders?.map(r => `${r.hours ? r.hours * 60 : r.minutes}min ${r.method}`).join(", ") ?? "default";
  return ok(`Event created: ${res.data.summary}\nID: ${res.data.id}\nLink: ${res.data.htmlLink}\nReminders: ${reminderStr}`);
}

export async function calendarUpdateEvent(args: {
  event_id: string;
  title?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  calendar_id?: string;
  color_id?: number;
  reminders?: ReminderOverride[];
}): Promise<CallToolResult> {
  const cal = await getCalendar();
  const { event_id, calendar_id, title, start, end, description, location } = args;

  const existing = await cal.events.get({
    calendarId: calendar_id ?? "primary",
    eventId: event_id,
  });

  const reminders = buildReminders(args.reminders);
  const updated = {
    ...existing.data,
    ...(title && { summary: title }),
    ...(description !== undefined && { description }),
    ...(location !== undefined && { location }),
    ...(start && { start: { dateTime: start } }),
    ...(end && { end: { dateTime: end } }),
    ...(args.color_id !== undefined && { colorId: String(args.color_id) }),
    ...(reminders && { reminders }),
  };

  const res = await cal.events.update({
    calendarId: calendar_id ?? "primary",
    eventId: event_id,
    requestBody: updated,
  });

  return ok(`Event updated: ${res.data.summary}\nID: ${res.data.id}`);
}

export async function calendarDeleteEvent(args: {
  event_id: string;
  calendar_id?: string;
}): Promise<CallToolResult> {
  const cal = await getCalendar();
  await cal.events.delete({
    calendarId: args.calendar_id ?? "primary",
    eventId: args.event_id,
  });
  return ok(`Event ${args.event_id} deleted.`);
}

export async function calendarListCalendars(): Promise<CallToolResult> {
  const cal = await getCalendar();
  const res = await cal.calendarList.list();
  const calendars = res.data.items ?? [];
  const lines = calendars.map(
    (c) => `ID: ${c.id}\nName: ${c.summary}\nAccess: ${c.accessRole}`
  );
  return ok(lines.join("\n\n---\n\n") || "No calendars found.");
}
