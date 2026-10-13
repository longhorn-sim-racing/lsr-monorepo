"use client"

import Link from "next/link"
import { Pencil, Plus } from "lucide-react"
import { Button, CellStack, DataTable, EmptyState, IconButton, RowActions, RowMenu, type Column, type RowMenuItem } from "@/components/admin/kit"
import { deleteVenue } from "@/app/admin/venues/actions"
import { useAction } from "@/app/admin/events/_components/use-action"

export type AdminVenueRow = {
  id: string
  name: string
  room: string | null
  addressLine1: string | null
  city: string | null
  state: string | null
  country: string | null
  googleMapsUrl: string | null
  appleMapsUrl: string | null
  events: number
}

const locationOf = (row: AdminVenueRow) => [row.city, row.state, row.country].filter(Boolean).join(", ")

export function VenuesConsole({ venues }: { venues: AdminVenueRow[] }) {
  const { run, busyKey } = useAction()

  const columns: Column<AdminVenueRow>[] = [
    {
      id: "name",
      header: "Venue",
      sortValue: (row) => row.name,
      className: "max-w-[22rem]",
      cell: (row) => (
        <CellStack
          primary={
            <Link href={`/admin/venues/${row.id}/edit`} className="hover:underline">
              {row.name}
            </Link>
          }
          secondary={[row.room, row.addressLine1].filter(Boolean).join(" · ") || undefined}
        />
      ),
    },
    {
      id: "location",
      header: "Location",
      hideBelow: "sm",
      sortValue: (row) => locationOf(row) || null,
      cell: (row) => locationOf(row) || <span className="text-admin-subtle">None</span>,
    },
    {
      id: "maps",
      header: "Map links",
      hideBelow: "md",
      cell: (row) =>
        row.googleMapsUrl || row.appleMapsUrl ? (
          <span className="flex gap-3">
            {row.googleMapsUrl && (
              <a href={row.googleMapsUrl} target="_blank" rel="noreferrer" className="hover:underline">
                Google
              </a>
            )}
            {row.appleMapsUrl && (
              <a href={row.appleMapsUrl} target="_blank" rel="noreferrer" className="hover:underline">
                Apple
              </a>
            )}
          </span>
        ) : (
          <span className="text-admin-subtle">None</span>
        ),
    },
    { id: "events", header: "Events", align: "right", sortValue: (row) => row.events, cell: (row) => row.events },
  ]

  const menu = (row: AdminVenueRow): RowMenuItem[] => [
    ...(row.googleMapsUrl ? [{ label: "Open in Google Maps", href: row.googleMapsUrl, external: true }] : []),
    ...(row.appleMapsUrl ? [{ label: "Open in Apple Maps", href: row.appleMapsUrl, external: true }] : []),
    ...(row.googleMapsUrl || row.appleMapsUrl ? (["separator"] as const) : []),
    {
      label: busyKey === row.id ? "Deleting…" : "Delete venue",
      disabled: busyKey === row.id,
      destructive: {
        title: `Delete ${row.name}?`,
        description:
          row.events > 0
            ? `${row.events} ${row.events === 1 ? "event uses" : "events use"} it; they're kept but show no venue. This can't be undone.`
            : "No events use it. This can't be undone.",
        confirmLabel: "Delete venue",
      },
      onSelect: () => run(() => deleteVenue(row.id), { success: `Deleted ${row.name}`, error: "Couldn't delete the venue" }, row.id),
    },
  ]

  return (
    <DataTable
      rows={venues}
      columns={columns}
      getRowId={(row) => row.id}
      rowHref={(row) => `/admin/venues/${row.id}/edit`}
      minWidth={480}
      noun={{ one: "venue", many: "venues" }}
      search={{ placeholder: "Search venues", text: (row) => `${row.name} ${row.room ?? ""} ${row.addressLine1 ?? ""} ${locationOf(row)}` }}
      empty={
        <EmptyState
          title="No venues yet"
          description="Add the places events happen, with their address and map links."
          action={
            <Button variant="primary" asChild>
              <Link href="/admin/venues/new">
                <Plus aria-hidden />
                New venue
              </Link>
            </Button>
          }
        />
      }
      rowActions={(row) => (
        <RowActions>
          <IconButton label={`Edit ${row.name}`} asChild>
            <Link href={`/admin/venues/${row.id}/edit`}>
              <Pencil />
            </Link>
          </IconButton>
          <RowMenu label={`More actions for ${row.name}`} items={menu(row)} />
        </RowActions>
      )}
    />
  )
}
