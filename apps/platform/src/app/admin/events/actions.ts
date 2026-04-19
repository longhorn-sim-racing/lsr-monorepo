"use server"

import { prisma } from "@/server/db";
import { fromZonedTime } from "date-fns-tz";
import { createAuditLog } from "@/server/audit/log";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOfficer } from "@/server/auth/guards";
import {
  revalidateEventList,
  revalidateEventDetail,
  revalidateSeriesPages,
} from "@/server/cache/revalidate-public";

export async function createEvent(formData: FormData) {
  const user = await requireOfficer();

  const seriesId = formData.get("seriesId") as string;
  const venueId = formData.get("venueId") as string;
  const opensAtRaw = formData.get("registrationOpensAt") as string;
  const closesAtRaw = formData.get("registrationClosesAt") as string;
  const maxRaw = formData.get("registrationMax") as string;
  const feeRaw = formData.get("registrationFeeCents") as string;
  const registrationFeeCents = feeRaw && parseFloat(feeRaw) > 0 ? Math.round(parseFloat(feeRaw) * 100) : null;

  const submitAction = formData.get("submitAction") as string;
  const scheduleDateRaw = formData.get("scheduleDate") as string;
  const timezone = formData.get("timezone") as string;

  let status: EventStatus = "DRAFT";
  let publishedAt: Date | null = null;

  if (submitAction === "publish") {
    status = "PUBLISHED";
    publishedAt = new Date();
  } else if (submitAction === "schedule") {
    status = "SCHEDULED";
    publishedAt = scheduleDateRaw ? fromZonedTime(scheduleDateRaw, timezone) : null;
  }

  const event = await prisma.event.create({
    data: {
      title: formData.get("title") as string,
      slug: formData.get("slug") as string,
      seriesId: seriesId === "" ? null : seriesId,
      venueId: venueId === "" ? null : venueId,
      startsAtUtc: fromZonedTime(formData.get("startsAtUtc") as string, timezone),
      endsAtUtc: fromZonedTime(formData.get("endsAtUtc") as string, timezone),
      timezone: timezone,
      summary: formData.get("summary") as string,
      description: formData.get("description") as string,
      heroImageUrl: formData.get("heroImageUrl") as string,
      streamUrl: formData.get("streamUrl") as string,
      status: status,
      publishedAt: publishedAt,
      visibility: "public",
      registrationEnabled: formData.get("registrationEnabled") === "on",
      registrationOpensAt: opensAtRaw ? fromZonedTime(opensAtRaw, timezone) : null,
      registrationClosesAt: closesAtRaw ? fromZonedTime(closesAtRaw, timezone) : null,
      registrationMax: maxRaw && maxRaw !== "-1" ? parseInt(maxRaw) : null,
      registrationWaitlistEnabled: formData.get("registrationWaitlistEnabled") === "on",
      registrationFeeCents,
      attendanceEnabled: formData.get("attendanceEnabled") === "on",
      attendanceReportingMode: formData.get("attendanceEnabled") === "on" ? "CHECKIN_REQUIRED" : "ASSUME_REGISTERED",
      attendanceOpensAt: formData.get("attendanceOpensAt") ? fromZonedTime(formData.get("attendanceOpensAt") as string, timezone) : null,
      attendanceClosesAt: formData.get("attendanceClosesAt") ? fromZonedTime(formData.get("attendanceClosesAt") as string, timezone) : null,
    },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "CREATE",
    entityType: "EVENT",
    entityId: event.id,
    summary: `Created event: ${event.title}`,
    after: event,
  });

  revalidatePath("/admin/events");
  if (event.status === "PUBLISHED" || event.status === "SCHEDULED") {
    revalidateEventList();
    revalidateEventDetail(event.slug);
  }
  redirect("/admin/events");
}

import { EventStatus } from "@prisma/client";
import { getEventById } from "@/server/repos/event.repo";

