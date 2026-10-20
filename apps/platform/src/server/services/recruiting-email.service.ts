// Recruiting email: composing, queuing, delivering, resending.
//
// How a decision email travels:
//   1. decideAndNotify() calls setTrackStatus() with an email hook. Inside ONE transaction the
//      status changes AND an ApplicationEmail row is inserted as PENDING with the final subject
//      and body. If the email can't be built (e.g. the team has no booking link) the whole
//      change rolls back, so a decision is never saved without the email that was asked for.
//   2. After the commit, deliverEmail() renders and sends it through Resend, then marks the row
//      SENT or FAILED. A Resend outage can't undo a decision: the row stays and can be resent.
//   3. A row left PENDING because the process died is turned into FAILED by
//      failInterruptedEmails(), and then shows up for a manual Resend.
//
// These emails ignore the member's marketing/notification preferences on purpose: a decision
// about an application is not marketing. They go to the applicant's ACCOUNT email.

import { randomUUID } from "node:crypto";
import type { Prisma, TrackStatus } from "@prisma/client";
import { prisma } from "@/server/db";
import { createAuditLog } from "@/server/audit/log";
import { sendEmail } from "@/lib/email/resend";
import { z } from "zod";
import { getSiteUrl } from "@/lib/site-url";
import {
  composeEmail,
  defaultDraft,
  EmailComposeError,
  renderEmail,
  type EmailDraft,
  type RecruitingEmailTemplate,
} from "@/lib/email/templates/recruiting";
import { getTrack, isSafeHttpsUrl } from "@/schemas/recruiting.schema";
import { getEmailUsage, TRANSACTIONAL_HEADROOM } from "@/server/services/notification.service";
import {
  DECISION_TEMPLATES,
  RecruitingError,
  setTrackStatus,
  submitApplication,
  sweepCycle,
  type EmailHook,
  type QueuedEmail,
} from "@/server/services/recruiting.service";

type Db = Prisma.TransactionClient | typeof prisma;

/** Which email goes with a status. In review (and Submitted) send none. */
export function statusToTemplate(status: TrackStatus): RecruitingEmailTemplate | null {
  switch (status) {
    case "INTERVIEW":
      return "INTERVIEW";
    case "ACCEPTED":
      return "ACCEPTED";
    case "REJECTED":
      return "REJECTED";
    default:
      return null;
  }
}

const replyToAddress = () => process.env.RECRUITING_REPLY_TO?.trim() || undefined;

function composeOrThrow(draft: EmailDraft, values: Parameters<typeof composeEmail>[1]): EmailDraft {
  try {
    return composeEmail(draft, values);
  } catch (e) {
    if (!(e instanceof EmailComposeError)) throw e;
    if (e.code === "MISSING_VALUE" && e.tokens.includes("schedulingLink")) {
      throw new RecruitingError(
        "MISSING_SCHEDULING_LINK",
        "This team has no booking link yet. Add one, or edit the message so it doesn't use the link.",
        { fieldErrors: { body: e.message } },
      );
    }
    throw new RecruitingError("INVALID", e.message, { fieldErrors: { body: e.message } });
  }
}

// ---------------------------------------------------------------------------
// Composing
// ---------------------------------------------------------------------------

/**
 * Builds the email for one team's decision from the default draft (or the officer's edited
 * subject/body for this one person), filled in with the applicant's details. Read-only.
 */
