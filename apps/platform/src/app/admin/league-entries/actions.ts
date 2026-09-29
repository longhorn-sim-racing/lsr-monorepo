"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/server/db";
import { requireOfficer } from "@/server/auth/guards";
import { leagueApplicationSchema } from "@/schemas/league-application.schema";
import {
  grantManualLeagueEntry,
  revokeManualLeagueEntry,
  saveLeagueApplication,
} from "@/server/services/league-entry.service";

type Result = { ok: true } | { ok: false; error: string };

const fail = (error: unknown): Result => ({
  ok: false,
  error: error instanceof Error ? error.message : "Something went wrong.",
});

function refresh() {
  revalidatePath("/admin/league-entries");
  revalidatePath("/lone-star-cup");
}

export async function searchEntrantUsers(query: string) {
  await requireOfficer();
  const q = query.trim();
  if (q.length < 2) return [];
  return prisma.user.findMany({
    where: {
      OR: [
        { displayName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { handle: { contains: q, mode: "insensitive" } },
        { eid: { equals: q.toLowerCase() } },
      ],
    },
    take: 10,
    select: { id: true, displayName: true, email: true, handle: true, eid: true },
  });
}

/** Adds or edits a driver's entry form on their behalf (backfill from the old Google Form, fixes). */
export async function saveEntrantApplication(userId: string, seasonId: string, input: unknown): Promise<Result> {
  const admin = await requireOfficer();
  const parsed = leagueApplicationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  try {
    const existing = await prisma.leagueApplication.findUnique({
      where: { userId_seasonId: { userId, seasonId } },
      select: { source: true },
    });
    await saveLeagueApplication({
      userId,
      seasonId,
      input: parsed.data,
      actorUserId: admin.id,
      source: existing?.source ?? "ADMIN",
    });
  } catch (error) {
    return fail(error);
  }
  refresh();
  return { ok: true };
}

export async function grantEntrantEntry(userId: string, seasonId: string, note?: string): Promise<Result> {
  const admin = await requireOfficer();
  const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { leagueId: true } });
  if (!season?.leagueId) return { ok: false, error: "This season isn't linked to a league." };
  try {
    await grantManualLeagueEntry({
      userId,
      leagueId: season.leagueId,
      actorUserId: admin.id,
      note: z.string().trim().max(200).optional().parse(note || undefined),
    });
  } catch (error) {
    return fail(error);
  }
  refresh();
  return { ok: true };
}

export async function revokeEntrantEntry(entitlementId: string): Promise<Result> {
  const admin = await requireOfficer();
  try {
    await revokeManualLeagueEntry(entitlementId, admin.id);
  } catch (error) {
    return fail(error);
  }
  refresh();
  return { ok: true };
}
