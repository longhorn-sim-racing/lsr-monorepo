
import { getVenue } from "@/server/queries/venue";
import { VenueForm } from "@/components/admin/venue-form";
import { notFound } from "next/navigation";
import { requireOfficerPage } from "@/server/auth/guards";

type EditVenueArgs = {
  params: Promise<{ id: string }>;
};

export default async function EditVenuePage({ params }: EditVenueArgs) {
  await requireOfficerPage();
  const { id } = await params;
  const venue = await getVenue(id);

  if (!venue) {
    return notFound();
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold mb-6">Edit Venue</h1>
      <div className="overflow-x-auto">
        <VenueForm venue={venue} />
      </div>
    </main>
  );
}