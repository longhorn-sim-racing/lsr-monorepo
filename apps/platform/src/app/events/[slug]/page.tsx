import { getEventBySlug } from "@/server/queries/events";
import { getIngestedResultsByEventId, getLapDataBySessionId } from "@/server/queries/results";
import { LapPositionChart, type LapPositionData } from "@/components/lap-position-chart";
import { notFound } from "next/navigation";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Calendar, Clock, MapPin, Send, Trophy, QrCode, CreditCard, Copy, ExternalLink } from "lucide-react";
import Link from "next/link";
import { LocalTime, LocalTimeRange } from "@/components/ui/local-time";
import { Button } from "@/components/ui/button";
import { VenueActions } from "@/components/venue-actions";
import { ResultsTable } from "@/components/results-table";
import { EventRegistrationPanel } from "@/components/event-registration-panel";
import { getSessionUser } from "@/server/auth/session";
import { Metadata } from "next";
import { isEventLive } from "@/lib/events";
import { StreamPlayer } from "@/components/stream-player";
import { DatabaseUnavailable } from "@/components/database-unavailable";

type EventPageArgs = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: EventPageArgs): Promise<Metadata> {
  const { slug } = await params;
  return {
    alternates: {
      canonical: `/events/${slug}`,
    },
  };
}

