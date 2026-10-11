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
import {
  RecruitingError,
  setTrackStatus,
  submitApplication,
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
    applicantName: row.application.fullName?.trim() || row.application.user.displayName,
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
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

type SendableRow = { id: string; toEmail: string; subject: string; body: string };

async function markFailed(id: string, error: string): Promise<DeliveryResult> {
  await prisma.applicationEmail.update({ where: { id }, data: { status: "FAILED", error: error.slice(0, 500) } });
  return { emailId: id, status: "FAILED", error };
}

async function sendRow(row: SendableRow, idempotencyKey: string): Promise<DeliveryResult> {
  try {
    const rendered = renderEmail({ subject: row.subject, body: row.body });
    const result = await sendEmail(
      { to: row.toEmail, subject: rendered.subject, html: rendered.html, text: rendered.text, replyTo: replyToAddress() },
      { idempotencyKey },
    );
    if (!result.success) return await markFailed(row.id, result.error ?? "Send failed");
    await prisma.applicationEmail.update({
      where: { id: row.id },
      data: { status: "SENT", resendMessageId: result.messageId ?? null, sentAt: new Date(), error: null },
    });
    return { emailId: row.id, status: "SENT" };
  } catch (e) {
    return await markFailed(row.id, `Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Sends a PENDING email. The idempotency key is the row id, so two deliveries racing for the
 * same row (or a retry after a lost response) cannot send it twice.
 */
export async function deliverEmail(emailId: string): Promise<DeliveryResult> {
  const row = await prisma.applicationEmail.findUnique({
    where: { id: emailId },
    select: { id: true, status: true, toEmail: true, subject: true, body: true },
  });
  if (!row) throw new RecruitingError("NOT_FOUND", "Email not found.");
  if (row.status !== "PENDING") return { emailId, status: row.status === "SENT" ? "SENT" : "SKIPPED" };
  return sendRow(row, `recruiting-email:${row.id}`);
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
 * Manual Resend of a FAILED email. The row is claimed (FAILED to PENDING) atomically, so a
 * double click can't send twice. A normal failure gets a fresh idempotency key (a reused key
 * would just return the old failure); a row that was interrupted before any result was recorded
 * reuses its original key, so if it had in fact been delivered Resend won't send a duplicate.
 */
export async function resendEmail(officerId: string, emailId: string): Promise<DeliveryResult> {
  const row = await prisma.applicationEmail.findUnique({
    where: { id: emailId },
    select: { id: true, status: true, error: true, toEmail: true, subject: true, body: true, application: { select: { id: true, userId: true } } },
  });
  if (!row) throw new RecruitingError("NOT_FOUND", "Email not found.");
  if (row.status !== "FAILED") throw new RecruitingError("BAD_STATUS", "Only failed emails can be resent.");

  const claim = await prisma.applicationEmail.updateMany({ where: { id: row.id, status: "FAILED" }, data: { status: "PENDING" } });
  if (claim.count !== 1) throw new RecruitingError("BAD_STATUS", "That email is already being resent.");

  await createAuditLog({
    actorUserId: officerId,
    actionType: "APPLICATION_EMAIL_RESENT",
    entityType: "APPLICATION_EMAIL",
    entityId: row.id,
    targetUserId: row.application.userId,
    summary: "Resent a failed recruiting email",
    metadata: { applicationId: row.application.id, previousError: row.error },
  });

  const key = row.error === INTERRUPTED_ERROR ? `recruiting-email:${row.id}` : `recruiting-email:${row.id}:${randomUUID()}`;
  return sendRow(row, key);
}

/** Turns emails stuck PENDING (the process died mid-send) into FAILED so they can be resent. */
export async function failInterruptedEmails(now: Date = new Date()): Promise<number> {
  const res = await prisma.applicationEmail.updateMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - PENDING_TIMEOUT_MS) } },
    data: { status: "FAILED", error: INTERRUPTED_ERROR },
  });
  return res.count;
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

/**
 * An officer sets a team's status. With `sendEmail`, the matching email (the default draft, or
 * the officer's edited subject/body for this one person) is queued atomically with the change
 * and sent right after it commits.
 */
export async function decideAndNotify(
  officerId: string,
  applicationTrackId: string,
  status: TrackStatus,
  options: { sendEmail?: boolean; override?: EmailDraft; now?: Date } = {},
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
  );
  const delivery = decision.emailId ? await deliverEmailSafely(decision.emailId) : null;
  return { ...decision, delivery };
}
