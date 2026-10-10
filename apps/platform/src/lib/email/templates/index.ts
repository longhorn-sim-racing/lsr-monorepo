import { baseTemplate } from "./base";
import { formatInTimeZone } from "date-fns-tz";
import { DEFAULT_TIMEZONE } from "@/lib/dates";

export type NotificationTemplateData = {
  type: string;
  title: string;
  body: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
};

type EventData = {
  title: string;
  startsAt: Date;
  timezone?: string;
  slug: string;
  heroImageUrl?: string;
};

type ResultData = {
  eventTitle: string;
  position: number;
  points?: number;
  eventSlug: string;
};

/**
 * Generate email template based on notification type.
 */
export function getEmailTemplate(
  notification: NotificationTemplateData
): { html: string; text: string } {
  switch (notification.type) {
    case "REGISTRATION_CONFIRMED":
      return registrationConfirmedTemplate(notification);

    case "WAITLIST_PROMOTED":
      return waitlistPromotedTemplate(notification);

    case "EVENT_REMINDER_24H":
      return eventReminderTemplate(notification);

    case "EVENT_POSTED":
      return eventPostedTemplate(notification);

    case "RESULTS_POSTED":
      return resultsPostedTemplate(notification);

    case "CUSTOM":
    default:
      return customNotificationTemplate(notification);
  }
}

function registrationConfirmedTemplate(
  notification: NotificationTemplateData
): { html: string; text: string } {
  const event = notification.metadata as EventData | undefined;
  const eventDate = event?.startsAt
    ? formatInTimeZone(new Date(event.startsAt), event.timezone || DEFAULT_TIMEZONE, "EEEE, MMMM d 'at' h:mm a")
    : "";

  const textColor = "#b3b3b3";
  const accentColor = "#ff6b00";

  return baseTemplate({
    previewText: `You're registered for ${event?.title ?? "the event"}!`,
    title: "You're In!",
    body: `
      ${event?.heroImageUrl ? `<img src="${event.heroImageUrl}" alt="${event.title}" width="100%" style="display:block;margin:0 0 16px 0;border-radius:4px;" />` : ""}
      <p style="margin:0 0 16px 0;color:${textColor};">Your registration has been confirmed!</p>
      ${event ? `<p style="margin:0 0 8px 0;color:#ffffff;font-weight:700;font-size:18px;">${event.title}</p>` : ""}
      ${eventDate ? `<p style="margin:0 0 16px 0;color:${accentColor};font-weight:600;">${eventDate}</p>` : ""}
      <p style="margin:0;color:${textColor};">${notification.body}</p>
    `,
    actionUrl: notification.actionUrl,
    actionText: "View Event Details",
    footerText: "You're receiving this because you registered for an LSR event.",
  });
}

function waitlistPromotedTemplate(
  notification: NotificationTemplateData
): { html: string; text: string } {
  const event = notification.metadata as EventData | undefined;

  const textColor = "#b3b3b3";
  const accentColor = "#ff6b00";

  return baseTemplate({
    previewText: `A spot opened up for ${event?.title ?? "the event"}!`,
    title: "You've Been Promoted!",
    body: `
      ${event?.heroImageUrl ? `<img src="${event.heroImageUrl}" alt="${event.title}" width="100%" style="display:block;margin:0 0 16px 0;border-radius:4px;" />` : ""}
      <p style="margin:0 0 16px 0;color:${textColor};">Great news! A spot has opened up and you've been moved from the waitlist.</p>
      ${event ? `<p style="margin:0 0 16px 0;color:#ffffff;font-weight:700;font-size:18px;">${event.title}</p>` : ""}
      <p style="margin:0 0 16px 0;color:${textColor};">${notification.body}</p>
      <p style="margin:0;color:${accentColor};font-weight:700;">You are now registered for this event.</p>
    `,
    actionUrl: notification.actionUrl,
    actionText: "View Event Details",
    footerText: "You were on the waitlist for this event and a spot became available.",
  });
}

function eventReminderTemplate(
  notification: NotificationTemplateData
): { html: string; text: string } {
  const event = notification.metadata as EventData | undefined;
  const eventDate = event?.startsAt
    ? formatInTimeZone(new Date(event.startsAt), event.timezone || DEFAULT_TIMEZONE, "EEEE, MMMM d 'at' h:mm a")
    : "";

  const textColor = "#b3b3b3";
  const accentColor = "#ff6b00";

  return baseTemplate({
    previewText: `Reminder: ${event?.title ?? "Event"} starts tomorrow!`,
    title: "Event Tomorrow!",
    body: `
      ${event?.heroImageUrl ? `<img src="${event.heroImageUrl}" alt="${event.title}" width="100%" style="display:block;margin:0 0 16px 0;border-radius:4px;" />` : ""}
      <p style="margin:0 0 16px 0;color:${textColor};">This is a reminder that you're registered for an event starting in less than 24 hours.</p>
      ${event ? `<p style="margin:0 0 8px 0;color:#ffffff;font-weight:700;font-size:18px;">${event.title}</p>` : ""}
      ${eventDate ? `<p style="margin:0 0 16px 0;color:${accentColor};font-weight:600;">${eventDate}</p>` : ""}
      <p style="margin:0;color:${textColor};">${notification.body}</p>
    `,
    actionUrl: notification.actionUrl,
    actionText: "View Event Details",
    footerText: "You opted in to receive event reminders.",
  });
}

