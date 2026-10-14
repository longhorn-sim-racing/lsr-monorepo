"use client"

import Link from "next/link"
import { toast } from "sonner"
import { formatInTimeZone } from "date-fns-tz"
import { Pencil, RefreshCw } from "lucide-react"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { unexpectedError } from "@/lib/action-result"
import { Badge, Button, CellStack, DataTable, EmptyState, IconButton, RowActions, RowMenu, type Column, type RowMenuItem } from "@/components/admin/kit"
import { deleteSeason } from "@/app/admin/seasons/actions"
import { PHASE_LABEL, PHASE_TONE, type SeasonPhase } from "@/app/admin/seasons/_components/season-status"
import { useRecomputeStandings } from "@/app/admin/seasons/_components/use-recompute-standings"
import { cn } from "@/lib/utils"

export type SeasonRow = {
  id: string
  name: string
  slug: string
  year: number
  startAt: Date | null
  endAt: Date | null
  seriesTitle: string | null
  hasSeries: boolean
  leagueName: string | null
  /** Drivers in the standings */
  entries: number
  applications: number
  phase: SeasonPhase
}

const central = (date: Date, pattern: string) => formatInTimeZone(date, DEFAULT_TIMEZONE, pattern)

function dateRange(start: Date | null, end: Date | null) {
  if (!start && !end) return "No dates"
  if (start && end) {
    const sameYear = central(start, "yyyy") === central(end, "yyyy")
    return `${central(start, sameYear ? "MMM d" : "MMM d, yyyy")} – ${central(end, "MMM d, yyyy")}`
  }
  return start ? `From ${central(start, "MMM d, yyyy")}` : `Until ${central(end!, "MMM d, yyyy")}`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function SeasonsConsole({ seasons }: { seasons: SeasonRow[] }) {
  const { recompute, pendingId } = useRecomputeStandings()

  async function remove(season: SeasonRow) {
    try {
      await deleteSeason(season.id)
      toast.success(`Deleted ${season.name}`)
    } catch (error) {
      console.error(error)
      toast.error(unexpectedError(error, "Couldn't delete the season"))
    }
  }

  const columns: Column<SeasonRow>[] = [
    {
      id: "name",
      header: "Season",
      sortValue: (s) => s.name,
      cell: (s) => (
        <CellStack
          primary={
            <Link href={`/admin/seasons/${s.id}/edit`} className="hover:underline">
              {s.name}
            </Link>
          }
          secondary={`/${s.slug}`}
        />
      ),
    },
    {
      id: "series",
      header: "Series",
      sortValue: (s) => s.seriesTitle,
      cell: (s) => (s.seriesTitle ? <span className="text-muted-foreground">{s.seriesTitle}</span> : <span className="text-admin-subtle">None</span>),
    },
    { id: "league", header: "League", hideBelow: "lg", sortValue: (s) => s.leagueName, cell: (s) => <span className="text-muted-foreground">{s.leagueName ?? "None"}</span> },
    { id: "year", header: "Year", hideBelow: "md", sortValue: (s) => s.year, cell: (s) => s.year },
    { id: "dates", header: "Dates", sortValue: (s) => s.startAt?.getTime() ?? -Infinity, className: "whitespace-nowrap", cell: (s) => dateRange(s.startAt, s.endAt) },
    { id: "phase", header: "Status", sortValue: (s) => s.phase, cell: (s) => <Badge tone={PHASE_TONE[s.phase]}>{PHASE_LABEL[s.phase]}</Badge> },
    { id: "entries", header: "Standings", align: "right", hideBelow: "sm", sortValue: (s) => s.entries, cell: (s) => plural(s.entries, "driver") },
  ]

  return (
    <>
      <DataTable
        rows={seasons}
        columns={columns}
        getRowId={(s) => s.id}
        search={{ placeholder: "Search seasons", text: (s) => `${s.name} ${s.slug} ${s.seriesTitle ?? ""} ${s.leagueName ?? ""} ${s.year}` }}
        initialSort={{ id: "dates", desc: true }}
        rowHref={(s) => `/admin/seasons/${s.id}/edit`}
        noun={{ one: "season", many: "seasons" }}
        minWidth={720}
        empty={
          <EmptyState
            title="No seasons yet"
            description="Create a season to start tracking standings for a series."
            action={
              <Button variant="primary" asChild>
                <Link href="/admin/seasons/new">New season</Link>
              </Button>
            }
          />
        }
        rowActions={(s) => {
          const items: RowMenuItem[] = [{ label: "Edit", href: `/admin/seasons/${s.id}/edit` }]
          if (s.applications > 0) items.push({ label: "LSC applications", href: `/admin/league-entries?season=${encodeURIComponent(s.slug)}` })
          items.push("separator", {
            label: "Delete",
            destructive: {
              title: `Delete ${s.name}?`,
              description:
                s.entries || s.applications
                  ? `This also deletes its ${plural(s.entries, "standings row")} and ${plural(s.applications, "LSC application")}. Race results stay. This can't be undone.`
                  : "Race results stay. This can't be undone.",
            },
            onSelect: () => remove(s),
          })
          return (
            <RowActions>
              <IconButton
                label={s.hasSeries ? `Recompute standings for ${s.name}` : "Assign a series to recompute standings"}
                disabled={!s.hasSeries || pendingId !== null}
                onClick={() => recompute(s)}
              >
                <RefreshCw className={cn(pendingId === s.id && "animate-spin")} />
              </IconButton>
              <IconButton label={`Edit ${s.name}`} asChild>
                <Link href={`/admin/seasons/${s.id}/edit`}>
                  <Pencil />
                </Link>
              </IconButton>
              <RowMenu label={`More actions for ${s.name}`} items={items} />
            </RowActions>
          )
        }}
      />
    </>
  )
}