export async function composeTrackEmail(
  db: Db,
  applicationTrackId: string,
  template: RecruitingEmailTemplate,
  override?: EmailDraft,
): Promise<QueuedEmail> {
  const row = await db.applicationTrack.findUnique({
    where: { id: applicationTrackId },
    select: {
      id: true,
      track: true,
      application: {
        select: {
          id: true,
          state: true,
          cycleId: true,
          fullName: true,
          user: { select: { email: true, displayName: true } },
          cycle: { select: { name: true } },
        },
      },
    },
  });
  if (!row || row.application.state !== "SUBMITTED") {
    throw new RecruitingError("NOT_FOUND", "Application not found.");
  }

  const config = await db.recruitingTrackConfig.findUnique({
    where: { cycleId_track: { cycleId: row.application.cycleId, track: row.track } },
    select: { schedulingUrl: true },
  });
  // Only a well-formed https link is ever put in an email
  const schedulingUrl = config?.schedulingUrl && isSafeHttpsUrl(config.schedulingUrl) ? config.schedulingUrl : null;

  const draft = override ?? defaultDraft(template, { hasSchedulingLink: Boolean(schedulingUrl) });
  const composed = composeOrThrow(draft, {
    // Braces are dropped: an edited email is composed a second time, and a name must never read as a placeholder then
    applicantName: (row.application.fullName?.trim() || row.application.user.displayName).replace(/[{}]/g, ""),
    trackName: getTrack(row.track)?.label ?? row.track,
    cycleName: row.application.cycle.name,
    schedulingLink: schedulingUrl,
    statusUrl: `${getSiteUrl()}/apply/status`,
    replyToEmail: replyToAddress(),
  });

  return {
    applicationId: row.application.id,
    applicationTrackId: row.id,
    template,
    toEmail: row.application.user.email,
    ...composed,
  };
}

/**
 * Preview for the officer's decision dialog: what would be sent for this status, with editable
 * subject/body. Returns null for a status that sends nothing. Nothing is written.
 */
export async function previewDecisionEmail(applicationTrackId: string, status: TrackStatus, override?: EmailDraft) {
  const template = statusToTemplate(status);
  if (!template) return null;
  const email = await composeTrackEmail(prisma, applicationTrackId, template, override);
  return {
    template,
    to: email.toEmail,
    subject: email.subject,
    body: email.body,
    html: renderEmail({ subject: email.subject, body: email.body }).html,
    /** Every email says "just reply", so in production replies need somewhere to go besides the noreply address */
    replyToMissing: process.env.NODE_ENV === "production" && !replyToAddress(),
  };
}

/**
 * The confirmation email for a submission. A failure to build it must never block the
 * submission itself, so problems are logged and no email is queued.
 */
