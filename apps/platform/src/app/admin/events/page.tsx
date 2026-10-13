import type { Metadata } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { prisma } from "@/server/db"
import { getAllEventsForAdmin } from "@/server/queries/events"
import { requireOfficerPage } from "@/server/auth/guards"
import { getEffectiveEventStatus, isEventPublic } from "@/lib/events"
import { Button, PageHeader } from "@/components/admin/kit"
import { EventsConsole, type AdminEventRow } from "@/components/admin/events-console"

export const metadata: Metadata = { title: "Events" }

export default async function EventsAdminPage() {
  await requireOfficerPage()
  const [events, counts] = await Promise.all([
    getAllEventsForAdmin(),
    prisma.eventRegistration.groupBy({
      by: ["eventId", "status"],
      where: { status: { in: ["REGISTERED", "WAITLISTED"] } },
      _count: { _all: true },
    }),
  ])

  const tally = new Map<string, { registered: number; waitlisted: number }>()
  for (const row of counts) {
    const entry = tally.get(row.eventId) ?? { registered: 0, waitlisted: 0 }
    if (row.status === "REGISTERED") entry.registered = row._count._all
    else entry.waitlisted = row._count._all
    tally.set(row.eventId, entry)
  }

  const now = new Date()
  const rows: AdminEventRow[] = events.map((event) => ({
    id: event.id,
    slug: event.slug,
    title: event.title,
    series: event.series?.title ?? null,
    venue: event.venue?.name ?? null,
    startsAt: event.startsAtUtc,
    endsAt: event.endsAtUtc,
    status: event.status,
    effectiveStatus: getEffectiveEventStatus(event),
    publishedAt: event.publishedAt,
    isPublic: isEventPublic(event, now),
    past: event.endsAtUtc < now,
    registrationEnabled: event.registrationEnabled,
    registrationMax: event.registrationMax,
    registered: tally.get(event.id)?.registered ?? 0,
    waitlisted: tally.get(event.id)?.waitlisted ?? 0,
  }))

  const upcoming = rows.filter((row) => !row.past).length
  const drafts = rows.filter((row) => row.status === "DRAFT").length

  return (
    <>
      <PageHeader
        title="Events"
        description={`${upcoming} upcoming · ${drafts} ${drafts === 1 ? "draft" : "drafts"} · times in Central`}
        actions={
          <Button variant="primary" asChild>
            <Link href="/admin/events/new">
              <Plus aria-hidden />
              New event
            </Link>
          </Button>
        }
      />
      <EventsConsole events={rows} />
    </>
  )
}
