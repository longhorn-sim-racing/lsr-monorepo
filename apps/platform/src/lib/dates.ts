import { toZonedTime, format } from 'date-fns-tz';

export const TIMEZONES = [
  { value: "America/New_York", label: "Eastern Time (US & Canada)" },
  { value: "America/Chicago", label: "Central Time (US & Canada)" },
  { value: "America/Denver", label: "Mountain Time (US & Canada)" },
  { value: "America/Phoenix", label: "Arizona (No DST)" },
  { value: "America/Los_Angeles", label: "Pacific Time (US & Canada)" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
  { value: "UTC", label: "UTC" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Australia/Sydney", label: "Sydney" },
] as const;

export const DEFAULT_TIMEZONE = "America/Chicago";

/** "CT" rather than CDT/CST, which flips mid-season when daylight saving ends */
export function zoneLabel(date: Date, timeZone: string): string {
  if (timeZone === "America/Chicago") return "CT";
  return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "";
}

/**
 * Converts a UTC Date object to a "YYYY-MM-DDTHH:mm" string 
 * relative to the target timezone.
 * Used for populating <input type="datetime-local" />.
 */
export function dateToZonedValue(date: Date | null | undefined, timeZone: string): string {
  if (!date) return "";
  try {
    const zoned = toZonedTime(date, timeZone);
    return format(zoned, "yyyy-MM-dd'T'HH:mm");
  } catch (e) {
    console.error("Error formatting date", date, timeZone, e);
    return "";
  }
}

/**
 * The America/Chicago calendar day a moment falls on, as midnight UTC of that date: the value to store
 * in a `@db.Date` column. Jack 2.0's daily tables (#188) all key on the club's own day, so an 11 PM
 * CT event counts for that evening rather than the next UTC day.
 */
export function chicagoDay(date: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}
