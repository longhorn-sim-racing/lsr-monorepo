import { z } from "zod";
import { fromZonedTime } from "date-fns-tz";
import { dollarsToCents, formatCents } from "@/lib/money";
import { MIN_PRODUCT_CENTS } from "@/schemas/product.schema";

// Matches what slugify() produces: lowercase letters, numbers, underscores, single hyphens between
const SLUG = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const text = z.string().trim();

const link = (label: string) =>
  text
    .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), `${label} must be a full web address, starting with https`)
    .transform((v) => v || null);

/** "" or "-1" mean unlimited; otherwise a whole number of spots */
const capacity = text.transform((value, ctx) => {
  if (value === "" || value === "-1") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    ctx.addIssue({ code: "custom", message: "Capacity must be a whole number of at least 1, or empty for unlimited" });
    return z.NEVER;
  }
  return n;
});

/** Dollars in, cents out. Empty or 0 means a free event. */
const fee = text.transform((value, ctx) => {
  if (value === "") return null;
  const cents = dollarsToCents(value);
  if (cents === null) {
    ctx.addIssue({ code: "custom", message: "Enter the fee in dollars, like 10 or 12.50" });
    return z.NEVER;
  }
  if (cents === 0) return null;
  if (cents < MIN_PRODUCT_CENTS) {
    ctx.addIssue({ code: "custom", message: `Paid events must cost at least ${formatCents(MIN_PRODUCT_CENTS)} (Stripe's minimum)` });
    return z.NEVER;
  }
  return cents;
});

const registrationFields = {
  registrationOpensAt: text,
  registrationClosesAt: text,
  registrationMax: capacity,
  registrationFeeCents: fee,
};

const eventFormSchema = z.object({
  title: text.min(1, "Give the event a title").max(200, "The title is too long (200 characters max)"),
  slug: text.regex(SLUG, "The URL slug can only use lowercase letters, numbers and single hyphens"),
  timezone: text.refine(isTimeZone, "Pick a valid time zone"),
  seriesId: text.transform((v) => v || null),
  venueId: text.transform((v) => v || null),
  startsAtUtc: text.min(1, "Set when the event starts"),
  endsAtUtc: text.min(1, "Set when the event ends"),
  summary: z.string(),
  description: z.string(),
  heroImageUrl: link("The hero image"),
  streamUrl: link("The stream link"),
  ...registrationFields,
  attendanceOpensAt: text,
  attendanceClosesAt: text,
});

const registrationConfigSchema = z.object(registrationFields);

const EVENT_KEYS = Object.keys(eventFormSchema.shape) as (keyof typeof eventFormSchema.shape)[];
const REGISTRATION_KEYS = Object.keys(registrationConfigSchema.shape) as (keyof typeof registrationConfigSchema.shape)[];

function fields<K extends string>(formData: FormData, keys: K[]) {
  return Object.fromEntries(keys.map((k) => [k, String(formData.get(k) ?? "")])) as Record<K, string>;
}

/** A datetime-local value read in the event's zone; undefined when it doesn't parse */
function zoned(value: string, timeZone: string): Date | null | undefined {
  if (!value) return null;
  const date = fromZonedTime(value, timeZone);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

type Problems = string[];

function checkWindow(problems: Problems, label: string, from: Date | null | undefined, to: Date | null | undefined) {
  if (from === undefined || to === undefined) problems.push(`${label} has a date that isn't valid`);
  else if (from && to && from >= to) problems.push(`${label} must close after it opens`);
}

function issueMessages(error: z.ZodError) {
  return error.issues.map((issue) => issue.message);
}

function failure(problems: Problems) {
  return { ok: false as const, error: problems.join(". ") + "." };
}

/** Validates the admin event form and converts it to Event columns */
export function parseEventForm(formData: FormData) {
  const parsed = eventFormSchema.safeParse(fields(formData, EVENT_KEYS));
  if (!parsed.success) return failure(issueMessages(parsed.error));
  const f = parsed.data;
  const problems: Problems = [];

  const startsAtUtc = zoned(f.startsAtUtc, f.timezone);
  const endsAtUtc = zoned(f.endsAtUtc, f.timezone);
  if (!startsAtUtc || !endsAtUtc) problems.push("The start or end time isn't a valid date");
  else if (endsAtUtc < startsAtUtc) problems.push("The event can't end before it starts");

  const registrationOpensAt = zoned(f.registrationOpensAt, f.timezone);
  const registrationClosesAt = zoned(f.registrationClosesAt, f.timezone);
  checkWindow(problems, "Registration", registrationOpensAt, registrationClosesAt);

  const attendanceOpensAt = zoned(f.attendanceOpensAt, f.timezone);
  const attendanceClosesAt = zoned(f.attendanceClosesAt, f.timezone);
  checkWindow(problems, "Check-in", attendanceOpensAt, attendanceClosesAt);

  if (problems.length) return failure(problems);

  const registrationEnabled = formData.get("registrationEnabled") === "on";
  const attendanceEnabled = formData.get("attendanceEnabled") === "on";
  return {
    ok: true as const,
    data: {
      title: f.title,
      slug: f.slug,
      seriesId: f.seriesId,
      venueId: f.venueId,
      timezone: f.timezone,
      startsAtUtc: startsAtUtc as Date,
      endsAtUtc: endsAtUtc as Date,
      summary: f.summary,
      description: f.description,
      heroImageUrl: f.heroImageUrl,
      streamUrl: f.streamUrl,
      registrationEnabled,
      registrationOpensAt: registrationOpensAt ?? null,
      registrationClosesAt: registrationClosesAt ?? null,
      registrationMax: f.registrationMax,
      registrationWaitlistEnabled: formData.get("registrationWaitlistEnabled") === "on",
      registrationFeeCents: f.registrationFeeCents,
      attendanceEnabled,
      attendanceOpensAt: attendanceOpensAt ?? null,
      attendanceClosesAt: attendanceClosesAt ?? null,
    },
  };
}

/** Validates the registration settings card on the event manage page */
export function parseRegistrationConfigForm(formData: FormData, timeZone: string) {
  const parsed = registrationConfigSchema.safeParse(fields(formData, REGISTRATION_KEYS));
  if (!parsed.success) return failure(issueMessages(parsed.error));
  const f = parsed.data;
  const problems: Problems = [];
  const registrationOpensAt = zoned(f.registrationOpensAt, timeZone);
  const registrationClosesAt = zoned(f.registrationClosesAt, timeZone);
  checkWindow(problems, "Registration", registrationOpensAt, registrationClosesAt);
  if (problems.length) return failure(problems);
  return {
    ok: true as const,
    data: {
      registrationEnabled: formData.get("registrationEnabled") === "on",
      registrationOpensAt: registrationOpensAt ?? null,
      registrationClosesAt: registrationClosesAt ?? null,
      registrationMax: f.registrationMax,
      registrationWaitlistEnabled: formData.get("registrationWaitlistEnabled") === "on",
      waitlistAutoPromote: formData.get("waitlistAutoPromote") === "on",
      registrationFeeCents: f.registrationFeeCents,
    },
  };
}