export const receivedEmailHook: EmailHook<{ applicationId: string; userId: string; auto: boolean }> = async (tx, ctx) => {
  try {
    const app = await tx.application.findUnique({
      where: { id: ctx.applicationId },
      select: {
        fullName: true,
        user: { select: { email: true, displayName: true } },
        cycle: { select: { name: true } },
        tracks: { select: { track: true }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!app) return null;
    const composed = composeEmail(defaultDraft("RECEIVED", { autoSubmitted: ctx.auto }), {
      applicantName: app.fullName?.trim() || app.user.displayName,
      cycleName: app.cycle.name,
      trackList: app.tracks.map((t) => getTrack(t.track)?.label ?? t.track).join(", "),
      statusUrl: `${getSiteUrl()}/apply/status`,
      replyToEmail: replyToAddress(),
    });
    return {
      applicationId: ctx.applicationId,
      applicationTrackId: null,
      template: "RECEIVED",
      toEmail: app.user.email,
      ...composed,
    };
  } catch (e) {
    console.error("[Recruiting] Could not build the confirmation email:", e instanceof Error ? e.message : e);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Delivering
// ---------------------------------------------------------------------------

export type DeliveryResult = {
  emailId: string;
  /** SKIPPED: the row wasn't PENDING (already sent, failed, or cancelled), so nothing was sent. */
  status: "SENT" | "FAILED" | "SKIPPED";
  error?: string;
};

/** Marks a row that was left PENDING by a crash, so the officer sees why and the idempotency key is reused. */
export const INTERRUPTED_ERROR = "Interrupted before it finished sending";
export const DAILY_LIMIT_ERROR = "Not sent: today's email limit was reached. Resend it after the limit resets.";
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;
/** The cron retries rows PENDING for longer than this (a send takes seconds; the key makes a retry safe) */
const PENDING_RETRY_AFTER_MS = 2 * 60 * 1000;

type SendableRow = { id: string; toEmail: string; subject: string; body: string; idempotencyKey?: string | null };

/** The key a row is sent with. Stored on resend; a first send uses the row id. */
const keyFor = (row: { id: string; idempotencyKey?: string | null }) => row.idempotencyKey ?? `recruiting-email:${row.id}`;

async function markFailed(id: string, error: string): Promise<DeliveryResult> {
  await prisma.applicationEmail.update({ where: { id }, data: { status: "FAILED", error: error.slice(0, 500) } });
  return { emailId: id, status: "FAILED", error };
}

async function sendRow(row: SendableRow): Promise<DeliveryResult> {
  // Only the Resend call decides "failed". Once Resend has accepted the email, a problem saving
  // that fact must not mark it failed (a resend would deliver it twice).
  let result: Awaited<ReturnType<typeof sendEmail>>;
  try {
    const rendered = renderEmail({ subject: row.subject, body: row.body });
    result = await sendEmail(
      { to: row.toEmail, subject: rendered.subject, html: rendered.html, text: rendered.text, replyTo: replyToAddress() },
      { idempotencyKey: keyFor(row) },
    );
  } catch (e) {
    return await markFailed(row.id, `Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!result.success) return await markFailed(row.id, result.error ?? "Send failed");
  try {
    await prisma.applicationEmail.update({
      where: { id: row.id },
      data: { status: "SENT", resendMessageId: result.messageId ?? null, sentAt: new Date(), error: null },
    });
  } catch (e) {
    // The row stays PENDING; the cron retries it with the same key, which makes Resend return
    // this same message instead of sending another.
    console.error("[Recruiting] Email was sent but could not be recorded:", e instanceof Error ? e.message : e);
  }
  return { emailId: row.id, status: "SENT" };
}

/**
 * Sends a PENDING email. The idempotency key is stored on the row (the row id for a first send),
 * so two deliveries racing for the same row (or a retry after a lost response) cannot send it twice.
 */
export async function deliverEmail(emailId: string): Promise<DeliveryResult> {
  const row = await prisma.applicationEmail.findUnique({
    where: { id: emailId },
    select: { id: true, status: true, toEmail: true, subject: true, body: true, idempotencyKey: true },
  });
  if (!row) throw new RecruitingError("NOT_FOUND", "Email not found.");
  if (row.status !== "PENDING") return { emailId, status: row.status === "SENT" ? "SENT" : "SKIPPED" };
  return sendRow(row);
}

/** deliverEmail that never throws: the change it follows is already saved and must stay saved. */
export async function deliverEmailSafely(emailId: string): Promise<DeliveryResult> {
  try {
    return await deliverEmail(emailId);
  } catch (e) {
    console.error("[Recruiting] Delivery failed before it could be recorded:", e instanceof Error ? e.message : e);
    return { emailId, status: "FAILED", error: "Could not send. It will show up for a manual resend." };
  }
}

/**
 * Manual Resend of a FAILED email. The row is claimed (FAILED to PENDING, with the time and the
 * key it will be sent with) atomically, so a double click can't send twice. A normal failure gets
 * a fresh idempotency key (a reused key would just return the old failure); a row that was
 * interrupted before any result was recorded reuses its stored key, so if it had in fact been
 * delivered Resend won't send a duplicate.
 *
 * A decision email is only resent while it still matches the team's current status: after the
 * decision changed, an old "You're in" must never go out.
 */
export async function resendEmail(officerId: string, emailId: string): Promise<DeliveryResult> {
  const row = await prisma.applicationEmail.findUnique({
    where: { id: emailId },
    select: {
      id: true,
      status: true,
      error: true,
      template: true,
      toEmail: true,
      subject: true,
      body: true,
      idempotencyKey: true,
      applicationTrack: { select: { status: true } },
      application: { select: { id: true, userId: true, user: { select: { email: true } } } },
    },
  });
  if (!row) throw new RecruitingError("NOT_FOUND", "Email not found.");
  if (row.status !== "FAILED") throw new RecruitingError("BAD_STATUS", "Only failed emails can be resent.");

  if ((DECISION_TEMPLATES as readonly string[]).includes(row.template)) {
    const current = row.applicationTrack ? statusToTemplate(row.applicationTrack.status) : null;
    if (current !== row.template) {
      await prisma.applicationEmail.updateMany({
        where: { id: row.id, status: "FAILED" },
        data: { status: "CANCELLED", error: "Cancelled: the decision changed before this was sent" },
      });
      throw new RecruitingError("BAD_STATUS", "The decision has changed since this email was written, so it was cancelled instead of sent.");
    }
  }

  // An interrupted send may already have been delivered: keep its recipient and key so Resend can
  // recognise it. Any other resend is a fresh send, and goes to the applicant's CURRENT account email
  // (they may have changed it since), like a new decision would.
  const interrupted = row.error === INTERRUPTED_ERROR;
  const key = interrupted ? keyFor(row) : `recruiting-email:${row.id}:${randomUUID()}`;
  const toEmail = interrupted ? row.toEmail : row.application.user.email;
  const claim = await prisma.applicationEmail.updateMany({
    where: { id: row.id, status: "FAILED" },
    data: { status: "PENDING", claimedAt: new Date(), idempotencyKey: key, toEmail },
  });
  if (claim.count !== 1) throw new RecruitingError("BAD_STATUS", "That email is already being resent.");

  await createAuditLog({
    actorUserId: officerId,
    actionType: "APPLICATION_EMAIL_RESENT",
    entityType: "APPLICATION_EMAIL",
    entityId: row.id,
    targetUserId: row.application.userId,
    summary: "Resent a failed recruiting email",
    metadata: {
      applicationId: row.application.id,
      previousError: row.error,
      ...(toEmail !== row.toEmail ? { recipientChanged: { from: row.toEmail, to: toEmail } } : {}),
    },
  });

  return sendRow({ ...row, toEmail, idempotencyKey: key });
}

/**
 * Turns emails stuck PENDING (the process died mid-send) into FAILED so they can be resent. The
 * clock runs from when the send was claimed (a resend sets it), not from when the row was created.
 */
export async function failInterruptedEmails(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PENDING_TIMEOUT_MS);
  const res = await prisma.applicationEmail.updateMany({
    where: { status: "PENDING", OR: [{ claimedAt: { lt: cutoff } }, { claimedAt: null, createdAt: { lt: cutoff } }] },
    data: { status: "FAILED", error: INTERRUPTED_ERROR },
  });
  return res.count;
}

/** Ids of rows that have been PENDING for a couple of minutes, so a cron run can finish what a dead request started. */
async function stalePendingEmailIds(now: Date, take = 50): Promise<string[]> {
  const cutoff = new Date(now.getTime() - PENDING_RETRY_AFTER_MS);
  const rows = await prisma.applicationEmail.findMany({
    where: { status: "PENDING", OR: [{ claimedAt: { lt: cutoff } }, { claimedAt: null, createdAt: { lt: cutoff } }] },
    orderBy: { createdAt: "asc" },
    take,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** For the officers' "emails that need attention" page: failed and still-pending mail for a round. */
export async function listEmailsNeedingAttention(cycleId: string, now: Date = new Date()) {
  await failInterruptedEmails(now);
  return prisma.applicationEmail.findMany({
    where: { status: { in: ["FAILED", "PENDING"] }, application: { cycleId } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      template: true,
      subject: true,
      status: true,
      error: true,
      createdAt: true,
      toEmail: true,
      applicationTrackId: true,
      application: { select: { id: true, fullName: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// The two entry points the app calls
// ---------------------------------------------------------------------------

/** The applicant presses Submit: submits, queues the confirmation in the same transaction, then sends it. */
export async function submitAndNotify(userId: string, now: Date = new Date()) {
  const result = await submitApplication(userId, now, { email: receivedEmailHook });
  const delivery = result.emailId ? await deliverEmailSafely(result.emailId) : null;
  return { ...result, delivery };
}

export type SweepSummary = {
  cycles: number;
  submitted: number;
  emailsSent: number;
  emailsFailed: number;
  /** Confirmations over today's email limit; they wait on the Emails page for a resend */
  emailsOverLimit: number;
  skippedNoTeams: number;
  skippedIncomplete: number;
  failed: number;
  timedOut: boolean;
  interruptedEmails: number;
};

/** The whole deadline job has to fit in the 60 s the cron route is allowed to run */
const SWEEP_BUDGET_MS = 40_000;

/**
 * The deadline job end to end: for every closed round that still has drafts, auto-submit the complete
 * ones (the "received" confirmation, auto-submit wording, is queued in the same transaction), then
 * send the confirmations after the commits. A confirmation that fails to send stays on the Emails page
 * for a manual resend; it never undoes a submission. Confirmations from an earlier run that never got
 * sent (the function died, or ran out of time) are retried first. Safe to run as often as you like.
 * `cycleId` limits it to one round (the admin button, which also re-checks a round already swept);
 * the cron passes none and skips rounds it has already been through cleanly.
 */
export async function sweepAndNotify(options: { cycleId?: string; now?: Date } = {}): Promise<SweepSummary> {
  const now = options.now ?? new Date();
  const started = Date.now();
  const summary: SweepSummary = {
    cycles: 0,
    submitted: 0,
    emailsSent: 0,
    emailsFailed: 0,
    emailsOverLimit: 0,
    skippedNoTeams: 0,
    skippedIncomplete: 0,
    failed: 0,
    timedOut: false,
    interruptedEmails: 0,
  };

  // One quota check for the whole run; each send below spends from it
  let allowance = (await getEmailQuota()).left;
  const send = async (emailId: string) => {
    if (allowance !== null && allowance <= 0) {
      await markFailed(emailId, DAILY_LIMIT_ERROR);
      summary.emailsOverLimit += 1;
      return;
    }
    if (allowance !== null) allowance -= 1;
    const delivery = await deliverEmailSafely(emailId);
    if (delivery.status === "SENT") summary.emailsSent += 1;
    else if (delivery.status === "FAILED") summary.emailsFailed += 1;
  };

  for (const emailId of await stalePendingEmailIds(now)) await send(emailId);
  summary.interruptedEmails = await failInterruptedEmails(now);

  const cycles = await prisma.recruitingCycle.findMany({
    where: {
      ...(options.cycleId ? { id: options.cycleId } : { sweptAt: null }),
      closesAt: { lte: now },
      applications: { some: { state: "DRAFT" } },
    },
    orderBy: { closesAt: "asc" },
    select: { id: true },
  });

  for (const { id } of cycles) {
    const remaining = SWEEP_BUDGET_MS - (Date.now() - started);
    if (remaining <= 0) {
      summary.timedOut = true;
      break;
    }
    const swept = await sweepCycle(id, now, { email: receivedEmailHook, budgetMs: remaining });
    if (!swept.ran) continue;
    summary.cycles += 1;
    summary.submitted += swept.submitted;
    summary.skippedNoTeams += swept.skippedNoTeams;
    summary.skippedIncomplete += swept.skippedIncomplete;
    summary.failed += swept.failed;
    summary.timedOut = summary.timedOut || swept.timedOut;
    for (const emailId of swept.emailIds) await send(emailId);
    // Everything left is an abandoned draft: stop looking at this round every 15 minutes
    if (!swept.timedOut && !swept.reopened && swept.failed === 0) {
      await prisma.recruitingCycle.updateMany({ where: { id, sweptAt: null }, data: { sweptAt: now } });
    }
  }
  return summary;
}

/**
 * An officer sets a team's status. With `sendEmail`, the matching email (the default draft, or
 * the officer's edited subject/body for this one person) is queued atomically with the change
 * and sent right after it commits.
 */
export async function decideAndNotify(
  officerId: string,
  applicationTrackId: string,
  status: TrackStatus,
  options: { sendEmail?: boolean; override?: EmailDraft; expectedStatus?: TrackStatus; now?: Date } = {},
) {
  const template = statusToTemplate(status);
  if (options.sendEmail && !template) {
    throw new RecruitingError("BAD_STATUS", "No email is sent for that status.");
  }
  const decision = await setTrackStatus(
    officerId,
    applicationTrackId,
    status,
    options.now ?? new Date(),
    options.sendEmail && template
      ? { email: (tx, ctx) => composeTrackEmail(tx, ctx.applicationTrackId, template, options.override) }
      : {},
    options.expectedStatus,
  );
  const delivery = decision.emailId ? await deliverEmailSafely(decision.emailId) : null;
  return { ...decision, delivery };
}

// ---------------------------------------------------------------------------
// Daily email quota and bulk operations
// ---------------------------------------------------------------------------

export type EmailQuota = {
  sentToday: number;
  dailyLimit: number | null;
  /** What recruiting may still send today: the limit minus what was sent and the emails held back for receipts. null = no limit. */
  left: number | null;
};

/**
 * Emails Resend has accepted since 00:00 UTC (7 pm Central in summer, 6 pm in winter), against the
 * plan's daily limit (RESEND_DAILY_LIMIT, 100 on the free plan). The count (getEmailUsage) covers
 * announcements, receipts AND recruiting mail. TRANSACTIONAL_HEADROOM emails stay held back for
 * registration confirmations and LSC receipts, so bulk decisions can't use them up.
 */
export async function getEmailQuota(): Promise<EmailQuota> {
  const { sentToday, dailyLimit } = await getEmailUsage();
  return {
    sentToday,
    dailyLimit,
    left: dailyLimit === null ? null : Math.max(0, dailyLimit - sentToday - TRANSACTIONAL_HEADROOM),
  };
}

async function assertQuotaFor(count: number, ignoreLimit: boolean | undefined) {
  if (count === 0 || ignoreLimit) return;
  const { sentToday, dailyLimit, left } = await getEmailQuota();
  if (dailyLimit === null || left === null || count <= left) return;
  throw new RecruitingError(
    "EMAIL_LIMIT",
    `This would send ${count} email${count === 1 ? "" : "s"}, but only ${left} of today's ${dailyLimit} are left (${sentToday} sent today, counting announcements and recruiting, and ${TRANSACTIONAL_HEADROOM} kept for confirmations and receipts). The limit resets at 7 pm Central (6 pm in winter). Send fewer, wait for the reset, or tick "Send anyway" (the rest will show up as failed emails you can resend).`,
  );
}

export type BulkDecisionResult = {
  total: number;
  decided: number;
  emailsSent: number;
  emailsFailed: number;
  failures: Array<{ applicationTrackId: string; error: string }>;
};

const idList = z.array(z.string().min(1).max(64)).min(1, "Pick at least one.").max(100, "Pick at most 100 at a time.");

/**
 * Sets the same status on several team applications, optionally emailing each applicant the
 * default draft for it. The email quota is checked up front (a half-sent batch is the worst
 * outcome), then each one is decided on its own: one that can't be (already has that status,
 * it's the officer's own application...) is reported and the rest continue.
 */
export async function bulkDecide(
  officerId: string,
  applicationTrackIds: unknown,
  status: TrackStatus,
  options: {
    sendEmail?: boolean;
    ignoreLimit?: boolean;
    /** Per team-application id, the status the officer saw. A row that has changed since is refused, not overwritten. */
    expectedStatuses?: Record<string, TrackStatus>;
    now?: Date;
  } = {},
): Promise<BulkDecisionResult> {
  const parsed = idList.safeParse(applicationTrackIds);
  if (!parsed.success) {
    throw new RecruitingError("INVALID", parsed.error.issues[0]?.message ?? "Pick the applications to update.");
  }
  const ids = [...new Set(parsed.data)];
  if (options.sendEmail && !statusToTemplate(status)) {
    throw new RecruitingError("BAD_STATUS", "No email is sent for that status.");
  }
  if (options.sendEmail) await assertQuotaFor(ids.length, options.ignoreLimit);

  const result: BulkDecisionResult = { total: ids.length, decided: 0, emailsSent: 0, emailsFailed: 0, failures: [] };
  for (const id of ids) {
    try {
      const done = await decideAndNotify(officerId, id, status, {
        sendEmail: options.sendEmail,
        expectedStatus: options.expectedStatuses?.[id],
        now: options.now,
      });
      result.decided++;
      if (done.delivery?.status === "SENT") result.emailsSent++;
      else if (done.delivery) result.emailsFailed++;
    } catch (e) {
      result.failures.push({ applicationTrackId: id, error: e instanceof RecruitingError ? e.message : "Unexpected error." });
    }
  }
  return result;
}

export type BulkResendResult = { total: number; sent: number; failed: number };

/**
 * Resends every failed email in a round (at most 100 at a time), after checking the daily quota.
 * The usual reason is the daily limit itself: run it again after the limit resets.
 */
export async function resendAllFailed(officerId: string, cycleId: string, options: { ignoreLimit?: boolean } = {}): Promise<BulkResendResult> {
  await failInterruptedEmails();
  const rows = await prisma.applicationEmail.findMany({
    where: { status: "FAILED", application: { cycleId } },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true },
  });
  await assertQuotaFor(rows.length, options.ignoreLimit);

  const result: BulkResendResult = { total: rows.length, sent: 0, failed: 0 };
  for (const row of rows) {
    try {
      const done = await resendEmail(officerId, row.id);
      if (done.status === "SENT") result.sent++;
      else result.failed++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
