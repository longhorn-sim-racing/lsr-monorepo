import { prisma } from "@/server/db";
import { getOpenLeagueSeason, listSeasonEntrants, type EntryStatus } from "@/server/services/league-entry.service";

export type EntrantRow = {
  userId: string;
  handle: string;
  displayName: string;
  email: string;
  eid: string | null;
  racing: {
    racingNumber: number | null;
    racingNumberColor: string;
    racingNumberFont: string;
    racingNumberItalic: boolean;
    racingNumberBorder: boolean;
  };
  application: {
    discordUsername: string;
    experience: string;
    equipment: string[];
    canCommit: boolean;
    school: string | null;
    notes: string | null;
    source: string;
    createdAt: string;
  } | null;
  status: EntryStatus;
  entryId: string | null;
  paidCents: number | null;
  paidAt: string | null;
  returningRate: boolean;
  entryNote: string | null;
};

/** The league's seasons for the admin picker, plus which one to show by default (the open one). */
export async function getLeagueSeasonsForAdmin(leagueSlug: string) {
  const league = await prisma.league.findUnique({ where: { slug: leagueSlug }, select: { id: true, name: true } });
  if (!league) return null;
  const [seasons, open] = await Promise.all([
    prisma.season.findMany({
      where: { leagueId: league.id },
      select: { id: true, slug: true, name: true },
      orderBy: [{ startAt: { sort: "desc", nulls: "last" } }, { year: "desc" }],
    }),
    getOpenLeagueSeason(league.id),
  ]);
  return { league, seasons, defaultSeasonId: open?.id ?? seasons[0]?.id ?? null };
}

export async function getEntrantRows(seasonId: string): Promise<EntrantRow[] | null> {
  const result = await listSeasonEntrants(seasonId);
  if (!result) return null;

  return result.entrants.map(({ user, application, entry, status }) => {
    const meta = (entry?.meta ?? {}) as Record<string, unknown>;
    const paymentMeta = (entry?.payment?.metadata ?? {}) as Record<string, unknown>;
    return {
      userId: user.id,
      handle: user.handle,
      displayName: user.displayName,
      email: user.email,
      eid: user.eid,
      racing: {
        racingNumber: user.racingNumber,
        racingNumberColor: user.racingNumberColor,
        racingNumberFont: user.racingNumberFont,
        racingNumberItalic: user.racingNumberItalic,
        racingNumberBorder: user.racingNumberBorder,
      },
      application: application
        ? {
            discordUsername: application.discordUsername,
            experience: application.experience,
            equipment: application.equipment,
            canCommit: application.canCommit,
            school: application.school,
            notes: application.notes,
            source: application.source,
            createdAt: application.createdAt.toISOString(),
          }
        : null,
      status,
      entryId: entry?.id ?? null,
      paidCents: entry?.payment?.amountCents ?? null,
      paidAt: (entry?.payment?.paidAt ?? entry?.validFrom)?.toISOString() ?? null,
      returningRate: paymentMeta.priceTier === "returning",
      entryNote: typeof meta.note === "string" ? meta.note : null,
    };
  });
}
