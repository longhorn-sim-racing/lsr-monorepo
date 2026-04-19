import { EventsSearch } from "@/components/events-search"
import { EventsFilters } from "@/components/events-filters"
import { EventsGrid } from "@/components/events-grid"
import { getAllEvents } from "@/server/queries/events";
import { Metadata } from "next"
import { DatabaseUnavailable } from "@/components/database-unavailable"

export const metadata: Metadata = {
  title: "Events Schedule",
  description: "View the official Longhorn Sim Racing event calendar, upcoming races, and past results.",
  alternates: {
    canonical: "/events",
  },
};

// ISR: regenerate at most once per day. Mutating actions (event
// create/update/publish/delete, results ingestion, etc.) call
// revalidatePath('/events') to invalidate sooner — see
// src/server/cache/revalidate-public.ts.
export const revalidate = 86400;

export default async function EventsIndexPage() {
  let allEvents;
  try {
    allEvents = await getAllEvents();
  } catch (error) {
    console.error('[Events] Failed to load events:', error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <div className="mb-10">
            <h1 className="font-display font-black italic text-5xl md:text-6xl text-white uppercase tracking-normal">
              The <span className="text-lsr-orange">Schedule</span>
            </h1>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-2">Official Event Calendar</p>
          </div>
          <DatabaseUnavailable title="Schedule Unavailable" />
        </div>
      </main>
    );
  }

  const allSeries = [...new Set(allEvents.map(e => e.series?.title).filter((s): s is string => !!s))].sort();

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
          <div>
            <h1 className="font-display font-black italic text-5xl md:text-6xl text-white uppercase tracking-normal">
              The <span className="text-lsr-orange">Schedule</span>
            </h1>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-2">Official Event Calendar</p>
          </div>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <EventsSearch />
            <EventsFilters allTypes={allSeries} />
          </div>
        </div>

        <EventsGrid allEvents={allEvents} />
      </div>
    </main>
  )
}
