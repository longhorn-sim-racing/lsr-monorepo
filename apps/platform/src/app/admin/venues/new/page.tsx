import { VenueForm } from "@/components/admin/venue-form";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function NewVenuePage() {
  await requireOfficerPage();
  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold mb-6">New Venue</h1>
      <div className="overflow-x-auto">
        <VenueForm />
      </div>
    </div>
  );
}