export default async function EventPage({ params }: EventPageArgs) {
  const { slug } = await params;

  let event, user;
  try {
    [event, { user }] = await Promise.all([
      getEventBySlug(slug),
      getSessionUser(),
    ]);
  } catch (error) {
    console.error('[EventPage] Failed to load event:', error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <DatabaseUnavailable title="Event Unavailable" />
        </div>
      </main>
    );
  }

  if (!event) {
    return notFound();
  }

  let rawSessions: Awaited<ReturnType<typeof getIngestedResultsByEventId>>;
  try {
    rawSessions = await getIngestedResultsByEventId(event.id);
  } catch {
    rawSessions = [];
  }
  const sessionTypeOrder: Record<string, number> = { PRACTICE: 0, QUALIFYING: 1, RACE: 2 };
  const raceSessions = [...rawSessions].sort(
    (a, b) => (sessionTypeOrder[a.sessionType] ?? 2) - (sessionTypeOrder[b.sessionType] ?? 2)
  );

  // Build qualifying position map: driverGuid → qualifying position
  const qualiSession = rawSessions.find(s => s.sessionType === "QUALIFYING");
  const qualiPositionByGuid = new Map<string, number>();
  if (qualiSession) {
    for (const result of qualiSession.results) {
      qualiPositionByGuid.set(result.participant.driverGuid, result.position);
    }
  }

  // Build positions gained maps per race session: participantId → { gained, gridPosition }
  const positionsGainedBySession = new Map<string, Map<string, { gained: number; grid: number }>>();
  for (const session of rawSessions) {
    if (session.sessionType !== "RACE") continue;
    const map = new Map<string, { gained: number; grid: number }>();
    for (const result of session.results) {
      const qualiPos = qualiPositionByGuid.get(result.participant.driverGuid);
      if (qualiPos !== undefined) {
        map.set(result.participant.id, { gained: qualiPos - result.position, grid: qualiPos });
      }
    }
    positionsGainedBySession.set(session.id, map);
  }

  // Fetch lap data for RACE sessions and compute lap-by-lap positions
  const raceSessionIds = rawSessions
    .filter((s) => s.sessionType === "RACE")
    .map((s) => s.id);
  const lapDataBySession = new Map<
    string,
    { data: LapPositionData[]; drivers: string[]; driverCount: number }
  >();

  if (raceSessionIds.length > 0) {
    const lapResults = await Promise.all(
      raceSessionIds.map((id) => getLapDataBySessionId(id))
    );

    for (let i = 0; i < raceSessionIds.length; i++) {
      const sessionId = raceSessionIds[i];
      const laps = lapResults[i];
      if (laps.length === 0) continue;

      // Group laps by participant, compute cumulative times
      const participantLaps = new Map<
        string,
        { name: string; lapTimes: { lap: number; cumTime: number }[] }
      >();

      for (const lap of laps) {
        const pid = lap.participantId;
        if (!participantLaps.has(pid)) {
          const displayName =
            lap.participant.carMapping?.displayName ??
            lap.participant.user?.displayName ??
            lap.participant.displayName;
          participantLaps.set(pid, { name: displayName, lapTimes: [] });
        }
        const entry = participantLaps.get(pid)!;
        const prevCum =
          entry.lapTimes.length > 0
            ? entry.lapTimes[entry.lapTimes.length - 1].cumTime
            : 0;
        entry.lapTimes.push({
          lap: lap.lapNumber,
          cumTime: prevCum + lap.lapTime,
        });
      }

      // Find the max lap number across all participants
      const maxLap = Math.max(
        ...Array.from(participantLaps.values()).map(
          (p) => p.lapTimes[p.lapTimes.length - 1]?.lap ?? 0
        )
      );
      const driverCount = participantLaps.size;

      // For each lap, rank drivers by cumulative time
      const chartData: LapPositionData[] = [];
      for (let lap = 1; lap <= maxLap; lap++) {
        const driversAtLap: { name: string; cumTime: number }[] = [];
        for (const [, p] of participantLaps) {
          const lapEntry = p.lapTimes.find((l) => l.lap === lap);
          if (lapEntry) {
            driversAtLap.push({ name: p.name, cumTime: lapEntry.cumTime });
          }
        }
        driversAtLap.sort((a, b) => a.cumTime - b.cumTime);
        const point: LapPositionData = { lap };
        driversAtLap.forEach((d, idx) => {
          point[d.name] = idx + 1;
        });
        chartData.push(point);
      }

      // Order drivers by their final position
      const finalLap = chartData[chartData.length - 1];
      const drivers = Object.entries(finalLap)
        .filter(([key]) => key !== "lap")
        .sort((a, b) => (a[1] as number) - (b[1] as number))
        .map(([name]) => name);

      lapDataBySession.set(sessionId, {
        data: chartData,
        drivers,
        driverCount,
      });
    }
  }

  const startsAt = new Date(event.startsAtUtc);
  const endsAt = new Date(event.endsAtUtc);
  const isLive = isEventLive(event);

  const isCheckinRequired = event.attendanceEnabled &&
    event.attendanceReportingMode === 'CHECKIN_REQUIRED';
  const isPaidEvent = event.registrationFeeCents != null && event.registrationFeeCents > 0;

  // const isEventPassed = new Date() > endsAt; // Logic handled by registration config/snapshot

  const venue = event.venue;

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
        <div className="mb-8">
          <Link href="/events" className="group inline-flex items-center gap-3 text-[10px] font-sans font-bold uppercase tracking-[0.25em] text-lsr-orange hover:text-white transition-colors">
            <div className="h-px w-8 bg-lsr-orange/30 group-hover:bg-white group-hover:w-12 transition-all" />
            Return to Calendar
          </Link>
        </div>

        {event.heroImageUrl && (
          <div className="aspect-[21/9] w-full border border-white/10 bg-black relative overflow-hidden group mb-12">
            <Image 
              src={event.heroImageUrl} 
              alt={event.title} 
              width={1600} 
              height={800} 
              className="object-cover w-full h-full opacity-60 group-hover:opacity-80 transition-opacity duration-700" 
            />
            <div className="absolute inset-0 bg-[linear-gradient(transparent_50%,rgba(0,0,0,0.5)_50%)] bg-[length:100%_4px] opacity-20 pointer-events-none" />
            <div className="absolute bottom-4 right-4 bg-black/80 px-3 py-1 border border-white/10">
              <span className="font-sans font-black text-[9px] uppercase tracking-widest text-white/50">Event Preview</span>
            </div>
          </div>
        )}

        <div className="border-l-4 border-lsr-orange bg-white/[0.02] p-8 md:p-12 mb-12 relative">
          <div className="relative grid grid-cols-1 lg:grid-cols-3 gap-12">
            <div className="lg:col-span-2">
              <div className="flex flex-wrap items-center gap-3 mb-6">
                  {isLive && (
                    <div className="flex items-center gap-1.5 border border-red-600/30 bg-red-600/10 px-2 py-0.5 rounded-none">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-600"></span>
                        </span>
                        <span className="font-display font-black text-red-500 uppercase tracking-widest text-[9px] italic">Live Now</span>
                    </div>
                  )}
                  {event.series && (
                    <span className="bg-lsr-orange text-white px-2 py-0.5 text-[9px] font-black uppercase tracking-widest">
                      {event.series.title}
                    </span>
                  )}
                  <span className="border border-white/20 text-white/60 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest">
                    Official Session
                  </span>
                </div>
              
              <h1 className="font-display font-black italic text-4xl md:text-6xl text-white uppercase tracking-normal leading-[0.9] mb-6">
                {event.title}
              </h1>

              {isCheckinRequired && (
                <div className="border-l border-white/10 bg-black/10 px-4 py-2 mb-8 flex items-center gap-3 max-w-2xl">
                  <QrCode className="h-3.5 w-3.5 text-white/20 shrink-0" />
                  <p className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/30 leading-tight">
                    <span className="text-lsr-orange/60 font-black mr-2">Note:</span>
                    Attendance is recorded via QR Check-in at this event
                  </p>
                </div>
              )}

              <div className="prose prose-invert prose-p:font-sans prose-p:text-white/70 prose-p:text-sm prose-p:leading-relaxed max-w-none">
                <p>{event.summary || event.description}</p>
              </div>

              <div className="mt-10 pt-8 border-t border-white/5 space-y-4">
                <p className="font-sans text-[11px] text-white/40 leading-relaxed max-w-2xl">
                  Questions, comments, or concerns? Reach out to us at <Link href="mailto:info@longhornsimracing.org" className="text-white/60 hover:text-lsr-orange transition-colors border-b border-white/10 hover:border-lsr-orange">info@longhornsimracing.org</Link>.
                </p>
                <p className="font-sans text-[11px] text-white/40 leading-relaxed max-w-2xl">
                  <strong className="text-white/60 uppercase tracking-widest text-[9px] mr-2">Note:</strong> Most physical events will have arranged carpooling available upon request within our <Link href="https://discord.gg/5Uv9YwpnFz" target="_blank" className="text-white/60 hover:text-lsr-orange transition-colors border-b border-white/10 hover:border-lsr-orange">Discord community</Link>.
                </p>
              </div>
            </div>

            <div className="lg:col-span-1">
              {isLive && event.streamUrl && (
                <div className="mb-6">
                  <StreamPlayer streamUrl={event.streamUrl} />
                </div>
              )}
              <div className="bg-black border border-white/10 p-6 space-y-6">
                <h3 className="font-sans font-black text-xs uppercase tracking-[0.2em] text-white/30 border-b border-white/10 pb-4">
                  Session Logistics
                </h3>
                
                <div className="space-y-5">
                  <div className="flex items-start gap-4">
                    <Calendar className="h-5 w-5 text-lsr-orange mt-0.5 shrink-0" />
                    <div>
                      <div className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/40 mb-1">Date</div>
                      <div className="font-sans font-bold text-sm text-white">
                        <LocalTime date={startsAt} format="weekday-date" />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <Clock className="h-5 w-5 text-lsr-orange mt-0.5 shrink-0" />
                    <div>
                      <div className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/40 mb-1">Time</div>
                      <div className="font-sans font-bold text-sm text-white">
                        <LocalTimeRange start={startsAt} end={endsAt} />
                      </div>
                    </div>
                  </div>

                  {venue && (
                    <div className="flex items-start gap-4">
                      <MapPin className="h-5 w-5 text-lsr-orange mt-0.5 shrink-0" />
                      <div className="space-y-2">
                        <div className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/40">Circuit / Venue</div>
                        <div className="font-sans font-bold text-sm text-white">{venue.name}</div>
                        {(venue.addressLine1 || venue.city) && (
                          <div className="text-xs text-white/40">
                            {[venue.addressLine1, venue.city, venue.state].filter(Boolean).join(", ")}
                          </div>
                        )}
                        <VenueActions venue={venue} />
                      </div>
                    </div>
                  )}

                  {isPaidEvent && (
                    <div className="flex items-start gap-4">
                      <CreditCard className="h-5 w-5 text-lsr-orange mt-0.5 shrink-0" />
                      <div>
                        <div className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/40 mb-1">Paid Event</div>
                        <div className="font-sans text-xs text-white/50 leading-relaxed">
                          For payment issues or refunds, contact{" "}
                          <a href="mailto:info@longhornsimracing.org" className="text-white/70 hover:text-lsr-orange transition-colors border-b border-white/10 hover:border-lsr-orange">info@longhornsimracing.org</a>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <EventRegistrationPanel eventSlug={slug} userLoggedIn={!!user} />
              </div>
            </div>
          </div>

          {raceSessions.length > 0 && (
            <div className="relative mt-12 pt-12 border-t border-white/10">
              <div className="space-y-8">
                {raceSessions.map(session => {
                    const typeLabel = session.sessionType === "QUALIFYING" ? "Qualifying" : session.sessionType === "PRACTICE" ? "Practice" : "Race";
                    const isRace = session.sessionType === "RACE";
                    const lapPositions = isRace ? lapDataBySession.get(session.id) : undefined;
                    return (
                    <div key={session.id}>
                        <ResultsTable
                            results={session.results}
                            title={`${typeLabel} Results${session.trackName ? ` - ${session.trackName}` : ''}`}
                            showPoints={isRace}
                            sessionType={session.sessionType}
                            positionsGained={isRace ? positionsGainedBySession.get(session.id) : undefined}
                        />
                        {lapPositions && (
                          <LapPositionChart
                            data={lapPositions.data}
                            drivers={lapPositions.drivers}
                            driverCount={lapPositions.driverCount}
                          />
                        )}
                    </div>
                    );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
