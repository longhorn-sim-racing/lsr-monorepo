"use server";

import { prisma } from "@/server/db";
import { requireOfficer } from "@/server/auth/guards";
import { revalidatePath } from "next/cache";
import {
  sendBulkNotification,
  cancelNotification,
  retryNotification,
  countEmailRecipients,
  getEmailUsage,
  TRANSACTIONAL_HEADROOM,
} from "@/server/services/notification.service";
import { setSystemSetting, getSystemSetting, SETTINGS } from "@/lib/email/settings";
import { NotificationChannel } from "@prisma/client";
import { createAuditLog } from "@/server/audit/log";
import type { ActionResult } from "@/lib/action-result";
import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_TIMEZONE } from "@/lib/dates";

export async function getNotificationStats() {
  await requireOfficer();

  const [total, pending, sent, failed] = await Promise.all([
    prisma.notification.count(),
    prisma.notification.count({ where: { status: "PENDING" } }),
    prisma.notification.count({ where: { status: "SENT" } }),
    prisma.notification.count({ where: { status: "FAILED" } }),
  ]);

  return { total, pending, sent, failed };
}

export async function getRecentNotifications(limit = 20, skip = 0) {
  await requireOfficer();

  return prisma.notification.findMany({
    include: {
      user: {
        select: { id: true, displayName: true, email: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: skip,
  });
}

export async function getScheduledNotifications() {
  await requireOfficer();

  return prisma.notification.findMany({
    where: {
      status: "PENDING",
      scheduledFor: { not: null },
    },
    include: {
      user: {
        select: { id: true, displayName: true, email: true },
      },
    },
    orderBy: { scheduledFor: "asc" },
  });
}

export async function cancelScheduledNotification(notificationId: string) {
  const user = await requireOfficer();

  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: { user: { select: { id: true, displayName: true } } },
  });

  await cancelNotification(notificationId);

  if (notification) {
    await createAuditLog({
      actorUserId: user.id,
      actionType: "CANCEL",
      entityType: "NOTIFICATION",
      entityId: notificationId,
      targetUserId: notification.userId,
      summary: `Cancelled scheduled notification "${notification.title}" for ${notification.user.displayName}`,
      before: { status: notification.status },
      after: { status: "CANCELLED" },
      metadata: { type: notification.type, channel: notification.channel },
    });
  }

  revalidatePath("/admin/notifications");
}

export async function retryFailedNotification(notificationId: string) {
  const user = await requireOfficer();

  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: { user: { select: { id: true, displayName: true } } },
  });

  await retryNotification(notificationId);

  if (notification) {
    await createAuditLog({
      actorUserId: user.id,
      actionType: "RETRY",
      entityType: "NOTIFICATION",
      entityId: notificationId,
      targetUserId: notification.userId,
      summary: `Retried failed notification "${notification.title}" for ${notification.user.displayName}`,
      before: { status: "FAILED", error: notification.emailError },
      after: { status: "PENDING" },
      metadata: { type: notification.type, channel: notification.channel },
    });
  }

  revalidatePath("/admin/notifications");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a send did, for the composer's message */
export type SendSummary = { scheduled: boolean; recipients: number; emailsSent: number; emailsFailed: number };

