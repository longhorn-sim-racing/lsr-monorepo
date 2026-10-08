import { prisma } from "@/server/db";
import { NotificationChannel, Prisma } from "@prisma/client";
import { sendEmail, type SendEmailResult } from "@/lib/email/resend";
import { getEmailTemplate } from "@/lib/email/templates";
import { subHours, subMinutes } from "date-fns";

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
 * Send notification to multiple users.
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
}: Omit<SendNotificationParams, "userId" | "receipt"> & { userIds: string[] }): Promise<void> {
  for (const userId of userIds) {
    await sendNotification({
      userId,
      type,
      title,
      body,
      actionUrl,
      metadata,
      channels,
      scheduledFor,
    });
  }
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

  for (const notification of notifications) {
    await processNotification(notification);
  }
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

  let processed = 0;
  for (const notification of notifications) {
    if (await processNotification(notification)) processed++;
  }

  return processed;
}

/**
 * Retry unscheduled notifications whose immediate send never happened (for cron job).
 * Only rows created between UNSCHEDULED_RETRY_AFTER_MINUTES and UNSCHEDULED_MAX_AGE_HOURS ago.
 */
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

  let processed = 0;
  for (const notification of notifications) {
    if (await processNotification(notification)) processed++;
  }

  return processed;
}

/**
 * Process a single notification. It's claimed first with a conditional PENDING → SENT
 * update, so when two paths pick up the same row (the user's own flush and the cron
 * retry) only one delivers it. Returns false when another path already claimed it.
 */
async function processNotification(
  notification: Prisma.NotificationGetPayload<{ include: { user: true } }>
): Promise<boolean> {
  const { count } = await prisma.notification.updateMany({
    where: { id: notification.id, status: "PENDING" },
    // IN_APP notifications are delivered by this update; an email's sentAt waits for Resend.
    data: { status: "SENT", sentAt: notification.channel === "EMAIL" ? null : new Date() },
  });
  if (count === 0) return false;

  if (notification.channel === "EMAIL") {
    await processEmailNotification(notification);
  }
  return true;
}

/**
 * Process an email notification (already claimed by processNotification).
 */
async function processEmailNotification(
  notification: Prisma.NotificationGetPayload<{ include: { user: true } }>
): Promise<void> {
  // For emails, relative actionUrls need a full base URL (unlike in-app where Next.js handles it)
  let actionUrl = notification.actionUrl ?? undefined;
  if (actionUrl && actionUrl.startsWith("/")) {
    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      (process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000");
    actionUrl = `${baseUrl.replace(/\/$/, "")}${actionUrl}`;
  }

  let result: SendEmailResult;
  try {
    const template = getEmailTemplate({
      type: notification.type,
      title: notification.title,
      body: notification.body,
      actionUrl,
      metadata: notification.metadata as Record<string, unknown> | undefined,
    });

    result = await sendEmail({
      to: notification.user.email,
      subject: notification.title,
      html: template.html,
      text: template.text,
    });
  } catch (error) {
    // Claimed but not sent: mark it FAILED (retryable by an officer) instead of leaving it SENT.
    console.error(`[Notification] Email ${notification.id} threw before sending:`, error);
    result = { success: false, error: String(error) };
  }

  await prisma.notification.update({
    where: { id: notification.id },
    data: {
      status: result.success ? "SENT" : "FAILED",
      sentAt: result.success ? new Date() : null,
      emailMessageId: result.messageId,
      emailError: result.error,
    },
  });
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

  await processNotification(notification);
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
