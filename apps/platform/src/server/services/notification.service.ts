import { prisma } from "@/server/db";
import { NotificationChannel, Prisma } from "@prisma/client";
import { sendEmail, sendBatchEmails, MAX_BATCH_EMAILS, type SendEmailParams, type SendEmailResult } from "@/lib/email/resend";
import { getEmailTemplate } from "@/lib/email/templates";
import { subHours, subMinutes } from "date-fns";
import { getSiteUrl } from "@/lib/site-url";

type NotificationWithUser = Prisma.NotificationGetPayload<{ include: { user: true } }>;

export type NotificationType =
  | "REGISTRATION_CONFIRMED"
  | "WAITLIST_PROMOTED"
  | "EVENT_REMINDER_24H"
  | "EVENT_POSTED"
  | "REGISTRATION_OPENED"
  | "RESULTS_POSTED"
  | "DUES_CONFIRMED"
  | "LEAGUE_REGISTERED"
  | "PAYMENT_WAITLISTED" // paid, but the event filled during checkout
  | "CUSTOM";

export type SendNotificationParams = {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  channels: NotificationChannel[];
  scheduledFor?: Date;
  /** A payment receipt: always emailed, whatever the member's email settings. */
  receipt?: boolean;
};

/**
 * Send a notification to a user.
 * Creates notification records and processes immediately if not scheduled.
 */
export async function sendNotification({
  userId,
  type,
  title,
  body,
  actionUrl,
  metadata,
  channels,
  scheduledFor,
  receipt = false,
}: SendNotificationParams): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { notificationPrefs: true },
  });

  if (!user) {
    console.warn(`[Notification] User not found: ${userId}`);
    return;
  }

  // Create notification for each channel
  for (const channel of channels) {
    // Check if user wants this email type
    if (channel === "EMAIL" && !receipt && !shouldSendEmail(user, type)) {
      console.log(`[Notification] User ${userId} opted out of ${type} emails`);
      continue;
    }

    await prisma.notification.create({
      data: {
        userId,
        channel,
        type,
        title,
        body,
        actionUrl,
        metadata: metadata as Prisma.InputJsonValue,
        status: "PENDING",
        scheduledFor,
      },
    });
  }

  // Process immediately if not scheduled
  if (!scheduledFor) {
    await processUserNotifications(userId);
  }
}

/**
 * Send notification to multiple users. Rows are created in one query, and the emails go out
 * through Resend's batch API (up to 100 per call) instead of one call per member.
 * Returns how many rows were created for each channel.
 */
export async function sendBulkNotification({
  userIds,
  type,
  title,
  body,
  actionUrl,
  metadata,
  channels,
  scheduledFor,
}: Omit<SendNotificationParams, "userId" | "receipt"> & { userIds: string[] }): Promise<{ inApp: number; emails: number }> {
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, marketingOptIn: true, notificationPrefs: true },
  });

  // Unscheduled rows are created already claimed (SENT), so no other path can pick one up before
  // this one delivers it; an email's sentAt waits for Resend, like processNotification.
  const now = new Date();
  const rows: Prisma.NotificationCreateManyInput[] = [];
  for (const user of users) {
    for (const channel of channels) {
      if (channel === "EMAIL" && !shouldSendEmail(user, type)) continue;
      rows.push({
        userId: user.id,
        channel,
        type,
        title,
        body,
        actionUrl,
        metadata: metadata as Prisma.InputJsonValue,
        status: scheduledFor ? "PENDING" : "SENT",
        sentAt: scheduledFor || channel === "EMAIL" ? null : now,
        scheduledFor,
      });
    }
  }
  if (rows.length === 0) return { inApp: 0, emails: 0 };

  const created = await prisma.notification.createManyAndReturn({ data: rows, include: { user: true } });
  const emails = created.filter((n) => n.channel === "EMAIL");
  if (!scheduledFor) await deliverEmails(emails);

  return { inApp: created.length - emails.length, emails: emails.length };
}

