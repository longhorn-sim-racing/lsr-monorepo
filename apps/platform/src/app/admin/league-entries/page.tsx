import type { Metadata } from "next"
import Link from "next/link"
import { requireOfficerPage } from "@/server/auth/guards"
import { getEntrantRows, getLeagueSeasonsForAdmin } from "@/server/queries/league-entrants"
import { Button, EmptyState, PageHeader, Panel } from "@/components/admin/kit"
import { LeagueEntriesConsole } from "@/components/admin/league-entries-console"

export const metadata: Metadata = { title: "LSC entries" }

export default async function LeagueEntriesAdminPage({ searchParams }: { searchParams: Promise<{ season?: string }> }) {
  // The admin layout checks too, but layouts don't re-run on every render; this page returns contact details.
  await requireOfficerPage()
  const { season: seasonSlug } = await searchParams
  const data = await getLeagueSeasonsForAdmin("lone-star-cup")

  if (!data || !data.seasons.length) {
    return (
      <>
        <PageHeader title="LSC entries" />
        <Panel>
          <EmptyState
            title="No Lone Star Cup seasons yet"
            description="Entries are tracked per season. Create the season first, then drivers can enter it."
            action={
              <Button asChild>
                <Link href="/admin/seasons">Go to seasons</Link>
              </Button>
            }
          />
        </Panel>
      </>
    )
  }

  const season = data.seasons.find((s) => s.slug === seasonSlug) ?? data.seasons.find((s) => s.id === data.defaultSeasonId)!
  const rows = (await getEntrantRows(season.id)) ?? []

  return <LeagueEntriesConsole seasons={data.seasons} season={season} isOpenSeason={season.id === data.defaultSeasonId} rows={rows} />
}
