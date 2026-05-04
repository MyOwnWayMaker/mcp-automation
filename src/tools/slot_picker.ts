import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  geocode,
  classifyPoint,
  haversineMiles,
  HOME_LAT,
  HOME_LNG,
  type Quadrant,
  type LatLng,
} from "./maps.js";
import { scanCalendarWithQuadrants, type ScannedEvent } from "./calendar_scan.js";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const LA_TZ = "America/Los_Angeles";

// ─── LA-local time helpers ─────────────────────────────────────────────────────

function laOffsetMinutes(at: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    timeZoneName: "longOffset",
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-08:00";
  const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return -480;
  const sign = m[1] === "+" ? 1 : -1;
  return sign * (parseInt(m[2]) * 60 + parseInt(m[3] ?? "0"));
}

function laWallToInstant(y: number, mo: number, d: number, h: number, mi: number): Date {
  // Convert LA wall-clock time -> UTC instant, accounting for DST.
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = laOffsetMinutes(new Date(naiveUtc));
  let inst = naiveUtc - off1 * 60_000;
  const off2 = laOffsetMinutes(new Date(inst));
  if (off2 !== off1) inst = naiveUtc - off2 * 60_000;
  return new Date(inst);
}

function instantToLAParts(d: Date): {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  weekday: string;
  date: string;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const h = parseInt(parts.hour);
  return {
    y: parseInt(parts.year),
    mo: parseInt(parts.month),
    d: parseInt(parts.day),
    h: h === 24 ? 0 : h,
    mi: parseInt(parts.minute),
    weekday: parts.weekday,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function formatLALabel(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function formatLAIso(d: Date): string {
  // ISO with LA offset, e.g. "2026-05-04T09:00:00-07:00"
  const p = instantToLAParts(d);
  const offMin = laOffsetMinutes(d);
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${p.y.toString().padStart(4, "0")}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}T${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}:00${sign}${oh}:${om}`;
}

// ─── Slot picker ───────────────────────────────────────────────────────────────

export type SchedulingSlot = {
  start: string;             // ISO with LA offset
  end: string;
  date: string;              // YYYY-MM-DD (LA local)
  weekday: string;           // "Mon"
  start_label: string;       // "9:00 AM"
  end_label: string;
  rationale: "adjacent_after" | "adjacent_before" | "earliest_free";
  // Only set for adjacent_* — the existing event in the same quadrant.
  adjacent_event?: {
    id: string;
    summary?: string;
    location?: string;
    quadrant?: Quadrant;
    start: string;
    end: string;
  };
  // The closest event before/after this slot that has a location — used by
  // C4 drive-time validation.
  prev_event_with_location?: {
    id: string;
    summary?: string;
    location: string;
    lat: number;
    lng: number;
    end: string;
  };
  next_event_with_location?: {
    id: string;
    summary?: string;
    location: string;
    lat: number;
    lng: number;
    start: string;
  };
};

export type PickSlotsResult =
  | {
      ok: true;
      loss: {
        address: string;
        formatted_address: string;
        lat: number;
        lng: number;
        quadrant: Quadrant;
        distance_miles_from_home: number;
      };
      slots: SchedulingSlot[];
      same_quadrant_match: boolean;
      considered_days: string[];
      working_hours: { start_hour: number; end_hour: number };
      slot_minutes: number;
    }
  | { ok: false; error: string };

/**
 * Step 5 of the post-claim playbook — pick candidate inspection windows.
 *
 * Rules:
 *   1. If any timed event in the next N days falls in the same quadrant as
 *      the loss address, prefer slots adjacent to that event (right after,
 *      then right before).
 *   2. Otherwise produce the earliest-free slots within working hours.
 *
 * Working hours and slot length are configurable but default to 7AM–4PM /
 * 60 min per the playbook. All-day events block their entire day from
 * inspection scheduling. Returns up to `max_slots` candidates ordered by
 * preference, each tagged with prev/next event-with-location so C4 can
 * run a drive-time check without re-scanning the calendar.
 */
export async function pickInspectionSlots(args: {
  loss_address: string;
  days?: number;
  time_min?: string;
  calendar_id?: string;
  max_slots?: number;
  work_start_hour?: number;
  work_end_hour?: number;
  slot_minutes?: number;
}): Promise<PickSlotsResult> {
  const days = args.days ?? 3;
  const workStart = args.work_start_hour ?? 7;
  const workEnd = args.work_end_hour ?? 16;
  const slotMin = args.slot_minutes ?? 60;
  const maxSlots = args.max_slots ?? 5;
  const now = args.time_min ? new Date(args.time_min) : new Date();

  // 1. Geocode + classify the loss address.
  const g = await geocode(args.loss_address);
  if (!g.ok) return { ok: false, error: `geocode failed: ${g.error}` };
  const home: LatLng = { lat: HOME_LAT, lng: HOME_LNG };
  const lossPt: LatLng = { lat: g.lat, lng: g.lng };
  const lossQuadrant = classifyPoint(lossPt, home);
  const distFromHome = haversineMiles(home, lossPt);

  // 2. Scan calendar.
  const scan = await scanCalendarWithQuadrants({
    days,
    calendar_id: args.calendar_id,
    time_min: now.toISOString(),
    max_results: 100,
  });
  if (!scan.ok) return { ok: false, error: `calendar scan failed: ${scan.error}` };

  // 3. Build per-day blocked dates (all-day events) and timed busy intervals.
  const blockedDays = new Set<string>();
  const timedEvents: Array<ScannedEvent & { startMs: number; endMs: number }> = [];
  for (const ev of scan.events) {
    if (ev.all_day) {
      blockedDays.add(ev.start.slice(0, 10)); // YYYY-MM-DD
      continue;
    }
    timedEvents.push({
      ...ev,
      startMs: new Date(ev.start).getTime(),
      endMs: new Date(ev.end).getTime(),
    });
  }
  timedEvents.sort((a, b) => a.startMs - b.startMs);

  // 4. Helpers to find prev/next event-with-location around a given instant.
  const eventsWithLocation = timedEvents.filter(
    (e) => e.lat !== undefined && e.lng !== undefined && e.location,
  );
  const findPrev = (atMs: number) =>
    [...eventsWithLocation].reverse().find((e) => e.endMs <= atMs);
  const findNext = (atMs: number) =>
    eventsWithLocation.find((e) => e.startMs >= atMs);
  const wrapLoc = (e: (typeof eventsWithLocation)[number] | undefined, kind: "prev" | "next") => {
    if (!e) return undefined;
    return {
      id: e.id,
      summary: e.summary,
      location: e.location!,
      lat: e.lat!,
      lng: e.lng!,
      ...(kind === "prev" ? { end: e.end } : { start: e.start }),
    } as any;
  };

  // 5. Build candidate slots.
  const slots: SchedulingSlot[] = [];
  const considered: string[] = [];
  const slotMs = slotMin * 60_000;

  // Helper: try to add a slot at a specific instant. Returns true if added.
  const tryAddSlot = (
    startInstant: Date,
    rationale: SchedulingSlot["rationale"],
    adjacent?: SchedulingSlot["adjacent_event"],
  ): boolean => {
    const startMs = startInstant.getTime();
    const endMs = startMs + slotMs;
    if (startMs < now.getTime()) return false;

    const p = instantToLAParts(startInstant);
    if (blockedDays.has(p.date)) return false;

    // Must be entirely inside working hours (LA-local).
    if (p.h < workStart) return false;
    const endParts = instantToLAParts(new Date(endMs));
    // End may roll past workEnd:
    if (endParts.date !== p.date) return false;
    if (endParts.h > workEnd) return false;
    if (endParts.h === workEnd && endParts.mi > 0) return false;

    // Conflict with any timed event?
    for (const ev of timedEvents) {
      if (ev.startMs < endMs && ev.endMs > startMs) return false;
    }

    // Avoid duplicates.
    if (slots.some((s) => new Date(s.start).getTime() === startMs)) return false;

    const endInstant = new Date(endMs);
    const prevEv = findPrev(startMs);
    const nextEv = findNext(endMs);

    slots.push({
      start: formatLAIso(startInstant),
      end: formatLAIso(endInstant),
      date: p.date,
      weekday: p.weekday,
      start_label: formatLALabel(startInstant),
      end_label: formatLALabel(endInstant),
      rationale,
      adjacent_event: adjacent,
      prev_event_with_location: wrapLoc(prevEv, "prev"),
      next_event_with_location: wrapLoc(nextEv, "next"),
    });
    return true;
  };

  // 5a. Adjacent-to-quadrant slots first.
  const sameQuadrantEvents = timedEvents.filter((e) => e.quadrant === lossQuadrant);
  const same_quadrant_match = sameQuadrantEvents.length > 0;
  for (const ev of sameQuadrantEvents) {
    if (slots.length >= maxSlots) break;
    const evStart = new Date(ev.startMs);
    const evEnd = new Date(ev.endMs);

    // Snap to the slot grid: use the event's actual end as the next slot
    // start, and event's start - slotMin as the candidate before.
    const adjacent = {
      id: ev.id,
      summary: ev.summary,
      location: ev.location,
      quadrant: ev.quadrant,
      start: ev.start,
      end: ev.end,
    };
    // After the event:
    tryAddSlot(evEnd, "adjacent_after", adjacent);
    // Before the event:
    tryAddSlot(new Date(ev.startMs - slotMs), "adjacent_before", adjacent);
  }

  // 5b. Fill remaining capacity with earliest-free slots on the slot grid.
  // Walk each day in [now, now + days), step every slot_minutes within
  // [workStart:00, workEnd:00].
  const startParts = instantToLAParts(now);
  for (let dOffset = 0; dOffset < days && slots.length < maxSlots; dOffset++) {
    // Compute the LA date at (today + dOffset).
    const seed = laWallToInstant(startParts.y, startParts.mo, startParts.d, 12, 0);
    const dayInstant = new Date(seed.getTime() + dOffset * 24 * 60 * 60 * 1000);
    const dp = instantToLAParts(dayInstant);
    considered.push(dp.date);
    if (blockedDays.has(dp.date)) continue;

    for (let h = workStart; h <= workEnd && slots.length < maxSlots; ) {
      const slotStart = laWallToInstant(dp.y, dp.mo, dp.d, h, 0);
      // Round forward to "now" if this slot has already passed.
      if (slotStart.getTime() >= now.getTime()) {
        tryAddSlot(slotStart, "earliest_free");
      }
      // Step by slot_minutes (typically 60).
      const stepHrs = slotMin / 60;
      h = Math.round((h + stepHrs) * 10) / 10;
      // Safety: don't infinite loop if slot_minutes is weird.
      if (stepHrs <= 0) break;
    }
  }

  // 6. Sort: adjacent first (in ev order), then earliest_free by start time.
  slots.sort((a, b) => {
    const rankA = a.rationale === "adjacent_after" ? 0 : a.rationale === "adjacent_before" ? 1 : 2;
    const rankB = b.rationale === "adjacent_after" ? 0 : b.rationale === "adjacent_before" ? 1 : 2;
    if (rankA !== rankB) return rankA - rankB;
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });

  return {
    ok: true,
    loss: {
      address: args.loss_address,
      formatted_address: g.formatted_address,
      lat: g.lat,
      lng: g.lng,
      quadrant: lossQuadrant,
      distance_miles_from_home: Math.round(distFromHome * 10) / 10,
    },
    slots: slots.slice(0, maxSlots),
    same_quadrant_match,
    considered_days: considered,
    working_hours: { start_hour: workStart, end_hour: workEnd },
    slot_minutes: slotMin,
  };
}

export async function pickInspectionSlotsTool(args: {
  loss_address: string;
  days?: number;
  time_min?: string;
  calendar_id?: string;
  max_slots?: number;
  work_start_hour?: number;
  work_end_hour?: number;
  slot_minutes?: number;
}): Promise<CallToolResult> {
  const result = await pickInspectionSlots(args);
  return ok(JSON.stringify(result, null, 2));
}