export async function updateEventStatus(eventId: string, status: EventStatus, publishedAt?: Date) {
  const user = await requireOfficer();

  const data: { status: EventStatus; publishedAt?: Date } = {
    status,
    publishedAt,
  };

  const updated = await prisma.event.update({
    where: { id: eventId },
    data,
    select: { slug: true },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Updated event status to ${status}`,
    after: data,
  });

  revalidatePath("/admin/events");
  revalidateEventList();
  revalidateEventDetail(updated.slug);
  redirect("/admin/events");
}


export async function getEvent(id: string) {
  return await getEventById(id);
}

export async function updateEvent(id: string, formData: FormData) {
  const user = await requireOfficer();

  const seriesId = formData.get("seriesId") as string;
  const venueId = formData.get("venueId") as string;
  const opensAtRaw = formData.get("registrationOpensAt") as string;
  const closesAtRaw = formData.get("registrationClosesAt") as string;
  const maxRaw = formData.get("registrationMax") as string;
  const feeRaw = formData.get("registrationFeeCents") as string;
  const registrationFeeCents = feeRaw && parseFloat(feeRaw) > 0 ? Math.round(parseFloat(feeRaw) * 100) : null;

  const submitAction = formData.get("submitAction") as string;
  const scheduleDateRaw = formData.get("scheduleDate") as string;
  const timezone = formData.get("timezone") as string;

  const eventUpdateData: any = {
    title: formData.get("title") as string,
    slug: formData.get("slug") as string,
    seriesId: seriesId === "" ? null : seriesId,
    venueId: venueId === "" ? null : venueId,
    startsAtUtc: fromZonedTime(formData.get("startsAtUtc") as string, formData.get("timezone") as string),
    endsAtUtc: fromZonedTime(formData.get("endsAtUtc") as string, formData.get("timezone") as string),
    timezone: formData.get("timezone") as string,
    summary: formData.get("summary") as string,
    description: formData.get("description") as string,
    heroImageUrl: formData.get("heroImageUrl") as string,
    streamUrl: formData.get("streamUrl") as string,
    registrationEnabled: formData.get("registrationEnabled") === "on",
    registrationOpensAt: opensAtRaw ? fromZonedTime(opensAtRaw, formData.get("timezone") as string) : null,
    registrationClosesAt: closesAtRaw ? fromZonedTime(closesAtRaw, formData.get("timezone") as string) : null,
    registrationMax: maxRaw && maxRaw !== "-1" ? parseInt(maxRaw) : null,
    registrationWaitlistEnabled: formData.get("registrationWaitlistEnabled") === "on",
    registrationFeeCents,
    attendanceEnabled: formData.get("attendanceEnabled") === "on",
    attendanceOpensAt: formData.get("attendanceOpensAt") ? fromZonedTime(formData.get("attendanceOpensAt") as string, formData.get("timezone") as string) : null,
    attendanceClosesAt: formData.get("attendanceClosesAt") ? fromZonedTime(formData.get("attendanceClosesAt") as string, formData.get("timezone") as string) : null,
  };

  // When enabling attendance via the event form, set reporting mode to CHECKIN_REQUIRED
  if (eventUpdateData.attendanceEnabled) {
    eventUpdateData.attendanceReportingMode = "CHECKIN_REQUIRED";
  }

  if (submitAction === "publish") {
    eventUpdateData.status = "PUBLISHED";
    // Only set publishedAt if we are explicitly publishing,
    // but for updates we might want to check if it's already published to avoid resetting time?
    // For now, "Publish Now" means NOW.
    eventUpdateData.publishedAt = new Date();
  } else if (submitAction === "schedule") {
    eventUpdateData.status = "SCHEDULED";
    eventUpdateData.publishedAt = scheduleDateRaw ? fromZonedTime(scheduleDateRaw, timezone) : null;
  } else if (submitAction === "draft") {
    eventUpdateData.status = "DRAFT";
  }

  const updated = await prisma.event.update({
    where: { id },
    data: eventUpdateData,
    select: { slug: true, series: { select: { slug: true } } },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: id,
    summary: `Updated event details for ${eventUpdateData.title}`,
    after: eventUpdateData,
  });

  revalidatePath("/admin/events");
  revalidateEventList();
  revalidateEventDetail(updated.slug);
  if (updated.series?.slug) revalidateSeriesPages(updated.series.slug);
  redirect("/admin/events");
}

export async function deleteEvent(eventId: string) {
  const user = await requireOfficer();

  const deleted = await prisma.event.delete({
    where: { id: eventId },
    select: { slug: true, series: { select: { slug: true } } },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "DELETE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Deleted event ${eventId}`,
  });

  revalidatePath("/admin/events");
  revalidateEventList();
  revalidateEventDetail(deleted.slug);
  if (deleted.series?.slug) revalidateSeriesPages(deleted.series.slug);
}

import { adminOverrideRegistration } from "@/server/services/registration.service";
import { RegistrationStatus } from "@prisma/client";

