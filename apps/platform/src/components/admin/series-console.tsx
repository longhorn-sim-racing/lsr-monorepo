"use client"

import Link from "next/link"
import type { Visibility } from "@prisma/client"
import { Pencil, Plus } from "lucide-react"
import { Badge, Button, CellStack, DataTable, EmptyState, IconButton, RowActions, RowMenu, type Column, type Tone } from "@/components/admin/kit"
import { deleteSeries } from "@/app/admin/series/actions"
import { useAction } from "@/app/admin/events/_components/use-action"

export type AdminSeriesRow = {
  id: string
  title: string
  slug: string
  visibility: Visibility
  events: number
  seasons: number
}

const VISIBILITY: Record<Visibility, { label: string; tone: Tone }> = {
  public: { label: "Public", tone: "success" },
  members: { label: "Members", tone: "info" },
  officers: { label: "Officers", tone: "neutral" },
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function SeriesConsole({ series }: { series: AdminSeriesRow[] }) {
  const { run, busyKey } = useAction()

  const columns: Column<AdminSeriesRow>[] = [
    {
      id: "title",
      header: "Series",
      sortValue: (row) => row.title,
      className: "max-w-[22rem]",
      cell: (row) => (
        <CellStack
          primary={
            <Link href={`/admin/series/${row.id}/edit`} className="hover:underline">
              {row.title}
            </Link>
          }
          secondary={row.slug}
        />
      ),
    },
    {
      id: "visibility",
      header: "Visibility",
      hideBelow: "sm",
      sortValue: (row) => row.visibility,
      cell: (row) => <Badge tone={VISIBILITY[row.visibility].tone}>{VISIBILITY[row.visibility].label}</Badge>,
    },
    { id: "events", header: "Events", align: "right", sortValue: (row) => row.events, cell: (row) => row.events },
    { id: "seasons", header: "Seasons", align: "right", sortValue: (row) => row.seasons, cell: (row) => row.seasons },
  ]

  const deleteText = (row: AdminSeriesRow) => {
    const linked = [row.events > 0 ? plural(row.events, "event", "events") : null, row.seasons > 0 ? plural(row.seasons, "season", "seasons") : null].filter(Boolean)
    return linked.length > 0
      ? `Its ${linked.join(" and ")} are kept but no longer belong to a series. This can't be undone.`
      : "Nothing uses it yet. This can't be undone."
  }

  return (
    <DataTable
      rows={series}
      columns={columns}
      getRowId={(row) => row.id}
      rowHref={(row) => `/admin/series/${row.id}/edit`}
      minWidth={480}
      noun={{ one: "series", many: "series" }}
      search={{ placeholder: "Search series", text: (row) => `${row.title} ${row.slug}` }}
      empty={
        <EmptyState
          title="No series yet"
          description="A series groups related events and seasons, like a racing league."
          action={
            <Button variant="primary" asChild>
              <Link href="/admin/series/new">
                <Plus aria-hidden />
                New series
              </Link>
            </Button>
          }
        />
      }
      rowActions={(row) => (
        <RowActions>
          <IconButton label={`Edit ${row.title}`} asChild>
            <Link href={`/admin/series/${row.id}/edit`}>
              <Pencil />
            </Link>
          </IconButton>
          <RowMenu
            label={`More actions for ${row.title}`}
            items={[
              {
                label: busyKey === row.id ? "Deleting…" : "Delete series",
                disabled: busyKey === row.id,
                destructive: { title: `Delete ${row.title}?`, description: deleteText(row), confirmLabel: "Delete series" },
                onSelect: () => run(() => deleteSeries(row.id), { success: `Deleted ${row.title}`, error: "Couldn't delete the series" }, row.id),
              },
            ]}
          />
        </RowActions>
      )}
    />
  )
}
