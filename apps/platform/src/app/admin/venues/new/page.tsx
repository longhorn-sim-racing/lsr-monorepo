import type { Metadata } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { VenueForm } from "@/components/admin/venue-form"

export const metadata: Metadata = { title: "New venue" }

export default async function NewVenuePage() {
  await requireOfficerPage()
  return (
    <>
      <PageHeader title="New venue" back={{ href: "/admin/venues", label: "Venues" }} />
      <VenueForm />
    </>
  )
}
