"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import type { EventStatus } from "@prisma/client"
import { ClipboardCheck, ExternalLink, Pencil, Plus } from "lucide-react"
import {
  Button,
  CellStack,
  DataTable,
  EmptyState,
  FilterMenu,
  IconButton,
  RowActions,
  RowMenu,
  Segmented,
  type Column,
} from "@/components/admin/kit"
import { deleteEvent } from "@/app/admin/events/actions"
import { useAction } from "@/app/admin/events/_components/use-action"
import { EVENT_STATUS, EVENT_STATUSES, EventStatusBadge } from "@/app/admin/events/_components/event-status"
import { central, centralDateTime, centralDay, centralTimeRange } from "@/app/admin/events/_components/format"
import { StatusOverrideDialog } from "./status-override-dialog"

/** One event in the admin list. Statuses and past/public are worked out on the server for this request. */
export type AdminEventRow = {
  id: string
  slug: string
  title: string
  series: string | null
  venue: string | null
  startsAt: Date
  endsAt: Date
  /** What's saved */
  status: EventStatus
  /** What the public sees right now (e.g. a published event that has ended is Completed) */
  effectiveStatus: EventStatus
  publishedAt: Date | null
  isPublic: boolean
  past: boolean
  registrationEnabled: boolean
  registrationMax: number | null
  registered: number
  waitlisted: number
}

type View = "all" | "upcoming" | "past" | "drafts"

const IN_VIEW: Record<View, (row: AdminEventRow) => boolean> = {
  all: () => true,
  upcoming: (row) => !row.past,
  past: (row) => row.past,
  drafts: (row) => row.status === "DRAFT",
}

const byStart = (a: AdminEventRow, b: AdminEventRow) => a.startsAt.getTime() - b.startsAt.getTime()

const EMPTY: Record<View, { title: string; description: string }> = {
  all: { title: "No events yet", description: "Create the first one; it stays a draft until you publish it." },
  upcoming: { title: "Nothing coming up", description: "Every event has ended. Create the next one, or look under Past." },
  past: { title: "No past events", description: "Events show up here once they end." },
  drafts: { title: "No drafts", description: "Every event has been published or scheduled." },
}

function Registered({ row }: { row: AdminEventRow }) {
  if (!row.registrationEnabled && row.registered === 0 && row.waitlisted === 0) {
    return <span className="text-admin-subtle">Off</span>
  }
  const full = row.registrationMax != null && row.registered >= row.registrationMax
  return (
    <div className="flex flex-col items-end">
      <span className={full ? "font-semibold" : undefined}>
        {row.registered}
        {row.registrationMax != null && <span className="text-admin-subtle"> / {row.registrationMax}</span>}
      </span>
      {row.waitlisted > 0 && <span className="text-xs text-admin-subtle">+{row.waitlisted} waitlist</span>}
    </div>
  )
}

