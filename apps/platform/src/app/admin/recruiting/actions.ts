"use server";

import { revalidatePath } from "next/cache";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { requireOfficer } from "@/server/auth/guards";
import { unexpectedError } from "@/lib/action-result";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import type { RecruitingActionResult } from "@/lib/recruiting/action-result";
import { addReview, isRecruitingError, RecruitingError } from "@/server/services/recruiting.service";
import { bulkDecide, decideAndNotify, previewDecisionEmail, resendAllFailed, resendEmail, sweepAndNotify } from "@/server/services/recruiting-email.service";
import { createCycle, deleteCycle, saveTrackConfig, setActiveCycle, updateCycle } from "@/server/services/recruiting-cycle.service";

// Server actions can be called by anyone who can craft a request, so each one checks that the
// caller is an officer itself and validates everything it receives. Problems come back as
// { ok: false, error } instead of being thrown (production hides a thrown error's message).

const idSchema = z.string().min(1).max(64);
const statusSchema = z.enum(["IN_REVIEW", "INTERVIEW", "ACCEPTED", "REJECTED"]);
/** The status the officer saw when they decided (SUBMITTED included: a new application has not been touched yet) */
const expectedStatusSchema = z.enum(["SUBMITTED", "IN_REVIEW", "INTERVIEW", "ACCEPTED", "REJECTED"]);
const overrideSchema = z.object({ subject: z.string().max(400), body: z.string().max(10000) }).strict().optional();

/** `revalidate: false` for actions that only read, so they don't re-run the pages or fill the audit log with page views. */
async function run<T>(work: (officerId: string) => Promise<T>, options: { revalidate?: boolean } = {}): Promise<RecruitingActionResult<T>> {
  let officerId: string;
  try {
    officerId = (await requireOfficer()).id;
  } catch {
    return { ok: false, error: "You don't have permission to do that." };
  }
  try {
    const data = await work(officerId);
    if (options.revalidate !== false) revalidatePath("/admin/recruiting", "layout");
    return { ok: true, data };
  } catch (e) {
    if (isRecruitingError(e)) return { ok: false, error: e.message, fieldErrors: e.fieldErrors, code: e.code };
    if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? "Check what you entered." };
    console.error("[Recruiting] Action failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: unexpectedError(e) };
  }
}

/** A <input type="datetime-local"> value ("2026-10-16T23:59") is Central time; the database stores UTC. */
function parseCentral(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new RecruitingError("INVALID", "Check the date and time.", { fieldErrors: { [field]: "Pick a date and time." } });
  }
  const date = fromZonedTime(value, DEFAULT_TIMEZONE);
  if (Number.isNaN(date.getTime())) {
    throw new RecruitingError("INVALID", "Check the date and time.", { fieldErrors: { [field]: "That isn't a real date and time." } });
  }
  return date;
}

// ---------------------------------------------------------------------------
// Decisions, reviews, email
// ---------------------------------------------------------------------------

/** What would be emailed for this decision, as editable text plus rendered HTML. Writes nothing. */
export async function previewDecisionAction(applicationTrackId: string, status: string, override?: { subject: string; body: string }) {
  return run(
    async () => previewDecisionEmail(idSchema.parse(applicationTrackId), statusSchema.parse(status), overrideSchema.parse(override)),
    { revalidate: false },
  );
}

export async function decideAction(
  applicationTrackId: string,
  status: string,
  options: { sendEmail?: boolean; override?: { subject: string; body: string }; expectedStatus: string },
) {
  return run(async (officerId) =>
    decideAndNotify(officerId, idSchema.parse(applicationTrackId), statusSchema.parse(status), {
      sendEmail: z.boolean().optional().parse(options.sendEmail),
      override: overrideSchema.parse(options.override),
      expectedStatus: expectedStatusSchema.parse(options.expectedStatus),
    }),
  );
}

export async function bulkDecideAction(
  applicationTrackIds: string[],
  status: string,
  options: { sendEmail?: boolean; ignoreLimit?: boolean; expectedStatuses: Record<string, string> },
) {
  return run(async (officerId) =>
    bulkDecide(officerId, applicationTrackIds, statusSchema.parse(status), {
      sendEmail: z.boolean().optional().parse(options.sendEmail),
      expectedStatuses: z.record(idSchema, expectedStatusSchema).parse(options.expectedStatuses),
      ignoreLimit: z.boolean().optional().parse(options.ignoreLimit),
    }),
  );
}

export async function addReviewAction(applicationTrackId: string, input: { score?: number; notes?: string }) {
  return run(async (officerId) => {
    const review = await addReview(officerId, idSchema.parse(applicationTrackId), input);
    return { id: review.id };
  });
}

export async function resendEmailAction(emailId: string) {
  return run(async (officerId) => resendEmail(officerId, idSchema.parse(emailId)));
}

export async function resendAllFailedAction(cycleId: string, options: { ignoreLimit?: boolean } = {}) {
  return run(async (officerId) =>
    resendAllFailed(officerId, idSchema.parse(cycleId), { ignoreLimit: z.boolean().optional().parse(options.ignoreLimit) }),
  );
}

/**
 * "Run sweep now" for a closed round: the same job the cron runs every 15 minutes. Does nothing
 * before the deadline, and nothing new if it has already run.
 */
export async function runSweepAction(cycleId: string) {
  return run(async () => sweepAndNotify({ cycleId: idSchema.parse(cycleId) }));
}

// ---------------------------------------------------------------------------
// Rounds and booking links
// ---------------------------------------------------------------------------

export async function createCycleAction(input: { name: string; slug: string; opensAt: string; closesAt: string }) {
  return run(async (officerId) => {
    const cycle = await createCycle(officerId, {
      name: z.string().parse(input.name),
      slug: z.string().parse(input.slug),
      opensAt: parseCentral(input.opensAt, "opensAt"),
      closesAt: parseCentral(input.closesAt, "closesAt"),
    });
    return { id: cycle.id, slug: cycle.slug, copiedLinks: cycle.copiedLinks };
  });
}

export async function updateCycleAction(cycleId: string, input: { name: string; opensAt: string; closesAt: string }) {
  return run(async (officerId) => {
    await updateCycle(officerId, idSchema.parse(cycleId), {
      name: z.string().parse(input.name),
      opensAt: parseCentral(input.opensAt, "opensAt"),
      closesAt: parseCentral(input.closesAt, "closesAt"),
    });
    return undefined;
  });
}

/** Pass null to turn recruiting off (no active round). */
export async function setActiveCycleAction(cycleId: string | null) {
  return run(async (officerId) => {
    await setActiveCycle(officerId, cycleId === null ? null : idSchema.parse(cycleId));
    return undefined;
  });
}

export async function deleteCycleAction(cycleId: string) {
  return run(async (officerId) => {
    await deleteCycle(officerId, idSchema.parse(cycleId));
    return undefined;
  });
}

export async function saveBookingLinkAction(cycleId: string, track: string, schedulingUrl: string, allowOtherHost = false) {
  return run(async (officerId) => {
    await saveTrackConfig(officerId, idSchema.parse(cycleId), z.string().max(60).parse(track), z.string().max(2100).parse(schedulingUrl), {
      allowOtherHost: z.boolean().parse(allowOtherHost),
    });
    return undefined;
  });
}