export async function updateEventRegistrationConfig(eventId: string, formData: FormData) {
  const user = await requireOfficer();

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { timezone: true } });
  const timezone = event?.timezone || "America/Chicago";

  const enabled = formData.get("registrationEnabled") === "on";
  const opensAtRaw = formData.get("registrationOpensAt") as string;
  const closesAtRaw = formData.get("registrationClosesAt") as string;
  const maxRaw = formData.get("registrationMax") as string;
  const waitlistEnabled = formData.get("registrationWaitlistEnabled") === "on";
  const feeRaw = formData.get("registrationFeeCents") as string;
  const registrationFeeCents = feeRaw && parseFloat(feeRaw) > 0 ? Math.round(parseFloat(feeRaw) * 100) : null;

  const configData = {
    registrationEnabled: enabled,
    registrationOpensAt: opensAtRaw ? fromZonedTime(opensAtRaw, timezone) : null,
    registrationClosesAt: closesAtRaw ? fromZonedTime(closesAtRaw, timezone) : null,
    registrationMax: maxRaw && maxRaw !== "-1" ? parseInt(maxRaw) : null,
    registrationWaitlistEnabled: waitlistEnabled,
    registrationFeeCents,
  };

  const updated = await prisma.event.update({
    where: { id: eventId },
    data: configData,
    select: { slug: true },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Updated registration configuration for event ${eventId}`,
    metadata: {
      updateType: "registration_config",
    },
    after: configData,
  });

  revalidatePath(`/admin/events/${eventId}`);
  revalidateEventList();
  revalidateEventDetail(updated.slug);
}

export async function overrideRegistrationStatus(eventId: string, userId: string, status: RegistrationStatus, reason?: string) {
  const user = await requireOfficer();

  await adminOverrideRegistration(user.id, userId, eventId, status, reason);

  const ev = await prisma.event.findUnique({ where: { id: eventId }, select: { slug: true } });
  revalidatePath(`/admin/events/${eventId}`);
  revalidateEventList();
  if (ev) revalidateEventDetail(ev.slug);
}

export async function reorderWaitlist(eventId: string, orderedRegistrationIds: string[]) {
  const user = await requireOfficer();

  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < orderedRegistrationIds.length; i++) {
      await tx.eventRegistration.update({
        where: { id: orderedRegistrationIds[i] },
        data: {
          waitlistOrder: i + 1,
          // Ideally we check status is WAITLISTED, but admin reorder implies waitlist context
        },
      });
    }
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Reordered waitlist for event ${eventId}`,
    metadata: {
      updateType: "waitlist_reorder",
      count: orderedRegistrationIds.length,
    }
  });

  revalidatePath(`/admin/events/${eventId}`);
}

export async function removeRegistration(eventId: string, userId: string) {
  await requireOfficer();

  await prisma.eventRegistration.delete({
    where: { eventId_userId: { eventId, userId } },
  });

    revalidatePath(`/admin/events/${eventId}`);

  }

  

  import { updateAttendanceConfig, checkInUser, removeCheckIn } from "@/server/services/attendance.service";

  import { CheckinMethod } from "@prisma/client";

  

export async function updateEventAttendanceConfig(eventId: string, formData: FormData) {
  const user = await requireOfficer();

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { timezone: true } });
  const timezone = event?.timezone || "America/Chicago";

  const enabled = formData.get("attendanceEnabled") === "on";
  const opensAtRaw = formData.get("attendanceOpensAt") as string;
  const closesAtRaw = formData.get("attendanceClosesAt") as string;

  await updateAttendanceConfig(
    eventId,
    {
      attendanceEnabled: enabled,
      attendanceOpensAt: opensAtRaw ? fromZonedTime(opensAtRaw, timezone) : null,
      attendanceClosesAt: closesAtRaw ? fromZonedTime(closesAtRaw, timezone) : null,
    },
    user.id
  );

  revalidatePath(`/admin/events/${eventId}/manage`);
}

export async function manualCheckIn(eventId: string, userId: string) {
  const user = await requireOfficer();

  await checkInUser(eventId, userId, "MANUAL", user.id);

  revalidatePath(`/admin/events/${eventId}/manage`);
}

export async function manualRemoveCheckIn(eventId: string, userId: string) {
  const user = await requireOfficer();

  await removeCheckIn(eventId, userId, user.id);

  revalidatePath(`/admin/events/${eventId}/manage`);
}

