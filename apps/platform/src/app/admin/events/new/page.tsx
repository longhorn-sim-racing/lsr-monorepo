import type { Metadata } from "next"
import { EventForm } from "@/components/admin/event-form"
import { PageHeader } from "@/components/admin/kit"
import { getAllEventSeries } from "@/server/queries/events"
import { getAllVenues } from "@/server/queries/venue"
import { requireOfficerPage } from "@/server/auth/guards"

export const metadata: Metadata = { title: "New event" }

export default async function NewEventPage() {
  await requireOfficerPage()
  const [series, venues] = await Promise.all([getAllEventSeries(), getAllVenues()])

  return (
    <>
      <PageHeader title="New event" description="Fill in the details, then publish it, schedule it, or keep it as a draft." back={{ href: "/admin/events", label: "Events" }} />
      <EventForm series={series} venues={venues} />
    </>
  )
}