export function EventsConsole({ events }: { events: AdminEventRow[] }) {
  const [view, setView] = useState<View>(() => (events.some((row) => !row.past) ? "upcoming" : "all"))
  const [statuses, setStatuses] = useState<EventStatus[]>([])
  const [overriding, setOverriding] = useState<AdminEventRow | null>(null)
  const { run, busyKey } = useAction()

  const rows = useMemo(() => {
    const list = events.filter(IN_VIEW[view]).filter((row) => statuses.length === 0 || statuses.includes(row.effectiveStatus))
    // Coming up: soonest first. Everything else: newest first.
    return view === "upcoming" || view === "drafts" ? list.sort(byStart) : list.sort((a, b) => byStart(b, a))
  }, [events, view, statuses])

  const columns: Column<AdminEventRow>[] = [
    {
      id: "event",
      header: "Event",
      sortValue: (row) => row.title,
      className: "max-w-[22rem]",
      cell: (row) => (
        <CellStack
          primary={
            <Link href={`/admin/events/${row.id}/manage`} className="hover:underline">
              {row.title}
            </Link>
          }
          secondary={row.series ?? undefined}
        />
      ),
    },
    {
      id: "date",
      header: "Date · time",
      sortValue: (row) => row.startsAt,
      className: "whitespace-nowrap",
      cell: (row) => (
        <div className="flex flex-col">
          <span>{centralDay(row.startsAt)}</span>
          <span className="text-xs text-admin-subtle">{centralTimeRange(row.startsAt, row.endsAt)}</span>
        </div>
      ),
    },
    {
      id: "venue",
      header: "Venue",
      hideBelow: "md",
      sortValue: (row) => row.venue,
      className: "max-w-[14rem]",
      cell: (row) => (row.venue ? <span className="block truncate">{row.venue}</span> : <span className="text-admin-subtle">None</span>),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (row) => EVENT_STATUSES.indexOf(row.effectiveStatus),
      cell: (row) => (
        <div className="flex flex-col items-start gap-0.5">
          <EventStatusBadge status={row.effectiveStatus} />
          {row.effectiveStatus === "SCHEDULED" && row.publishedAt && (
            <span className="whitespace-nowrap text-xs text-admin-subtle">Goes public {central(row.publishedAt, "MMM d, h:mm a")}</span>
          )}
        </div>
      ),
    },
    {
      id: "registered",
      header: "Registered",
      align: "right",
      hideBelow: "sm",
      sortValue: (row) => row.registered,
      cell: (row) => <Registered row={row} />,
    },
  ]

  const remove = (row: AdminEventRow) =>
    run(() => deleteEvent(row.id), { success: `Deleted ${row.title}`, error: "Couldn't delete the event" }, row.id)

  const deleteText = (row: AdminEventRow) => {
    const people = row.registered + row.waitlisted
    const registrations = people > 0 ? `Its ${people} ${people === 1 ? "registration" : "registrations"} and any check-ins are deleted too. ` : "Any registrations and check-ins are deleted too. "
    return `${registrations}Uploaded results, photos and payments are kept but lose the link to it. This can't be undone.`
  }

  const count = (v: View) => events.filter(IN_VIEW[v]).length

  return (
    <>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        rowHref={(row) => `/admin/events/${row.id}/manage`}
        noun={{ one: "event", many: "events" }}
        minWidth={600}
        search={{ placeholder: "Search events", text: (row) => `${row.title} ${row.slug} ${row.series ?? ""} ${row.venue ?? ""}` }}
        filters={
          <>
            <Segmented
              label="Show"
              value={view}
              onChange={setView}
              options={[
                { value: "upcoming", label: "Upcoming", count: count("upcoming") },
                { value: "past", label: "Past", count: count("past") },
                { value: "drafts", label: "Drafts", count: count("drafts") },
                { value: "all", label: "All", count: events.length },
              ]}
            />
            <FilterMenu
              label="Status"
              selected={statuses}
              onChange={setStatuses}
              options={EVENT_STATUSES.map((status) => ({ value: status, label: EVENT_STATUS[status].label }))}
            />
          </>
        }
        empty={
          statuses.length > 0 ? (
            <EmptyState
              title="No events with that status"
              description="Clear the status filter or pick another view."
              action={<Button onClick={() => setStatuses([])}>Clear status filter</Button>}
            />
          ) : (
            <EmptyState
              title={EMPTY[view].title}
              description={EMPTY[view].description}
              action={
                <Button variant="primary" asChild>
                  <Link href="/admin/events/new">
                    <Plus aria-hidden />
                    New event
                  </Link>
                </Button>
              }
            />
          )
        }
        rowActions={(row) => (
          <RowActions>
            <IconButton label={row.isPublic ? "View public page" : "Preview public page"} asChild>
              <a href={`/events/${row.slug}`} target="_blank" rel="noreferrer">
                <ExternalLink />
              </a>
            </IconButton>
            <IconButton label="Registration and check-in" asChild>
              <Link href={`/admin/events/${row.id}/manage`}>
                <ClipboardCheck />
              </Link>
            </IconButton>
            <IconButton label="Edit details" asChild>
              <Link href={`/admin/events/${row.id}/edit`}>
                <Pencil />
              </Link>
            </IconButton>
            <RowMenu
              label={`More actions for ${row.title}`}
              items={[
                { label: "Override status", onSelect: () => setOverriding(row) },
                "separator",
                {
                  label: busyKey === row.id ? "Deleting…" : "Delete event",
                  disabled: busyKey === row.id,
                  destructive: { title: `Delete ${row.title}?`, description: deleteText(row), confirmLabel: "Delete event" },
                  onSelect: () => remove(row),
                },
              ]}
            />
          </RowActions>
        )}
      />
      <StatusOverrideDialog
        event={overriding}
        onOpenChange={(open) => !open && setOverriding(null)}
        scheduledNote={overriding?.publishedAt ? centralDateTime(overriding.publishedAt) : null}
      />
    </>
  )
}
