
import { getEventForAdmin, getAllEventSeries } from "@/server/queries/events";
import { EventForm } from "@/components/admin/event-form";
import { getAllVenues } from "@/server/queries/venue";
import { notFound } from "next/navigation";
import { requireOfficerPage } from "@/server/auth/guards";

type EditEventArgs = {
  params: Promise<{ id: string }>;
};

export default async function EditEventPage({ params }: EditEventArgs) {
  await requireOfficerPage();
  const { id } = await params;
  const [event, series, venues] = await Promise.all([
    getEventForAdmin(id),
    getAllEventSeries(),
    getAllVenues(),
  ]);

  if (!event) {
    return notFound();
  }

  return (
    <div className="mx-auto max-w-4xl p-8 pb-32">
      <h1 className="text-3xl font-bold mb-6">Edit Event</h1>
      <div className="overflow-x-auto space-y-12">
        <EventForm event={event} series={series} venues={venues} />
      </div>
    </div>
  );
}