function eventPostedTemplate(
  notification: NotificationTemplateData
): { html: string; text: string } {
  const event = notification.metadata as EventData | undefined;
  const eventDate = event?.startsAt
    ? formatInTimeZone(new Date(event.startsAt), event.timezone || DEFAULT_TIMEZONE, "EEEE, MMMM d 'at' h:mm a")
    : "";

  const textColor = "#b3b3b3";
  const accentColor = "#ff6b00";

  return baseTemplate({
    previewText: `New event: ${event?.title ?? "Check it out"}!`,
    title: "New Event Posted!",
    body: `
      ${event?.heroImageUrl ? `<img src="${event.heroImageUrl}" alt="${event.title}" width="100%" style="display:block;margin:0 0 16px 0;border-radius:4px;" />` : ""}
      <p style="margin:0 0 16px 0;color:${textColor};">A new event has been published that might interest you.</p>
      ${event ? `<p style="margin:0 0 8px 0;color:#ffffff;font-weight:700;font-size:18px;">${event.title}</p>` : ""}
      ${eventDate ? `<p style="margin:0 0 16px 0;color:${accentColor};font-weight:600;">${eventDate}</p>` : ""}
      <p style="margin:0;color:${textColor};">${notification.body}</p>
    `,
    actionUrl: notification.actionUrl,
    actionText: "View Event",
    footerText: "You opted in to receive notifications about new events.",
  });
}

function resultsPostedTemplate(
  notification: NotificationTemplateData
): { html: string; text: string } {
  const result = notification.metadata as ResultData | undefined;

  const textColor = "#b3b3b3";
  const accentColor = "#ff6b00";

  return baseTemplate({
    previewText: `Results are in for ${result?.eventTitle ?? "the race"}!`,
    title: "Results Posted!",
    body: `
      <p style="margin:0 0 16px 0;color:${textColor};">The results for a recent event have been posted.</p>
      ${result?.eventTitle ? `<p style="margin:0 0 16px 0;color:#ffffff;font-weight:700;font-size:18px;">${result.eventTitle}</p>` : ""}
      ${
        result?.position
          ? `<p style="margin:0 0 16px 0;color:${textColor};">Your finish: <strong style="color:${accentColor};">P${result.position}</strong>${result.points ? ` (${result.points} points)` : ""}</p>`
          : ""
      }
      <p style="margin:0;color:${textColor};">${notification.body}</p>
    `,
    actionUrl: notification.actionUrl,
    actionText: "View Full Results",
    footerText: "You opted in to receive notifications when results are posted.",
  });
}

function customNotificationTemplate(
  notification: NotificationTemplateData
): { html: string; text: string } {
  const metadata = notification.metadata as {
    actionText?: string;
    signature?: string;
    greeting?: string;
  } | undefined;

  // Colors matching the base template
  const textColor = "#b3b3b3";
  const textMuted = "#808080";
  const borderColor = "#404040";

  // Process body text: handle line breaks, preserve paragraphs
  const processedBody = notification.body
    .split(/\n\n+/) // Split on double newlines (paragraphs)
    .map((para) => para.trim())
    .filter((para) => para.length > 0)
    .map((para) => {
      // Convert single newlines to <br> within paragraphs
      const withBreaks = para.replace(/\n/g, "<br>");
      return `<p style="margin:0 0 16px 0;color:${textColor};">${withBreaks}</p>`;
    })
    .join("");

  // Build the body HTML with inline styles
  const signature = metadata?.signature || "The LSR Team";
  const bodyHtml = `
    ${metadata?.greeting ? `<p style="margin:0 0 16px 0;color:${textColor};">${metadata.greeting}</p>` : ""}
    ${processedBody}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px;">
      <tr>
        <td style="padding-top:16px;border-top:1px solid ${borderColor};">
          <p style="margin:0;color:${textMuted};">— ${signature}</p>
        </td>
      </tr>
    </table>
  `;

  // Determine action button text
  const actionText = metadata?.actionText || (notification.actionUrl ? "View Details" : undefined);

  return baseTemplate({
    previewText: notification.title,
    title: notification.title,
    body: bodyHtml,
    actionUrl: notification.actionUrl,
    actionText,
    footerText: "You're receiving this message from Longhorn Sim Racing.",
  });
}
