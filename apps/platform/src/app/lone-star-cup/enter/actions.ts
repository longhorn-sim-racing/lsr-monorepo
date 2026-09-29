"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth/guards";
import { leagueApplicationSchema } from "@/schemas/league-application.schema";
import { getOpenLeagueSeason, saveLeagueApplication } from "@/server/services/league-entry.service";

export async function submitLeagueApplication(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();

  const parsed = leagueApplicationSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  const league = await prisma.league.findUnique({ where: { slug: "lone-star-cup" }, select: { id: true } });
  const season = league ? await getOpenLeagueSeason(league.id) : null;
  if (!season) return { ok: false, error: "Lone Star Cup entry isn't open right now." };

  try {
    await saveLeagueApplication({ userId: user.id, seasonId: season.id, input: parsed.data, actorUserId: user.id });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save your entry form." };
  }

  revalidatePath("/lone-star-cup");
  revalidatePath("/admin/league-entries");
  return { ok: true };
}
