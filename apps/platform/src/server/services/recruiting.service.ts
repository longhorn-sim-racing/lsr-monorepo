// Recruiting rules: drafts, submission, and officer decisions.
//
// Callers (Server Actions / route handlers) are responsible for authenticating:
//  - applicant functions take the SESSION user's id. Never pass an id that came from the
//    client: every applicant query is scoped by it, which is what stops one applicant
//    from reading or changing another's application.
//  - officer functions assume the caller already ran requireOfficer().
// Everything here throws RecruitingError for expected problems, so actions can show the
// message (and field errors / the completeness report) without leaking internals.

import { Prisma, type TrackStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db";
import { createAuditLog } from "@/server/audit/log";
import { cycleWindow, type CycleWindow } from "@/lib/recruiting/cycle";
import * as repo from "@/server/repos/application.repo";
import {
  checkCompleteness,
  draftPatchSchema,
  genericQuestions,
  getTrack,
  isTrackKey,
  parseAnswers,
  questionsForTrack,
  type CompletenessReport,
  type DraftSnapshot,
} from "@/schemas/recruiting.schema";

type Db = Prisma.TransactionClient | typeof prisma;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RecruitingErrorCode =
  | "NO_ACTIVE_ROUND"
  | "ROUND_NOT_OPEN_YET"
  | "ROUND_CLOSED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID"
  | "INCOMPLETE"
  | "ALREADY_SUBMITTED"
  | "SELF_REVIEW"
  | "BAD_STATUS"
  | "INTERVIEW_NOT_OFFERED";

export class RecruitingError extends Error {
  code: RecruitingErrorCode;
  fieldErrors?: Record<string, string>;
  report?: CompletenessReport;

  constructor(
    code: RecruitingErrorCode,
    message: string,
    details?: { fieldErrors?: Record<string, string>; report?: CompletenessReport },
  ) {
    super(message);
    this.name = "RecruitingError";
    this.code = code;
    this.fieldErrors = details?.fieldErrors;
    this.report = details?.report;
  }
}

export function isRecruitingError(e: unknown): e is RecruitingError {
  return e instanceof RecruitingError;
}

function fieldErrorsFromZod(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Applies one page of answers on top of what is stored: every key the page sent is first
 * removed (so clearing a field clears it), then the cleaned non-blank answers are added.
 * Answers on other pages are untouched.
 */
function mergeAnswers(
  existing: unknown,
  touchedKeys: string[],
  cleaned: Record<string, unknown>,
): Prisma.InputJsonObject {
  const base: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  for (const k of touchedKeys) delete base[k];
  return { ...base, ...cleaned } as Prisma.InputJsonObject;
}

/** Locks the application row for the rest of the transaction, then reads it fresh. */
async function lockApplication(tx: Prisma.TransactionClient, id: string) {
  await tx.$executeRaw`SELECT 1 FROM "Application" WHERE id = ${id} FOR UPDATE`;
  return tx.application.findUnique({
    where: { id },
    include: { tracks: { orderBy: { createdAt: "asc" } } },
  });
}

type ApplicationWithTracks = NonNullable<Awaited<ReturnType<typeof repo.findApplicationByUser>>>;

function toSnapshot(app: ApplicationWithTracks): DraftSnapshot {
  return {
    fullName: app.fullName,
    email: app.email,
    eid: app.eid,
    gradYear: app.gradYear,
    major: app.major,
    resumeUrl: app.resumeUrl,
    genericAnswers: app.genericAnswers,
    portfolioLinks: app.portfolioLinks,
    tracks: app.tracks.map((t) => ({ track: t.track, answers: t.answers })),
  };
}

/** The active round, if applications are open right now. Writes are only allowed through this. */
async function requireOpenRound(now: Date, db: Db = prisma) {
  const cycle = await repo.findActiveCycle(db);
  if (!cycle) throw new RecruitingError("NO_ACTIVE_ROUND", "Recruiting is not open right now.");
  const window = cycleWindow(cycle, now);
  if (window === "upcoming") {
    throw new RecruitingError("ROUND_NOT_OPEN_YET", "Applications for this round have not opened yet.");
  }
  if (window === "closed") {
    throw new RecruitingError("ROUND_CLOSED", "Applications for this round are closed.");
  }
  return cycle;
}

// ---------------------------------------------------------------------------
// Applicant: reading
// ---------------------------------------------------------------------------

export async function getActiveRound(now: Date = new Date()) {
  const cycle = await repo.findActiveCycle();
  if (!cycle) return null;
  return { ...cycle, window: cycleWindow(cycle, now) };
}

/** The signed-in user's application in the active round (null if they haven't started). */
export async function getMyApplication(userId: string) {
  const cycle = await repo.findActiveCycle();
  if (!cycle) return null;
  return repo.findApplicationByUser(userId, cycle.id);
}

export type ApplicantStatusView = {
  round: { id: string; name: string; slug: string; opensAt: Date; closesAt: Date; window: CycleWindow } | null;
  application: null | {
    id: string;
    state: "DRAFT" | "SUBMITTED";
    submittedAt: Date | null;
    autoSubmitted: boolean;
    /** A draft whose round has closed: it was not submitted and never will be. */
    expiredUnsubmitted: boolean;
    profile: { fullName: string | null; email: string | null; eid: string | null; gradYear: number | null; major: string | null };
    resumeUrl: string | null;
    portfolioLinks: unknown;
    genericAnswers: unknown;
    tracks: Array<{
      track: string;
      label: string;
      interviewRequired: boolean;
      /** null while still a draft: statuses only mean something once submitted. */
      status: TrackStatus | null;
      answers: unknown;
      /** The team's booking link, only while this team has invited the applicant to interview. */
      bookingUrl: string | null;
    }>;
  };
};

/** Read-only view of the applicant's OWN application, for /apply/status and the review page. */
export async function getApplicantStatus(userId: string, now: Date = new Date()): Promise<ApplicantStatusView> {
  const cycle = await repo.findActiveCycle();
  if (!cycle) return { round: null, application: null };
  const window = cycleWindow(cycle, now);
  const round = { id: cycle.id, name: cycle.name, slug: cycle.slug, opensAt: cycle.opensAt, closesAt: cycle.closesAt, window };

  const app = await repo.findApplicationByUser(userId, cycle.id);
  if (!app) return { round, application: null };

  const configs = await repo.findTrackConfigs(cycle.id);
  const submitted = app.state === "SUBMITTED";

  return {
    round,
    application: {
      id: app.id,
      state: app.state,
      submittedAt: app.submittedAt,
      autoSubmitted: app.autoSubmitted,
      expiredUnsubmitted: app.state === "DRAFT" && window === "closed",
      profile: { fullName: app.fullName, email: app.email, eid: app.eid, gradYear: app.gradYear, major: app.major },
      resumeUrl: app.resumeUrl,
      portfolioLinks: app.portfolioLinks,
      genericAnswers: app.genericAnswers,
      tracks: app.tracks.map((t) => {
        const def = getTrack(t.track);
        const interviewRequired = def?.interviewRequired ?? false;
        const bookingUrl =
          submitted && interviewRequired && t.status === "INTERVIEW"
            ? (configs.find((c) => c.track === t.track)?.schedulingUrl ?? null)
            : null;
        return {
          track: t.track,
          label: def?.label ?? t.track,
          interviewRequired,
          status: submitted ? t.status : null,
          answers: t.answers,
          bookingUrl,
        };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Applicant: drafting
// ---------------------------------------------------------------------------

/**
 * Returns the user's application for the active round, creating an empty draft the first
 * time. Only works while the round is open. The profile fields are copied from their
 * account (their email always stays their account email: decision emails go there).
 */
export async function getOrCreateDraft(userId: string, now: Date = new Date()): Promise<ApplicationWithTracks> {
  const cycle = await requireOpenRound(now);
  const existing = await repo.findApplicationByUser(userId, cycle.id);
  if (existing) return existing;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, displayName: true, email: true, eid: true, gradYear: true, major: true },
  });
  if (!user) throw new RecruitingError("NOT_FOUND", "Account not found.");
  if (user.status !== "active") {
    throw new RecruitingError("FORBIDDEN", "Finish verifying your account before applying.");
  }

  try {
    await prisma.application.create({
      data: {
        cycleId: cycle.id,
        userId,
        formVersion: cycle.formVersion, // always set from the round, never a default
        fullName: user.displayName,
        email: user.email,
        eid: user.eid,
        gradYear: user.gradYear,
        major: user.major,
      },
    });
  } catch (e) {
    // Two tabs created it at the same time: the unique (cycleId, userId) kept it to one.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  const created = await repo.findApplicationByUser(userId, cycle.id);
  if (!created) throw new RecruitingError("NOT_FOUND", "Could not start your application.");
  return created;
}

/**
 * One "Save and continue". `input` is untrusted. Everything is validated first and
 * nothing is written unless all of it is valid. Only the keys sent are touched.
 */
export async function saveDraft(userId: string, input: unknown, now: Date = new Date()) {
  const parsed = draftPatchSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecruitingError("INVALID", "Some answers need attention.", { fieldErrors: fieldErrorsFromZod(parsed.error) });
  }
  const patch = parsed.data;
  const draft = await getOrCreateDraft(userId, now);

  return prisma.$transaction(async (tx) => {
    const app = await lockApplication(tx, draft.id);
    if (!app) throw new RecruitingError("NOT_FOUND", "Application not found.");
    if (app.state !== "DRAFT") {
      throw new RecruitingError("ALREADY_SUBMITTED", "This application has been submitted and can no longer be changed.");
    }
    const account = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });

    const fieldErrors: Record<string, string> = {};
    const data: Prisma.ApplicationUpdateInput = {};
    const trackUpdates: Array<{ id: string; answers: Prisma.InputJsonObject }> = [];

    if (patch.step !== undefined) data.draftStep = patch.step;

    if (patch.profile) {
      const p = patch.profile;
      if (p.email !== undefined && p.email.toLowerCase() !== (account?.email ?? "").toLowerCase()) {
        fieldErrors["profile.email"] = "Your application uses your account email. Change it in your account settings.";
      }
      if (p.fullName !== undefined) data.fullName = p.fullName;
      if (p.eid !== undefined) data.eid = p.eid;
      if (p.gradYear !== undefined) data.gradYear = p.gradYear;
      if (p.major !== undefined) data.major = p.major;
    }

    if (patch.genericAnswers) {
      const r = parseAnswers(genericQuestions, patch.genericAnswers, "draft");
      for (const [id, msg] of Object.entries(r.errors)) fieldErrors[`genericAnswers.${id}`] = msg;
      data.genericAnswers = mergeAnswers(app.genericAnswers, Object.keys(patch.genericAnswers), r.value);
    }

    for (const [key, answers] of Object.entries(patch.trackAnswers ?? {})) {
      const row = app.tracks.find((t) => t.track === key);
      if (!isTrackKey(key) || !row) {
        fieldErrors[`trackAnswers.${key}`] = "Choose this team before answering its questions.";
        continue;
      }
      const r = parseAnswers(questionsForTrack(key), answers, "draft");
      for (const [id, msg] of Object.entries(r.errors)) fieldErrors[`trackAnswers.${key}.${id}`] = msg;
      trackUpdates.push({ id: row.id, answers: mergeAnswers(row.answers, Object.keys(answers), r.value) });
    }

    if (patch.resumeUrl !== undefined) data.resumeUrl = patch.resumeUrl === "" ? null : patch.resumeUrl;
    if (patch.portfolioLinks !== undefined) data.portfolioLinks = patch.portfolioLinks;

    if (Object.keys(fieldErrors).length > 0) {
      throw new RecruitingError("INVALID", "Some answers need attention.", { fieldErrors });
    }

    if (Object.keys(data).length > 0) await tx.application.update({ where: { id: app.id }, data });
    for (const t of trackUpdates) {
      await tx.applicationTrack.update({ where: { id: t.id }, data: { answers: t.answers } });
    }
    return tx.application.findUniqueOrThrow({
      where: { id: app.id },
      include: { tracks: { orderBy: { createdAt: "asc" } } },
    });
  });
}

/**
 * Sets which teams the draft applies to. Teams that are dropped lose their answers
 * (the form asks for confirmation before calling this).
 */
export async function setSelectedTracks(userId: string, keys: unknown, now: Date = new Date()) {
  const parsed = z.array(z.string().max(60)).max(50).safeParse(keys);
  if (!parsed.success) {
    throw new RecruitingError("INVALID", "Choose teams from the list.", { fieldErrors: fieldErrorsFromZod(parsed.error) });
  }
  const wanted = parsed.data;
  if (new Set(wanted).size !== wanted.length) {
    throw new RecruitingError("INVALID", "A team was chosen twice.");
  }
  const unknown = wanted.filter((k) => !isTrackKey(k));
  if (unknown.length > 0) {
    throw new RecruitingError("INVALID", "Choose teams from the list.", { fieldErrors: { tracks: `Unknown team: ${unknown[0]}` } });
  }

  const draft = await getOrCreateDraft(userId, now);

  return prisma.$transaction(async (tx) => {
    const app = await lockApplication(tx, draft.id);
    if (!app) throw new RecruitingError("NOT_FOUND", "Application not found.");
    if (app.state !== "DRAFT") {
      throw new RecruitingError("ALREADY_SUBMITTED", "This application has been submitted and can no longer be changed.");
    }
    const have = app.tracks.map((t) => t.track);
    const removed = have.filter((k) => !wanted.includes(k));
    const added = wanted.filter((k) => !have.includes(k));

    if (removed.length > 0) {
      await tx.applicationTrack.deleteMany({ where: { applicationId: app.id, track: { in: removed } } });
    }
    if (added.length > 0) {
      await tx.applicationTrack.createMany({
        data: added.map((track) => ({ applicationId: app.id, track })),
        skipDuplicates: true,
      });
    }
    const refreshed = await tx.application.findUniqueOrThrow({
      where: { id: app.id },
      include: { tracks: { orderBy: { createdAt: "asc" } } },
    });
    return { added, removed, application: refreshed };
  });
}

// ---------------------------------------------------------------------------
// Applicant: submitting
// ---------------------------------------------------------------------------

/**
 * Turns a locked DRAFT into SUBMITTED. The conditional update (`state = 'DRAFT'`) is what
 * makes a double-click, two tabs, or the deadline sweep racing the Submit button safe:
 * exactly one caller gets `true`. Callers must hold the row lock and have checked
 * completeness. Also used by the deadline sweep (auto = true).
 */
export async function finalizeSubmission(
  tx: Prisma.TransactionClient,
  app: { id: string; userId: string; tracks: Array<{ track: string }> },
  opts: { auto: boolean; now: Date },
): Promise<boolean> {
  const res = await tx.application.updateMany({
    where: { id: app.id, state: "DRAFT" },
    data: { state: "SUBMITTED", submittedAt: opts.now, autoSubmitted: opts.auto },
  });
  if (res.count !== 1) return false;

  await tx.applicationTrack.updateMany({ where: { applicationId: app.id }, data: { status: "SUBMITTED" } });

  await createAuditLog(
    {
      actorUserId: opts.auto ? null : app.userId,
      actionType: opts.auto ? "APPLICATION_AUTO_SUBMITTED" : "APPLICATION_SUBMITTED",
      entityType: "APPLICATION",
      entityId: app.id,
      targetUserId: app.userId,
      summary: opts.auto
        ? "Application auto-submitted at the deadline"
        : `Application submitted (${app.tracks.map((t) => t.track).join(", ")})`,
      after: { state: "SUBMITTED", tracks: app.tracks.map((t) => t.track) },
    },
    tx,
  );
  return true;
}

/** The applicant presses Submit. Final: nothing is editable afterwards. */
export async function submitApplication(userId: string, now: Date = new Date()) {
  const cycle = await requireOpenRound(now);
  const existing = await repo.findApplicationByUser(userId, cycle.id);
  if (!existing) throw new RecruitingError("NOT_FOUND", "Start your application first.");

  return prisma.$transaction(async (tx) => {
    const app = await lockApplication(tx, existing.id);
    if (!app) throw new RecruitingError("NOT_FOUND", "Application not found.");
    if (app.state !== "DRAFT") {
      throw new RecruitingError("ALREADY_SUBMITTED", "This application has already been submitted.");
    }
    const report = checkCompleteness(toSnapshot(app));
    if (!report.complete) {
      throw new RecruitingError("INCOMPLETE", "Your application is not complete yet.", { report });
    }
    const ok = await finalizeSubmission(tx, app, { auto: false, now });
    if (!ok) throw new RecruitingError("ALREADY_SUBMITTED", "This application has already been submitted.");
    return { applicationId: app.id, userId: app.userId, tracks: app.tracks.map((t) => t.track) };
  });
}

// ---------------------------------------------------------------------------
// Officers
// ---------------------------------------------------------------------------

export const listTrackApplications = repo.listSubmittedTracks;
export const countTrackApplications = repo.countSubmittedTracks;

/** Null for drafts and unknown ids, so a draft can never be opened by guessing its id. */
export const getApplicationDetail = repo.findSubmittedApplicationDetail;

/** `SUBMITTED` is the starting status and is never set by an officer. */
const OFFICER_STATUSES: readonly TrackStatus[] = ["IN_REVIEW", "INTERVIEW", "ACCEPTED", "REJECTED"];

/**
 * Sets one team's status for an applicant. Does not send email (that is layered on top).
 * Rules: the application must be submitted; an officer cannot decide their own
 * application; Interview only exists for teams that run interviews (checked here, not
 * just hidden in the UI). Moving back to In review clears the decision fields.
 */
export async function setTrackStatus(
  officerId: string,
  applicationTrackId: string,
  status: TrackStatus,
  now: Date = new Date(),
) {
  if (!OFFICER_STATUSES.includes(status)) {
    throw new RecruitingError("BAD_STATUS", "That status can't be set.");
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "ApplicationTrack" WHERE id = ${applicationTrackId} FOR UPDATE`;
    const row = await tx.applicationTrack.findUnique({
      where: { id: applicationTrackId },
      include: { application: { select: { id: true, userId: true, state: true, cycleId: true } } },
    });
    if (!row || row.application.state !== "SUBMITTED") {
      throw new RecruitingError("NOT_FOUND", "Application not found.");
    }
    if (row.application.userId === officerId) {
      throw new RecruitingError("SELF_REVIEW", "You can't review or decide your own application.");
    }
    if (row.status === status) {
      throw new RecruitingError("BAD_STATUS", "It already has that status.");
    }
    const def = getTrack(row.track);
    if (status === "INTERVIEW" && !def?.interviewRequired) {
      throw new RecruitingError("INTERVIEW_NOT_OFFERED", `${def?.label ?? row.track} does not run interviews.`);
    }

    const decided = status !== "IN_REVIEW";
    await tx.applicationTrack.update({
      where: { id: row.id },
      data: { status, decidedAt: decided ? now : null, decidedById: decided ? officerId : null },
    });
    await createAuditLog(
      {
        actorUserId: officerId,
        actionType: "APPLICATION_TRACK_STATUS_CHANGED",
        entityType: "APPLICATION_TRACK",
        entityId: row.id,
        targetUserId: row.application.userId,
        summary: `${def?.label ?? row.track}: ${row.status} to ${status}`,
        before: { status: row.status },
        after: { status },
        metadata: { applicationId: row.application.id, track: row.track },
      },
      tx,
    );

    return {
      applicationTrackId: row.id,
      applicationId: row.application.id,
      applicantUserId: row.application.userId,
      track: row.track,
      previousStatus: row.status,
      status,
    };
  });
}

const reviewSchema = z
  .object({
    score: z.number().int().min(1, "Scores run from 1 to 5.").max(5, "Scores run from 1 to 5.").optional(),
    notes: z.string().trim().max(2000, "Keep notes under 2000 characters.").optional(),
  })
  .strict()
  .refine((v) => v.score !== undefined || (v.notes ?? "") !== "", { error: "Add a score or a note." });

/** Adds an officer's score and/or note to one team's application. Same self-review rule. */
export async function addReview(officerId: string, applicationTrackId: string, input: unknown) {
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecruitingError("INVALID", "Check the review.", { fieldErrors: fieldErrorsFromZod(parsed.error) });
  }
  const { score, notes } = parsed.data;

  return prisma.$transaction(async (tx) => {
    const row = await tx.applicationTrack.findUnique({
      where: { id: applicationTrackId },
      include: { application: { select: { id: true, userId: true, state: true } } },
    });
    if (!row || row.application.state !== "SUBMITTED") {
      throw new RecruitingError("NOT_FOUND", "Application not found.");
    }
    if (row.application.userId === officerId) {
      throw new RecruitingError("SELF_REVIEW", "You can't review or decide your own application.");
    }
    const review = await tx.applicationReview.create({
      data: { applicationTrackId: row.id, reviewerId: officerId, score: score ?? null, notes: notes || null },
    });
    await createAuditLog(
      {
        actorUserId: officerId,
        actionType: "APPLICATION_REVIEW_ADDED",
        entityType: "APPLICATION_TRACK",
        entityId: row.id,
        targetUserId: row.application.userId,
        summary: `Review added${score !== undefined ? ` (score ${score})` : ""}`,
        metadata: { applicationId: row.application.id, track: row.track, reviewId: review.id },
      },
      tx,
    );
    return review;
  });
}
