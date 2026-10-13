import type { Metadata } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { getAllVenues } from "@/server/queries/venue"
import { requireOfficerPage } from "@/server/auth/guards"
import { Button, PageHeader } from "@/components/admin/kit"
import { VenuesConsole } from "@/components/admin/venues-console"

export const metadata: Metadata = { title: "Venues" }

export default async function VenuesAdminPage() {
  await requireOfficerPage()
  const venues = await getAllVenues()

  return (
    <>
      <PageHeader
        title="Venues"
        description="Places events happen. Pick one on an event to show its address and map links."
        actions={
          <Button variant="primary" asChild>
            <Link href="/admin/venues/new">
              <Plus aria-hidden />
              New venue
            </Link>
          </Button>
        }
      />
      <VenuesConsole
        venues={venues.map((v) => ({
          id: v.id,
          name: v.name,
          room: v.room,
          addressLine1: v.addressLine1,
          city: v.city,
          state: v.state,
          country: v.country,
          googleMapsUrl: v.googleMapsUrl,
          appleMapsUrl: v.appleMapsUrl,
          events: v._count.events,
        }))}
      />
    </>
  )
}
