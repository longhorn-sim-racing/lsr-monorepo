import { requireOfficer } from "@/server/auth/guards";
import { getEntrantRows, getLeagueSeasonsForAdmin } from "@/server/queries/league-entrants";
import { LeagueEntriesConsole } from "@/components/admin/league-entries-console";

export default async function LeagueEntriesAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  // The admin layout checks too, but layouts don't re-run on every render; this page returns contact details.
  await requireOfficer();
  const { season: seasonSlug } = await searchParams;
  const data = await getLeagueSeasonsForAdmin("lone-star-cup");
  if (!data || !data.seasons.length) {
    return <p className="font-mono text-sm text-white/60">No Lone Star Cup seasons yet.</p>;
  }

  const season = data.seasons.find((s) => s.slug === seasonSlug) ?? data.seasons.find((s) => s.id === data.defaultSeasonId)!;
  const rows = (await getEntrantRows(season.id)) ?? [];

  return (
    <div className="h-full">
      <LeagueEntriesConsole
        seasons={data.seasons}
        season={season}
        isOpenSeason={season.id === data.defaultSeasonId}
        rows={rows}
      />
    </div>
  );
}
