// Recruiting rounds ("cycles") and each team's booking link. Officer-only: callers run
// requireOfficer() first and pass the officer's id for the audit log.

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db";
import { createAuditLog } from "@/server/audit/log";
import { cycleWindow } from "@/lib/recruiting/cycle";
import { isGoogleBookingHost } from "@/lib/recruiting/labels";
import { FORM_VERSION, getTrack, isSafeHttpsUrl } from "@/schemas/recruiting.schema";
import { RecruitingError } from "@/server/services/recruiting.service";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const roundFields = {
  name: z.string().trim().min(1, "Give the round a name.").max(80, "Keep the name under 80 characters."),
  opensAt: z.date({ error: "Pick when applications open." }),
  closesAt: z.date({ error: "Pick the deadline." }),
};
const datesInOrder = (v: { opensAt: Date; closesAt: Date }) => v.opensAt < v.closesAt;

const createSchema = z
  .object({
    ...roundFields,
    slug: z.string().trim().min(2, "Use at least 2 characters.").max(40, "Keep it under 40 characters.").regex(SLUG, "Use lowercase letters, numbers and hyphens, e.g. fall-2026."),
  })
  .refine(datesInOrder, { error: "The round must open before it closes.", path: ["closesAt"] });

const updateSchema = z.object(roundFields).refine(datesInOrder, { error: "The round must open before it closes.", path: ["closesAt"] });

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

export async function listCycles(now: Date = new Date()) {
  const cycles = await prisma.recruitingCycle.findMany({ orderBy: { opensAt: "desc" } });
  const groups = await prisma.application.groupBy({ by: ["cycleId", "state"], _count: { _all: true } });
  return cycles.map((c) => ({
    ...c,
    window: cycleWindow(c, now),
    drafts: groups.find((g) => g.cycleId === c.id && g.state === "DRAFT")?._count._all ?? 0,
    submitted: groups.find((g) => g.cycleId === c.id && g.state === "SUBMITTED")?._count._all ?? 0,
  }));
}

/**
 * Creates an inactive round (turn it on with setActiveCycle). The booking links from the most
 * recently created round are copied over, since they are usually reused; officers should re-check
 * that those booking pages still have open slots.
 */
export async function createCycle(actorId: string, input: { name: string; slug: string; opensAt: Date; closesAt: Date }) {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecruitingError("INVALID", "Check the round's details.", { fieldErrors: fieldErrors(parsed.error) });
  }
  const data = parsed.data;

  try {
    const cycle = await prisma.$transaction(async (tx) => {
      const previous = await tx.recruitingCycle.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
      const created = await tx.recruitingCycle.create({
        data: { slug: data.slug, name: data.name, opensAt: data.opensAt, closesAt: data.closesAt, isActive: false, formVersion: FORM_VERSION },
      });
      let copiedLinks = 0;
      if (previous) {
        const configs = await tx.recruitingTrackConfig.findMany({ where: { cycleId: previous.id, schedulingUrl: { not: null } } });
        if (configs.length > 0) {
          await tx.recruitingTrackConfig.createMany({
            data: configs.map((c) => ({ cycleId: created.id, track: c.track, schedulingUrl: c.schedulingUrl, updatedById: actorId })),
          });
          copiedLinks = configs.length;
        }
      }
      await createAuditLog(
        {
          actorUserId: actorId,
          actionType: "RECRUITING_CYCLE_CREATED",
          entityType: "RECRUITING_CYCLE",
          entityId: created.id,
          summary: `Created recruiting round "${created.name}"`,
          after: { slug: created.slug, opensAt: created.opensAt, closesAt: created.closesAt },
          metadata: { copiedLinks },
        },
        tx,
      );
      return { ...created, copiedLinks };
    });
    return cycle;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new RecruitingError("INVALID", "A round with that address already exists.", { fieldErrors: { slug: "That address is already used by another round." } });
    }
    throw e;
  }
}

/** Renames a round or moves its dates. The slug (its address in links and file names) never changes. */
export async function updateCycle(actorId: string, cycleId: string, input: { name: string; opensAt: Date; closesAt: Date }) {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecruitingError("INVALID", "Check the round's details.", { fieldErrors: fieldErrors(parsed.error) });
  }
  const before = await prisma.recruitingCycle.findUnique({ where: { id: cycleId } });
  if (!before) throw new RecruitingError("NOT_FOUND", "Round not found.");

  const updated = await prisma.recruitingCycle.update({ where: { id: cycleId }, data: parsed.data });
  await createAuditLog({
    actorUserId: actorId,
    actionType: "RECRUITING_CYCLE_UPDATED",
    entityType: "RECRUITING_CYCLE",
    entityId: cycleId,
    summary: `Updated recruiting round "${updated.name}"`,
    before: { name: before.name, opensAt: before.opensAt, closesAt: before.closesAt },
    after: { name: updated.name, opensAt: updated.opensAt, closesAt: updated.closesAt },
  });
  return updated;
}

/**
 * Makes one round the active one (the only round applicants can use), or none (`null`).
 * The old round is switched off first, inside the same transaction, because the database allows
 * at most one active round at a time.
 */
