import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import {
  processScheduledNotifications,
  processStuckNotifications,
  failInterruptedEmails,
  sendNotification,
} from "@/server/services/notification.service";
import { addHours, subHours } from "date-fns";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Allow up to 60 seconds for the cron job

/**
 * Cron job to process scheduled notifications, retry recent unscheduled ones whose
 * immediate send was dropped, and create event reminders.
 * Called every 15 minutes by GitHub Actions (see .github/workflows/notification-cron.yml).
 */
export async function GET(request: Request) {
  // Verify cron secret in production
  const authHeader = request.headers.get("Authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = {
    processedNotifications: 0,
    interruptedEmails: 0,
    retriedNotifications: 0,
    scheduledReminders: 0,
    errors: [] as string[],
  };

  try {
    // 1. Process any pending scheduled notifications
    results.processedNotifications = await processScheduledNotifications();
  } catch (error) {
    console.error("[Cron] Failed to process scheduled notifications:", error);
    results.errors.push(`Process notifications: ${String(error)}`);
  }

  try {
    // 2. Mark emails interrupted mid-send as failed, then retry recent unscheduled
    // notifications still PENDING (their send was dropped)
    results.interruptedEmails = await failInterruptedEmails();
    results.retriedNotifications = await processStuckNotifications();
  } catch (error) {
    console.error("[Cron] Failed to retry stuck notifications:", error);
    results.errors.push(`Retry stuck notifications: ${String(error)}`);
  }

  try {
    // 3. Schedule 24-hour reminders for upcoming events
    results.scheduledReminders = await scheduleEventReminders();
  } catch (error) {
    console.error("[Cron] Failed to schedule event reminders:", error);
    results.errors.push(`Schedule reminders: ${String(error)}`);
  }

  return NextResponse.json({
    success: results.errors.length === 0,
    ...results,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Schedule 24-hour reminders for events starting in the next 24-25 hours.
 * Only for users who have opted in to event reminders.
 */
async function scheduleEventReminders(): Promise<number> {
  const now = new Date();
  const windowStart = addHours(now, 23); // Events starting in 23+ hours
  const windowEnd = addHours(now, 25); // Events starting in less than 25 hours

  // Find events in the reminder window
  const upcomingEvents = await prisma.event.findMany({
    where: {
      startsAtUtc: {
        gte: windowStart,
        lte: windowEnd,
      },
      status: "PUBLISHED",
    },
    include: {
      registrations: {
        where: { status: "REGISTERED" },
        include: {
          user: {
            include: {
              notificationPrefs: true,
            },
          },
        },
      },
    },
  });

  let scheduled = 0;

  for (const event of upcomingEvents) {
    for (const registration of event.registrations) {
      const user = registration.user;

      // Check if user wants event reminders (their own setting; the marketing opt-in doesn't apply)
      if (user.notificationPrefs && !user.notificationPrefs.emailEventReminder) continue;

      // Check if reminder already exists for this user/event combo
      const existingReminder = await prisma.notification.findFirst({
        where: {
          userId: user.id,
          type: "EVENT_REMINDER_24H",
          metadata: {
            path: ["eventId"],
            equals: event.id,
          },
        },
      });

      if (existingReminder) continue; // Already scheduled

      // Schedule the reminder
      try {
        await sendNotification({
          userId: user.id,
          type: "EVENT_REMINDER_24H",
          title: `Reminder: ${event.title} is tomorrow!`,
          body: `Don't forget - you're registered for ${event.title} starting soon.`,
          actionUrl: `/events/${event.slug}`,
          channels: ["IN_APP", "EMAIL"],
          metadata: {
            eventId: event.id,
            title: event.title,
            startsAt: event.startsAtUtc,
            timezone: event.timezone,
            slug: event.slug,
            heroImageUrl: event.heroImageUrl,
          },
          // Schedule for 24 hours before event
          scheduledFor: subHours(event.startsAtUtc, 24),
        });
        scheduled++;
      } catch (error) {
        console.error(
          `[Cron] Failed to schedule reminder for user ${user.id}, event ${event.id}:`,
          error
        );
      }
    }
  }

  return scheduled;
}