/** How many of these users would get an email of this type, after their email settings */
export async function countEmailRecipients(userIds: string[], type: NotificationType): Promise<number> {
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { marketingOptIn: true, notificationPrefs: true },
  });
  return users.filter((user) => shouldSendEmail(user, type)).length;
}

/**
 * Emails sent in the last 24 hours against Resend's daily limit (100 on the free plan;
 * set RESEND_DAILY_LIMIT if the plan changes). Counts the app's own emails only.
 */
export async function getEmailUsage(): Promise<{ sentLast24h: number; dailyLimit: number }> {
  const sentLast24h = await prisma.notification.count({
    where: { channel: "EMAIL", emailMessageId: { not: null }, sentAt: { gte: subHours(new Date(), 24) } },
  });
  return { sentLast24h, dailyLimit: Number(process.env.RESEND_DAILY_LIMIT) || 100 };
}

// Announcement-style emails: these also need the marketing opt-in. Everything else is about
// the member's own registrations and only follows its own setting below.
const MARKETING_TYPES: ReadonlySet<NotificationType> = new Set([
  "EVENT_POSTED",
  "REGISTRATION_OPENED",
  "RESULTS_POSTED",
  "CUSTOM",
]);

/**
 * Check if user should receive email for this notification type.
 * Payment receipts skip this check (see `receipt` on sendNotification).
 */
function shouldSendEmail(
  user: {
    marketingOptIn: boolean;
    notificationPrefs: {
      emailRegistration: boolean;
      emailWaitlistPromotion: boolean;
      emailEventReminder: boolean;
      emailEventPosted: boolean;
      emailResultsPosted: boolean;
    } | null;
  },
  type: NotificationType
): boolean {
  if (MARKETING_TYPES.has(type) && !user.marketingOptIn) {
    return false;
  }

  const prefs = user.notificationPrefs;

  // If no preferences set, use defaults:
  // - Registration and Waitlist: ON by default
  // - Everything else: OFF by default
  if (!prefs) {
    return (
      type === "REGISTRATION_CONFIRMED" ||
      type === "WAITLIST_PROMOTED" ||
      type === "DUES_CONFIRMED" ||
      type === "LEAGUE_REGISTERED" ||
      type === "CUSTOM"
    );
  }

  switch (type) {
    case "REGISTRATION_CONFIRMED":
      return prefs.emailRegistration;
    case "WAITLIST_PROMOTED":
      return prefs.emailWaitlistPromotion;
    case "EVENT_REMINDER_24H":
      return prefs.emailEventReminder;
    case "EVENT_POSTED":
    case "REGISTRATION_OPENED":
      return prefs.emailEventPosted;
    case "RESULTS_POSTED":
      return prefs.emailResultsPosted;
    case "CUSTOM":
      // Officer announcements: only the marketing opt-in (checked above) applies
      return true;
    default:
      return true;
  }
}

// Unscheduled notifications are sent the moment they're created. One still PENDING a few
// minutes later lost its send (#52), so the cron retries it, but only for 48 hours: older
// ones are stale (e.g. a confirmation for an event that's over) and we'd rather not send them.
const UNSCHEDULED_RETRY_AFTER_MINUTES = 5;
const UNSCHEDULED_MAX_AGE_HOURS = 48;
// Claimed emails still without a send confirmation after this long were interrupted.
const INTERRUPTED_EMAIL_AFTER_MINUTES = 10;

/**
 * Process all pending notifications for a user.
 * Skips unscheduled rows older than UNSCHEDULED_MAX_AGE_HOURS (see above).
 */
export async function processUserNotifications(userId: string): Promise<void> {
  const now = new Date();
  const notifications = await prisma.notification.findMany({
    where: {
      userId,
      status: "PENDING",
      OR: [
        { scheduledFor: null, createdAt: { gte: subHours(now, UNSCHEDULED_MAX_AGE_HOURS) } },
        { scheduledFor: { lte: now } },
      ],
    },
    include: { user: true },
  });

  await processNotifications(notifications);
}

/**
 * Process all pending scheduled notifications (for cron job).
 */
