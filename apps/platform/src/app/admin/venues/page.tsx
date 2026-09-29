import { getAllVenues } from "@/server/queries/venue";
import { VenuesConsole } from "@/components/admin/venues-console";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function VenuesAdminPage() {
  await requireOfficerPage();
  const venues = await getAllVenues();

  return (
    <div className="h-full">
      <VenuesConsole initialVenues={venues} />
    </div>
  );
}