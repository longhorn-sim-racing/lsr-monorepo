"use client"

import Link from "next/link"
import { Button, Panel, PanelBody, PanelHeader } from "@/components/admin/kit"
import { useRecomputeStandings } from "./use-recompute-standings"

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The edit page's side panel: what the season holds, and the recompute action. */
export function StandingsPanel({
  season,
  entries,
  applications,
}: {
  season: { id: string; name: string; slug: string; seriesId: string | null }
  entries: number
  applications: number
}) {
  const { recompute, pendingId } = useRecomputeStandings()
  return (
    <Panel>
      <PanelHeader title="Standings" description={`${plural(entries, "driver")} in the standings`} />
      <PanelBody className="flex flex-col gap-3 text-[13px]">
        <p className="text-muted-foreground">
          Standings are computed from the ingested race results of this season&apos;s series, within its dates. Recompute after ingesting results or
          changing a driver mapping.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => recompute(season)} pending={pendingId === season.id} disabled={!season.seriesId}>
            Recompute standings
          </Button>
          {!season.seriesId && <span className="text-xs text-admin-subtle">Assign a series first.</span>}
        </div>
        {applications > 0 && (
          <Link href={`/admin/league-entries?season=${encodeURIComponent(season.slug)}`} className="w-fit text-[13px] font-medium hover:underline">
            {plural(applications, "LSC application")}
          </Link>
        )}
      </PanelBody>
    </Panel>
  )
}