export async function sendCustomNotification(formData: FormData): Promise<ActionResult<SendSummary>> {
  const user = await requireOfficer();

  const recipientType = formData.get("recipientType") as string;
  const userIdsJson = formData.get("userIds") as string | null;
  const title = formData.get("title") as string;
  const body = formData.get("body") as string;
  const actionUrl = (formData.get("actionUrl") as string) || undefined;
  const actionText = (formData.get("actionText") as string) || undefined;
  const sendInApp = formData.get("sendInApp") === "on";
  const sendEmail = formData.get("sendEmail") === "on";
  const scheduledFor = formData.get("scheduledFor") as string | null;

  // Build metadata for email template customization
  const metadata: Record<string, unknown> = {};
  if (actionText) metadata.actionText = actionText;

  const channels: NotificationChannel[] = [];
  if (sendInApp) channels.push("IN_APP");
  if (sendEmail) channels.push("EMAIL");

  if (channels.length === 0) {
    return { ok: false, error: "Pick at least one channel: in-app, email or both." };
  }

  if (!title?.trim() || !body?.trim()) {
    return { ok: false, error: "Write a title and a message." };
  }

  // datetime-local has no zone; officers schedule in Central time, and the server runs in UTC
  const scheduledDate = scheduledFor ? fromZonedTime(scheduledFor, DEFAULT_TIMEZONE) : undefined;
  if (scheduledDate && Number.isNaN(scheduledDate.getTime())) {
    return { ok: false, error: "Pick a valid date and time to schedule it." };
  }

  let recipientIds: string[];
  if (recipientType === "single" || recipientType === "multiple") {
    recipientIds = userIdsJson ? JSON.parse(userIdsJson) : [];
    if (recipientIds.length === 0) {
      return { ok: false, error: "Search for and add at least one recipient." };
    }
  } else if (recipientType === "all") {
    const active = await prisma.user.findMany({ where: { status: "active" }, select: { id: true } });
    recipientIds = active.map((u) => u.id);
  } else {
    return { ok: false, error: "Choose who to send it to." };
  }

  // Resend refuses email past its daily limit, so check an immediate email send first. Scheduled
  // sends aren't checked: the day they go out isn't known yet.
  if (sendEmail && !scheduledDate && formData.get("sendAnyway") !== "on") {
    const [{ sentToday, dailyLimit }, emailCount] = await Promise.all([
      getEmailUsage(),
      countEmailRecipients(recipientIds, "CUSTOM"),
    ]);
    if (dailyLimit !== null) {
      const left = Math.max(0, dailyLimit - sentToday - TRANSACTIONAL_HEADROOM);
      const perDay = dailyLimit - TRANSACTIONAL_HEADROOM;
      if (emailCount > perDay) {
        return {
          ok: false,
          error: `This would send ${plural(emailCount, "email")}, more than the ${perDay} a day an announcement can use (the plan's ${dailyLimit}, minus ${TRANSACTIONAL_HEADROOM} kept for confirmations and receipts). Send it in-app only, or split the recipients across days.`,
        };
      }
      if (emailCount > left) {
        return {
          ok: false,
          error: `This would send ${plural(emailCount, "email")}, but only ${left} of today's ${dailyLimit} are left (${sentToday} sent, ${TRANSACTIONAL_HEADROOM} kept for confirmations and receipts). The limit resets at 7 pm Central (6 pm in winter). Send fewer, send it after the reset, or tick "Send anyway".`,
        };
      }
    }
  }

  // Everything that can fail runs before the send, so an error never reports a sent message as unsent
  const userNames =
    recipientType === "all"
      ? ""
      : (await prisma.user.findMany({ where: { id: { in: recipientIds } }, select: { displayName: true } }))
          .map((u) => u.displayName)
          .join(", ");

  const sent = await sendBulkNotification({
    userIds: recipientIds,
    type: "CUSTOM",
    title,
    body,
    actionUrl,
    channels,
    scheduledFor: scheduledDate,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });

  if (recipientType === "all") {
    await createAuditLog({
      actorUserId: user.id,
      actionType: "CREATE",
      entityType: "NOTIFICATION",
      entityId: "bulk",
      summary: `Sent bulk notification "${title}" to ${recipientIds.length} active members`,
      after: { title, body, channels, scheduledFor: scheduledDate?.toISOString() },
      metadata: { recipientType: "all", recipientCount: recipientIds.length, emails: sent, actionUrl },
    });
  } else {
    await createAuditLog({
      actorUserId: user.id,
      actionType: "CREATE",
      entityType: "NOTIFICATION",
      entityId: recipientIds.length === 1 ? "custom" : "multi",
      targetUserId: recipientIds.length === 1 ? recipientIds[0] : undefined,
      summary: recipientIds.length === 1
        ? `Sent custom notification "${title}" to ${userNames}`
        : `Sent custom notification "${title}" to ${recipientIds.length} users: ${userNames}`,
      after: { title, body, channels, scheduledFor: scheduledDate?.toISOString() },
      metadata: { recipientType, recipientCount: recipientIds.length, emails: sent, userIds: recipientIds, actionUrl },
    });
  }

  revalidatePath("/admin/notifications");
  return {
    ok: true,
    data: { scheduled: !!scheduledDate, recipients: recipientIds.length, emailsSent: sent.emailsSent, emailsFailed: sent.emailsFailed },
  };
}

