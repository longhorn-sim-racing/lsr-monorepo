import { prisma } from "@/server/db";
import { NotificationChannel, NotificationStatus, Prisma } from "@prisma/client";
import { sendEmail } from "@/lib/email/resend";
import { getEmailTemplate } from "@/lib/email/templates";

export type NotificationType =
  | "REGISTRATION_CONFIRMED"
  | "WAITLIST_PROMOTED"
  | "EVENT_REMINDER_24H"
  | "EVENT_POSTED"
  | "REGISTRATION_OPENED"
  | "RESULTS_POSTED"
  | "DUES_CONFIRMED"
  | "LEAGUE_REGISTERED"
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
    if (channel === "EMAIL" && !shouldSendEmail(user, type)) {
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
}: Omit<SendNotificationParams, "userId"> & { userIds: string[] }): Promise<void> {
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

/**
 * Check if user should receive email for this notification type.
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
  // Master opt-out check
  if (!user.marketingOptIn) {
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
      // Custom notifications always allowed if master opt-in is true
      return true;
    default:
      return true;
  }
}

/**
 * Process all pending notifications for a user.
 */
export async function processUserNotifications(userId: string): Promise<void> {
  const notifications = await prisma.notification.findMany({
    where: {
      userId,
      status: "PENDING",
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date() } }],
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
    await processNotification(notification);
    processed++;
  }

  return processed;
}

/**
 * Process a single notification.
 */
async function processNotification(
  notification: Prisma.NotificationGetPayload<{ include: { user: true } }>
): Promise<void> {
  if (notification.channel === "EMAIL") {
    await processEmailNotification(notification);
  } else {
    // IN_APP notifications just get marked as sent
    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
      },
    });
  }
}

/**
 * Process an email notification.
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

  const template = getEmailTemplate({
    type: notification.type,
    title: notification.title,
    body: notification.body,
    actionUrl,
    metadata: notification.metadata as Record<string, unknown> | undefined,
  });

  const result = await sendEmail({
    to: notification.user.email,
    subject: notification.title,
    html: template.html,
    text: template.text,
  });

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