export async function setActiveCycle(actorId: string, cycleId: string | null) {
  return prisma.$transaction(async (tx) => {
    if (cycleId !== null) {
      const target = await tx.recruitingCycle.findUnique({ where: { id: cycleId }, select: { id: true } });
      if (!target) throw new RecruitingError("NOT_FOUND", "Round not found.");
    }
    const previouslyActive = await tx.recruitingCycle.findFirst({ where: { isActive: true }, select: { id: true, name: true } });
    await tx.recruitingCycle.updateMany({ where: { isActive: true }, data: { isActive: false } });
    const active = cycleId === null ? null : await tx.recruitingCycle.update({ where: { id: cycleId }, data: { isActive: true } });
    await createAuditLog(
      {
        actorUserId: actorId,
        actionType: "RECRUITING_CYCLE_ACTIVATED",
        entityType: "RECRUITING_CYCLE",
        entityId: cycleId ?? previouslyActive?.id ?? "none",
        summary: active ? `Made "${active.name}" the active recruiting round` : "Turned recruiting off (no active round)",
        before: { activeCycleId: previouslyActive?.id ?? null },
        after: { activeCycleId: cycleId },
      },
      tx,
    );
    return active;
  });
}

/** Deletes a round that was never used. A round with any application, or the active one, stays. */
export async function deleteCycle(actorId: string, cycleId: string) {
  const cycle = await prisma.recruitingCycle.findUnique({ where: { id: cycleId }, include: { _count: { select: { applications: true } } } });
  if (!cycle) throw new RecruitingError("NOT_FOUND", "Round not found.");
  if (cycle.isActive) throw new RecruitingError("BAD_STATUS", "Turn the round off before deleting it.");
  if (cycle._count.applications > 0) {
    throw new RecruitingError("BAD_STATUS", "This round has applications, so it can't be deleted.");
  }
  await prisma.recruitingCycle.delete({ where: { id: cycleId } });
  await createAuditLog({
    actorUserId: actorId,
    actionType: "RECRUITING_CYCLE_DELETED",
    entityType: "RECRUITING_CYCLE",
    entityId: cycleId,
    summary: `Deleted recruiting round "${cycle.name}"`,
    before: { slug: cycle.slug, name: cycle.name },
  });
}

export async function getTrackConfigs(cycleId: string) {
  const rows = await prisma.recruitingTrackConfig.findMany({ where: { cycleId } });
  return Object.fromEntries(rows.map((r) => [r.track, r.schedulingUrl])) as Record<string, string | null>;
}

/**
 * Sets (or clears, with a blank value) a team's booking link for a round. Only https links are
 * accepted, and by default only Google Calendar appointment-scheduling hosts: a mistyped or hostile
 * URL would otherwise go out to applicants under the club's name. `allowOtherHost` is the explicit
 * override for a different scheduling tool.
 */
export async function saveTrackConfig(
  actorId: string,
  cycleId: string,
  track: string,
  schedulingUrl: string | null,
  options: { allowOtherHost?: boolean } = {},
) {
  const def = getTrack(track);
  if (!def) throw new RecruitingError("INVALID", "Unknown team.", { fieldErrors: { track: "Unknown team." } });
  if (!def.interviewRequired) {
    throw new RecruitingError("INVALID", `${def.label} does not run interviews, so it has no booking link.`);
  }
  const cycle = await prisma.recruitingCycle.findUnique({ where: { id: cycleId }, select: { id: true, name: true } });
  if (!cycle) throw new RecruitingError("NOT_FOUND", "Round not found.");

  const url = schedulingUrl?.trim() ?? "";
  const existing = await prisma.recruitingTrackConfig.findUnique({
    where: { cycleId_track: { cycleId, track } },
    select: { schedulingUrl: true },
  });

  if (url === "") {
    await prisma.recruitingTrackConfig.deleteMany({ where: { cycleId, track } });
  } else {
    if (!isSafeHttpsUrl(url) || url.length > 2000) {
      throw new RecruitingError("INVALID", "Enter a full link that starts with https://", { fieldErrors: { schedulingUrl: "Enter a full link that starts with https://" } });
    }
    if (!options.allowOtherHost && !isGoogleBookingHost(url)) {
      throw new RecruitingError(
        "INVALID",
        "That isn't a Google Calendar booking link (calendar.app.google or calendar.google.com). Tick the box to use it anyway.",
        { fieldErrors: { schedulingUrl: "Not a Google Calendar booking link." } },
      );
    }
    await prisma.recruitingTrackConfig.upsert({
      where: { cycleId_track: { cycleId, track } },
      create: { cycleId, track, schedulingUrl: url, updatedById: actorId },
      update: { schedulingUrl: url, updatedById: actorId },
    });
  }

  await createAuditLog({
    actorUserId: actorId,
    actionType: "RECRUITING_BOOKING_LINK_CHANGED",
    entityType: "RECRUITING_CYCLE",
    entityId: cycleId,
    summary: `${url === "" ? "Cleared" : "Set"} the ${def.label} booking link for "${cycle.name}"`,
    before: { schedulingUrl: existing?.schedulingUrl ?? null },
    after: { schedulingUrl: url === "" ? null : url },
    metadata: { track },
  });
}
