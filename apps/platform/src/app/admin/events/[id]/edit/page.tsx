import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ClipboardCheck, ExternalLink } from "lucide-react"
import { getEventForAdmin, getAllEventSeries } from "@/server/queries/events"
import { getAllVenues } from "@/server/queries/venue"
import { requireOfficerPage } from "@/server/auth/guards"
import { isEventPublic } from "@/lib/events"
import { Button, PageHeader } from "@/components/admin/kit"
import { EventForm } from "@/components/admin/event-form"

export const metadata: Metadata = { title: "Edit event" }

export default async function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params
  const [event, series, venues] = await Promise.all([getEventForAdmin(id), getAllEventSeries(), getAllVenues()])

  if (!event) notFound()

  return (
    <>
      <PageHeader
        title={event.title}
        description="Edit details"
        back={{ href: "/admin/events", label: "Events" }}
        actions={
          <>
            <Button asChild>
              <a href={`/events/${event.slug}`} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden />
                {isEventPublic(event) ? "View page" : "Preview page"}
              </a>
            </Button>
            <Button asChild>
              <Link href={`/admin/events/${event.id}/manage`}>
                <ClipboardCheck aria-hidden />
                Registration and check-in
              </Link>
            </Button>
          </>
        }
      />
      <EventForm event={event} series={series} venues={venues} />
    </>
  )
}
