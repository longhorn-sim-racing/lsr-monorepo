import type { TrackStatus } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { isSafeHttpsUrl } from "@/schemas/recruiting.schema";

export const TRACK_STATUS_LABEL: Record<TrackStatus, string> = {
  SUBMITTED: "New",
  IN_REVIEW: "In review",
  INTERVIEW: "Interview",
  ACCEPTED: "Accepted",
  REJECTED: "Not moving forward",
};

/** Badge tone for each status (the admin kit's tones follow the light/dark theme). */
export const TRACK_STATUS_TONE: Record<TrackStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  SUBMITTED: "neutral",
  IN_REVIEW: "warning",
  INTERVIEW: "info",
  ACCEPTED: "success",
  REJECTED: "danger",
};

/** Every status in the order officers think of them (also the filter chips' order). */
export const TRACK_STATUS_ORDER: TrackStatus[] = ["SUBMITTED", "IN_REVIEW", "INTERVIEW", "ACCEPTED", "REJECTED"];

/** Statuses that come with an email (In review sends none). Mirrors statusToTemplate on the server. */
export const STATUSES_WITH_EMAIL: TrackStatus[] = ["INTERVIEW", "ACCEPTED", "REJECTED"];

/** The statuses an officer can set (a team starts at SUBMITTED, which is never set by hand). */
export const OFFICER_SETTABLE: TrackStatus[] = ["IN_REVIEW", "INTERVIEW", "ACCEPTED", "REJECTED"];

export const EMAIL_STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  SENT: "success",
  FAILED: "danger",
  PENDING: "warning",
  CANCELLED: "neutral",
};

export const EMAIL_TEMPLATE_LABEL: Record<string, string> = {
  RECEIVED: "Confirmation",
  INTERVIEW: "Interview invitation",
  ACCEPTED: "Accepted",
  REJECTED: "Not moving forward",
  DEADLINE_REMINDER: "Deadline reminder",
};

const isTrackStatus = (v: string): v is TrackStatus => (TRACK_STATUS_ORDER as string[]).includes(v);

/** Parses a status from a URL or form value; undefined for anything else. */
export function parseTrackStatus(value: string | null | undefined): TrackStatus | undefined {
  return value && isTrackStatus(value) ? value : undefined;
}

/** "Oct 16, 2026, 11:59 PM CT". Everything officers see is in Central time. */
export function formatCentral(date: Date | string | null | undefined, pattern = "MMM d, yyyy, h:mm a"): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  return `${formatInTimeZone(d, DEFAULT_TIMEZONE, pattern)} CT`;
}

/** The host of an https link, for showing next to an applicant-supplied URL. Null if it isn't a clean https link. */
export function domainOf(url: string): string | null {
  if (!isSafeHttpsUrl(url)) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Hosts a booking link is expected to be on (Google Calendar appointment scheduling). */
export const BOOKING_LINK_HOSTS = ["calendar.app.google", "calendar.google.com"] as const;

export function isGoogleBookingHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return BOOKING_LINK_HOSTS.some((h) => host === h);
  } catch {
    return false;
  }
}
