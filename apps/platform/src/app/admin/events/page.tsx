import { getAllEventsForAdmin } from "@/server/queries/events";
import { EventsConsole } from "@/components/admin/events-console";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function EventsAdminPage() {
  await requireOfficerPage();
  const events = await getAllEventsForAdmin();

  return (
    <div className="h-full">
      <EventsConsole initialEvents={events} />
    </div>
  );
}