export async function getEmailSettings() {
  await requireOfficer();

  const [enabled, fromAddress] = await Promise.all([
    getSystemSetting<boolean>(SETTINGS.EMAIL_ENABLED),
    getSystemSetting<string>(SETTINGS.EMAIL_FROM),
  ]);

  return {
    enabled: enabled ?? true,
    fromAddress:
      fromAddress ?? "Longhorn Sim Racing <noreply@notify.longhornsimracing.org>",
  };
}

export async function updateEmailSettings(formData: FormData) {
  const user = await requireOfficer();

  const enabled = formData.get("enabled") === "on";
  const fromAddress = formData.get("fromAddress") as string;

  const [prevEnabled, prevFromAddress] = await Promise.all([
    getSystemSetting<boolean>(SETTINGS.EMAIL_ENABLED),
    getSystemSetting<string>(SETTINGS.EMAIL_FROM),
  ]);

  await Promise.all([
    setSystemSetting(SETTINGS.EMAIL_ENABLED, enabled),
    setSystemSetting(SETTINGS.EMAIL_FROM, fromAddress),
  ]);

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "NOTIFICATION_SETTINGS",
    entityId: "email",
    summary: `Updated email notification settings`,
    before: { enabled: prevEnabled ?? true, fromAddress: prevFromAddress },
    after: { enabled, fromAddress },
  });

  revalidatePath("/admin/notifications");
}

export async function searchUsers(query: string) {
  await requireOfficer();

  if (!query || query.length < 2) return [];

  return prisma.user.findMany({
    where: {
      OR: [
        { displayName: { contains: query, mode: "insensitive" } },
        { email: { contains: query, mode: "insensitive" } },
        { handle: { contains: query, mode: "insensitive" } },
      ],
      status: "active",
    },
    select: {
      id: true,
      displayName: true,
      email: true,
      handle: true,
    },
    take: 10,
  });
}

export async function deleteNotificationAdmin(notificationId: string) {
  const user = await requireOfficer();

  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: { user: { select: { id: true, displayName: true } } },
  });

  if (!notification) {
    throw new Error("Notification not found");
  }

  await prisma.notification.delete({
    where: { id: notificationId },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "DELETE",
    entityType: "NOTIFICATION",
    entityId: notificationId,
    targetUserId: notification.userId,
    summary: `Deleted notification "${notification.title}" for ${notification.user.displayName}`,
    before: {
      type: notification.type,
      title: notification.title,
      status: notification.status,
      channel: notification.channel,
    },
  });

  revalidatePath("/admin/notifications");
}

export type BulkDeleteFilter = {
  status?: "SENT" | "FAILED" | "CANCELLED" | "PENDING";
  olderThanDays?: number;
};

export async function bulkDeleteNotifications(filter: BulkDeleteFilter) {
  const user = await requireOfficer();

  const where: {
    status?: "SENT" | "FAILED" | "CANCELLED" | "PENDING";
    createdAt?: { lt: Date };
  } = {};

  if (filter.status) {
    where.status = filter.status;
  }

  if (filter.olderThanDays) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - filter.olderThanDays);
    where.createdAt = { lt: cutoffDate };
  }

  const count = await prisma.notification.count({ where });

  if (count === 0) {
    return { deletedCount: 0 };
  }

  await prisma.notification.deleteMany({ where });

  const filterDescription = [
    filter.status ? `status: ${filter.status}` : null,
    filter.olderThanDays ? `older than ${filter.olderThanDays} days` : null,
  ]
    .filter(Boolean)
    .join(", ");

  await createAuditLog({
    actorUserId: user.id,
    actionType: "BULK_DELETE",
    entityType: "NOTIFICATION",
    entityId: "bulk",
    summary: `Bulk deleted ${count} notifications (${filterDescription})`,
    metadata: { filter, deletedCount: count },
  });

  revalidatePath("/admin/notifications");
  return { deletedCount: count };
}