export async function processScheduledNotifications(): Promise<number> {
  const notifications = await prisma.notification.findMany({
    where: {
      status: "PENDING",
      scheduledFor: { lte: new Date() },
    },
    include: { user: true },
    take: 100, // Process in batches
  });

  return processNotifications(notifications);
}

/**
 * An email row is claimed (PENDING → SENT, sentAt null) before Resend is called. If the
 * function died before Resend answered, mark it FAILED so it shows up for a retry
 * instead of looking sent forever.
 */
export async function failInterruptedEmails(): Promise<number> {
  const { count } = await prisma.notification.updateMany({
    where: {
      channel: "EMAIL",
      status: "SENT",
      sentAt: null,
      emailMessageId: null,
      updatedAt: { lt: subMinutes(new Date(), INTERRUPTED_EMAIL_AFTER_MINUTES) },
    },
    data: { status: "FAILED", emailError: "Interrupted before the send was confirmed; retry to resend." },
  });
  return count;
}

/**
 * Retry unscheduled notifications whose immediate send never happened (for cron job).
 * Only rows created between UNSCHEDULED_RETRY_AFTER_MINUTES and UNSCHEDULED_MAX_AGE_HOURS ago.
 */
export async function processStuckNotifications(): Promise<number> {
  const now = new Date();
  const notifications = await prisma.notification.findMany({
    where: {
      status: "PENDING",
      scheduledFor: null,
      createdAt: {
        lte: subMinutes(now, UNSCHEDULED_RETRY_AFTER_MINUTES),
        gte: subHours(now, UNSCHEDULED_MAX_AGE_HOURS),
      },
    },
    include: { user: true },
    orderBy: { createdAt: "asc" },
    take: 100, // Process in batches
  });

  return processNotifications(notifications);
}

/**
 * Claim each notification, then send the claimed emails in batches. Returns how many were claimed.
 */
async function processNotifications(notifications: NotificationWithUser[]): Promise<number> {
  const claimedEmails: NotificationWithUser[] = [];
  let claimed = 0;
  for (const notification of notifications) {
    if (!(await claimNotification(notification))) continue;
    claimed++;
    if (notification.channel === "EMAIL") claimedEmails.push(notification);
  }
  await deliverEmails(claimedEmails);
  return claimed;
}

/**
 * Claim a notification with a conditional PENDING → SENT update, so when two paths pick up the
 * same row (the user's own flush and the cron retry) only one delivers it. Returns false when
 * another path already claimed it. In-app notifications are delivered by this update.
 */
async function claimNotification(notification: NotificationWithUser): Promise<boolean> {
  const { count } = await prisma.notification.updateMany({
    where: { id: notification.id, status: "PENDING" },
    // IN_APP notifications are delivered by this update; an email's sentAt waits for Resend.
    data: { status: "SENT", sentAt: notification.channel === "EMAIL" ? null : new Date() },
  });
  return count > 0;
}

// Resend allows a couple of API calls a second; pause between batch calls
const BATCH_PAUSE_MS = 600;

/**
 * Send claimed email notifications: one Resend call for a single email, batch calls of up to
 * MAX_BATCH_EMAILS otherwise. Each row ends SENT with its message id, or FAILED (retryable).
 */
async function deliverEmails(notifications: NotificationWithUser[]): Promise<void> {
  for (let start = 0; start < notifications.length; start += MAX_BATCH_EMAILS) {
    if (start > 0) await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    const chunk = notifications.slice(start, start + MAX_BATCH_EMAILS);

    const results = new Map<string, SendEmailResult>();
    const ready: { id: string; email: SendEmailParams }[] = [];
    for (const notification of chunk) {
      try {
        ready.push({ id: notification.id, email: buildEmail(notification) });
      } catch (error) {
        // Claimed but not sent: mark it FAILED (retryable by an officer) instead of leaving it SENT.
        console.error(`[Notification] Email ${notification.id} threw before sending:`, error);
        results.set(notification.id, { success: false, error: String(error) });
      }
    }

    const sent =
      ready.length === 1 ? [await sendEmail(ready[0].email)] : ready.length > 1 ? await sendBatchEmails(ready.map((r) => r.email)) : [];
    ready.forEach((r, i) => results.set(r.id, sent[i] ?? { success: false, error: "No result from the email service" }));

    const sentAt = new Date();
    await prisma.$transaction(
      chunk.map((notification) => {
        const result = results.get(notification.id)!;
        return prisma.notification.update({
          where: { id: notification.id },
          data: {
            status: result.success ? "SENT" : "FAILED",
            sentAt: result.success ? sentAt : null,
            emailMessageId: result.messageId,
            emailError: result.error,
          },
        });
      })
    );
  }
}

