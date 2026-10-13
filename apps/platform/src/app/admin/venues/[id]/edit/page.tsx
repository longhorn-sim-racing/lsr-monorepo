import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { getVenue } from "@/server/queries/venue"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { VenueForm } from "@/components/admin/venue-form"

export const metadata: Metadata = { title: "Edit venue" }

export default async function EditVenuePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params
  const venue = await getVenue(id)

  if (!venue) notFound()

  return (
    <>
      <PageHeader title={venue.name} description="Edit venue" back={{ href: "/admin/venues", label: "Venues" }} />
      <VenueForm venue={venue} />
    </>
  )
}
