/**
 * Time payload for the public /now endpoint.
 *
 * Pacific values come from Intl.DateTimeFormat with timeZone
 * "America/Los_Angeles" so PDT/PST swaps automatically; never hardcode the
 * offset. Used by Dispatch when its bash sandbox is unavailable and it
 * cannot run `date` itself.
 */

export interface NowPayload {
  iso_utc: string;
  iso_pacific: string;
  date_pacific: string;
  weekday_pacific: string;
  time_pacific_24h: string;
  time_pacific_12h: string;
  timezone: string;
  tz_offset_minutes: number;
  unix_seconds: number;
}

const PACIFIC_TZ = "America/Los_Angeles";

function pacificParts(d: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return parts;
}

function offsetMinutes(d: Date): number {
  // Compute Pacific offset by diffing the wall clock as rendered in PT
  // against the same instant rendered as UTC. Avoids parsing GMT+/-N strings.
  const utcParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const ptParts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (parts: Intl.DateTimeFormatPart[], type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const utcMs = Date.UTC(
    get(utcParts, "year"),
    get(utcParts, "month") - 1,
    get(utcParts, "day"),
    get(utcParts, "hour") % 24,
    get(utcParts, "minute"),
    get(utcParts, "second"),
  );
  const ptMs = Date.UTC(
    get(ptParts, "year"),
    get(ptParts, "month") - 1,
    get(ptParts, "day"),
    get(ptParts, "hour") % 24,
    get(ptParts, "minute"),
    get(ptParts, "second"),
  );
  return Math.round((ptMs - utcMs) / 60000);
}

function offsetIsoSuffix(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export function buildNowPayload(now: Date = new Date()): NowPayload {
  const parts = pacificParts(now);
  const offMin = offsetMinutes(now);
  const ms = String(now.getUTCMilliseconds()).padStart(3, "0");

  const date_pacific = `${parts.year}-${parts.month}-${parts.day}`;
  // Intl renders midnight as "24" under hour12:false; normalize to "00".
  const hour24 = parts.hour === "24" ? "00" : parts.hour;
  const time_pacific_24h = `${hour24}:${parts.minute}`;
  const iso_pacific = `${date_pacific}T${hour24}:${parts.minute}:${parts.second}.${ms}${offsetIsoSuffix(offMin)}`;

  const hourNum = Number(hour24);
  const ampm = hourNum >= 12 ? "PM" : "AM";
  const hour12 = hourNum % 12 === 0 ? 12 : hourNum % 12;
  const time_pacific_12h = `${hour12}:${parts.minute} ${ampm}`;

  return {
    iso_utc: now.toISOString(),
    iso_pacific,
    date_pacific,
    weekday_pacific: parts.weekday,
    time_pacific_24h,
    time_pacific_12h,
    timezone: PACIFIC_TZ,
    tz_offset_minutes: offMin,
    unix_seconds: Math.floor(now.getTime() / 1000),
  };
}