/** The email for a notification; relative action links get the site's base URL */
function buildEmail(notification: NotificationWithUser): SendEmailParams {
  let actionUrl = notification.actionUrl ?? undefined;
  if (actionUrl && actionUrl.startsWith("/")) {
    actionUrl = `${getSiteUrl()}${actionUrl}`;
  }
  const template = getEmailTemplate({
    type: notification.type,
    title: notification.title,
    body: notification.body,
    actionUrl,
    metadata: notification.metadata as Record<string, unknown> | undefined,
  });
  return { to: notification.user.email, subject: notification.title, html: template.html, text: template.text };
}

/**
 * Cancel a scheduled notification.
 */
export async function cancelNotification(notificationId: string): Promise<void> {
  await prisma.notification.update({
    where: { id: notificationId },
    data: { status: "CANCELLED" },
  });
}

/**
 * Retry a failed notification.
 */
export async function retryNotification(notificationId: string): Promise<void> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: { user: true },
  });

  if (!notification || notification.status !== "FAILED") {
    return;
  }

  // Reset status and reprocess
  await prisma.notification.update({
    where: { id: notificationId },
    data: {
      status: "PENDING",
      emailError: null,
    },
  });

  await processNotifications([notification]);
}

/**
 * Mark in-app notification as read.
 */
export async function markNotificationAsRead(
  notificationId: string,
  userId: string
): Promise<void> {
  await prisma.notification.updateMany({
    where: {
      id: notificationId,
      userId,
      channel: "IN_APP",
    },
    data: { readAt: new Date() },
  });
}

/**
 * Mark all in-app notifications as read for a user.
 */
export async function markAllNotificationsAsRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: {
      userId,
      channel: "IN_APP",
      readAt: null,
    },
    data: { readAt: new Date() },
  });
}

/**
 * Get unread notification count for a user (excludes dismissed).
 */
export async function getUnreadNotificationCount(userId: string): Promise<number> {
  return prisma.notification.count({
    where: {
      userId,
      channel: "IN_APP",
      status: "SENT",
      readAt: null,
      dismissedAt: null,
    },
  });
}

/**
 * Get recent notifications for a user (for the bell dropdown).
 * Excludes dismissed notifications.
 */
export async function getRecentNotifications(
  userId: string,
  limit = 10
): Promise<
  Array<{
    id: string;
    type: string;
    title: string;
    body: string;
    actionUrl: string | null;
    readAt: Date | null;
    sentAt: Date | null;
    createdAt: Date;
  }>
> {
  return prisma.notification.findMany({
    where: {
      userId,
      channel: "IN_APP",
      status: "SENT",
      dismissedAt: null,
    },
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      actionUrl: true,
      readAt: true,
      sentAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Dismiss a notification (soft delete - user-side, no audit logging).
 * The notification remains in the database for admin visibility.
 */
export async function dismissNotification(
  notificationId: string,
  userId: string
): Promise<boolean> {
  const result = await prisma.notification.updateMany({
    where: {
      id: notificationId,
      userId,
      channel: "IN_APP",
      dismissedAt: null,
    },
    data: {
      dismissedAt: new Date(),
    },
  });
  return result.count > 0;
}

/**
 * Dismiss all read notifications for a user (soft delete).
 * The notifications remain in the database for admin visibility.
 */
export async function dismissAllReadNotifications(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: {
      userId,
      channel: "IN_APP",
      readAt: { not: null },
      dismissedAt: null,
    },
    data: {
      dismissedAt: new Date(),
    },
  });
  return result.count;
}
