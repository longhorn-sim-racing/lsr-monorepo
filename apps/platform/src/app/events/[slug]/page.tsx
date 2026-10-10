import { getEventBySlug } from "@/server/queries/events";
import { getIngestedResultsByEventId, getLapDataBySessionId } from "@/server/queries/results";
import { getSchedule, roundOf, timeRange } from "@/server/queries/schedule";
import { LapPositionChart, type LapPositionData } from "@/components/lap-position-chart";
import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CalendarDays, Clock, CreditCard, Images, MapPin, Monitor, Moon, QrCode, Trophy } from "lucide-react";
import { VenueActions } from "@/components/venue-actions";
import { ResultsTable } from "@/components/results-table";
import { EventRegistrationPanel } from "@/components/event-registration-panel";
import { AgendaRow } from "@/components/events/agenda-row";
import { CloudinaryImage } from "@/components/cloudinary-image";
import { getSessionUser } from "@/server/auth/session";
import { isViewerOfficer } from "@/server/auth/guards";
import { Metadata } from "next";
import { isEventLive, isEventPublic } from "@/lib/events";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { prisma } from "@/server/db";
import { StreamPlayer } from "@/components/stream-player";
import { DatabaseUnavailable } from "@/components/database-unavailable";
import { initials } from "@/app/drivers/names";
import { CANONICAL_SITE_URL } from "@/lib/site-url";
import { formatCents } from "@/lib/money";

// Per request, not ISR: an officer's draft preview must never be cached for everyone else.
export const dynamic = "force-dynamic";

type EventPageArgs = {
  params: Promise<{ slug: string }>;
};


export async function generateMetadata({
  params,
}: EventPageArgs): Promise<Metadata> {
  const { slug } = await params;

  let event;
  try {
    event = await getEventBySlug(slug);
  } catch {
    event = null;
  }

  if (!event || (!isEventPublic(event) && !(await isViewerOfficer()))) {
    return {
      title: "Event",
      alternates: { canonical: `/events/${slug}` },
    };
  }

  // Only the summary is public: the form calls `description` the internal description (#46)
  const description =
    event.summary?.slice(0, 155) ||
    `Details, registration, and results for ${event.title}, a Longhorn Sim Racing event.`;

  return {
    title: event.title,
    description,
    alternates: { canonical: `/events/${slug}` },
    openGraph: {
      title: event.title,
      description,
      type: "article",
      url: `/events/${slug}`,
    },
    twitter: {
      title: event.title,
      description,
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
      <div className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <DatabaseUnavailable title="Event Unavailable" />
        </div>
      </div>
    );
  }

  if (!event) {
    return notFound();
  }
  const isDraft = !isEventPublic(event);
  if (isDraft && !(await isViewerOfficer())) {
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

      // Group laps by participant, compute cumulative + individual lap times
      const participantLaps = new Map<
        string,
        { name: string; lapTimes: { lap: number; cumTime: number; lapTime: number }[] }
      >();

      for (const lap of laps) {
        const pid = lap.participantId;
        if (!participantLaps.has(pid)) {
          // The driver, not the car: in a one-make series every line would share the car's name
          const displayName = lap.participant.user?.displayName ?? lap.participant.displayName;
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
          lapTime: lap.lapTime,
        });
      }

      // Ensure driver names are unique (disambiguate duplicates with a suffix)
      const nameCounts = new Map<string, number>();
      for (const p of participantLaps.values()) {
        nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
      }
      const nameSeen = new Map<string, number>();
      for (const p of participantLaps.values()) {
        if ((nameCounts.get(p.name) ?? 0) > 1) {
          const n = (nameSeen.get(p.name) ?? 0) + 1;
          nameSeen.set(p.name, n);
          p.name = `${p.name} #${n}`;
        }
      }

      const maxLap = Math.max(
        ...Array.from(participantLaps.values()).map(
          (p) => p.lapTimes[p.lapTimes.length - 1]?.lap ?? 0
        )
      );
      const driverCount = participantLaps.size;

      // For each lap, rank drivers by cumulative time
      const chartData: LapPositionData[] = [];
      const lastPositionByDriver = new Map<string, number>();
      for (let lap = 1; lap <= maxLap; lap++) {
        const driversAtLap: { name: string; cumTime: number; lapTime: number }[] = [];
        for (const [, p] of participantLaps) {
          const lapEntry = p.lapTimes.find((l) => l.lap === lap);
          if (lapEntry) {
            driversAtLap.push({ name: p.name, cumTime: lapEntry.cumTime, lapTime: lapEntry.lapTime });
          }
        }
        driversAtLap.sort((a, b) => a.cumTime - b.cumTime);
        const point: LapPositionData = { lap };
        driversAtLap.forEach((d, idx) => {
          point[d.name] = idx + 1;
          point[`${d.name}__lapTime`] = d.lapTime;
          lastPositionByDriver.set(d.name, idx + 1);
        });
        chartData.push(point);
      }

      // Include all drivers (even those who DNF'd), ordered by last known position
      const drivers = Array.from(participantLaps.values())
        .map((p) => p.name)
        .sort(
          (a, b) =>
            (lastPositionByDriver.get(a) ?? Number.MAX_SAFE_INTEGER) -
            (lastPositionByDriver.get(b) ?? Number.MAX_SAFE_INTEGER)
        );

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
  const tz = event.timezone || DEFAULT_TIMEZONE;
  const ended = endsAt < new Date();
  const cancelled = event.status === "CANCELLED";
  const postponed = event.status === "POSTPONED";
  const round = roundOf(event.title, event.series);
  const dateLabel = startsAt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: tz });
  const timeLabel = timeRange(startsAt, endsAt, tz);

  const isCheckinRequired = event.attendanceEnabled && event.attendanceReportingMode === "CHECKIN_REQUIRED";
  const isPaidEvent = event.registrationFeeCents != null && event.registrationFeeCents > 0;
  const venue = event.venue;
  const online = /virtual|online/i.test(venue?.name ?? "") || (!venue && !!event.meetingUrl);
  const address = venue ? [venue.addressLine1, venue.city, venue.state].filter(Boolean).join(", ") : "";

  // The race's top three, for the podium above the full table
  const race = raceSessions.find((s) => s.sessionType === "RACE");
  const podium = race ? [...race.results].sort((a, b) => a.position - b.position).slice(0, 3) : [];

  const [album, upcoming] = await Promise.all([
    prisma.galleryAlbum
      .findFirst({
        where: { eventId: event.id, images: { some: {} } },
        select: { slug: true, title: true, images: { orderBy: { order: "asc" }, take: 4, select: { id: true, publicId: true, alt: true } } },
      })
      .catch(() => null),
    getSchedule(user?.id ?? null, { upcoming: { take: 3, exceptSlug: event.slug } }).catch((error) => {
      console.error("[EventPage] Failed to load upcoming events:", error);
      return [];
    }),
  ]);

  const statusMap: Record<string, string> = {
    CANCELLED: "https://schema.org/EventCancelled",
    POSTPONED: "https://schema.org/EventPostponed",
  };
  const attendanceMode =
    event.meetingUrl && venue
      ? "https://schema.org/MixedEventAttendanceMode"
      : event.meetingUrl
        ? "https://schema.org/OnlineEventAttendanceMode"
        : "https://schema.org/OfflineEventAttendanceMode";

  const eventJsonLd = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: event.title,
    description: event.summary || undefined,
    startDate: startsAt.toISOString(),
    endDate: endsAt.toISOString(),
    eventStatus: statusMap[event.status] ?? "https://schema.org/EventScheduled",
    eventAttendanceMode: attendanceMode,
    url: `https://www.longhornsimracing.org/events/${event.slug}`,
    image: event.heroImageUrl || undefined,
    location: venue
      ? {
          "@type": "Place",
          name: venue.name,
          address: {
            "@type": "PostalAddress",
            streetAddress: [venue.addressLine1, venue.addressLine2].filter(Boolean).join(", ") || undefined,
            addressLocality: venue.city || undefined,
            addressRegion: venue.state || undefined,
            postalCode: venue.postalCode || undefined,
            addressCountry: venue.country || undefined,
          },
        }
      : event.meetingUrl
        ? { "@type": "VirtualLocation", url: `https://www.longhornsimracing.org/events/${event.slug}` }
        : undefined,
    organizer: {
      "@type": "SportsOrganization",
      name: "Longhorn Sim Racing",
      url: CANONICAL_SITE_URL,
    },
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://www.longhornsimracing.org/" },
      { "@type": "ListItem", position: 2, name: "Events", item: "https://www.longhornsimracing.org/events" },
      { "@type": "ListItem", position: 3, name: event.title, item: `https://www.longhornsimracing.org/events/${event.slug}` },
    ],
  };
  const jsonLd = (data: object) => JSON.stringify(data).replace(/</g, "\\u003c");

  const tag = "inline-flex items-center gap-1.5 px-2 py-1 font-sans font-bold text-[10px] uppercase tracking-[0.15em]";
  const WhereIcon = online ? Monitor : MapPin;

  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(eventJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }} />

      {/* Hero */}
      <div className="relative overflow-hidden border-b border-white/10">
        <div className="absolute inset-0 z-0">
          {event.heroImageUrl ? (
            <Image src={event.heroImageUrl} alt="" fill preload sizes="100vw" className="object-cover opacity-60" />
          ) : (
            <CloudinaryImage
              publicId={event.series?.slug.includes("lone-star-cup") ? "gallery/lone-star-cup-season-2/lsc2nurb" : "gallery/wec-at-cota-2025/dsc09813"}
              alt=""
              fill
              preload
              sizes="100vw"
              className="object-cover opacity-45"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/60 via-lsr-charcoal/40 to-lsr-charcoal" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal/95 via-lsr-charcoal/65 to-transparent" />
        </div>
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />

        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 pt-10 pb-12 md:pt-14 md:pb-16 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)] lg:items-end lg:gap-12">
          <div>
            <Link href="/events" className="group inline-flex items-center gap-2 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/60 transition-colors hover:text-lsr-orange">
              <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-1" />
              Schedule
            </Link>

            {isDraft && (
              <div className="mt-6 border border-amber-500/30 bg-amber-500/10 px-4 py-3 font-sans text-xs text-amber-200">
                Draft: only officers can see this event. Edit it in{" "}
                <Link href={`/admin/events/${event.id}/edit`} className="underline hover:text-white">
                  Admin → Events
                </Link>
                .
              </div>
            )}

            <div className="mt-10 flex flex-wrap items-center gap-2">
              {event.series && <span className={`${tag} bg-white/10 text-white/80`}>{event.series.title}</span>}
              {isLive && !cancelled && (
                <span className={`${tag} bg-red-600 text-white`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" /> Live now
                </span>
              )}
              {cancelled && <span className={`${tag} bg-red-900/70 text-red-100`}>Cancelled</span>}
              {postponed && <span className={`${tag} bg-amber-900/60 text-amber-100`}>Postponed</span>}
              {round?.night && (
                <span className={`${tag} bg-white/10 text-white/80`}>
                  <Moon className="h-3 w-3" aria-hidden /> {round.note}
                </span>
              )}
              {round?.final && <span className={`${tag} bg-lsr-orange text-white`}>Finale</span>}
            </div>
            <h1 className={`mt-4 break-words font-display font-black italic text-5xl md:text-7xl uppercase leading-[0.9] ${cancelled ? "line-through decoration-white/40" : ""}`}>
              {round ? (
                <>
                  {round.name} <span className="text-lsr-orange">{round.track}</span>
                </>
              ) : (
                event.title
              )}
            </h1>
            <ul className="mt-6 flex flex-col gap-2 font-sans text-sm text-white/80 sm:flex-row sm:flex-wrap sm:gap-x-6">
              <li className="inline-flex items-center gap-2">
                <CalendarDays className="h-4 w-4 shrink-0 text-lsr-orange" aria-hidden />
                {dateLabel}
              </li>
              <li className="inline-flex items-center gap-2">
                <Clock className="h-4 w-4 shrink-0 text-lsr-orange" aria-hidden />
                {timeLabel}
              </li>
              {venue && (
                <li className="inline-flex items-center gap-2">
                  <WhereIcon className="h-4 w-4 shrink-0 text-lsr-orange" aria-hidden />
                  {venue.name}
                </li>
              )}
            </ul>
            {event.summary && <p className="mt-6 max-w-2xl font-sans text-base md:text-lg leading-relaxed text-white/80">{event.summary}</p>}
          </div>

          {/* Registration, or what's left to see once it's over */}
          <aside id="register" className="relative mt-10 scroll-mt-24 border border-white/15 bg-lsr-charcoal/85 p-6 backdrop-blur-sm md:p-7 lg:mt-0">
            <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
            {cancelled || postponed ? (
              <>
                <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">{cancelled ? "Cancelled" : "Postponed"}</p>
                <p className="mt-2 font-display font-black italic text-2xl uppercase leading-tight">{cancelled ? "This one’s off" : "New date to come"}</p>
                <p className="mt-3 font-sans text-sm leading-relaxed text-white/70">
                  {cancelled ? "This event won’t run. Catch the next one on the schedule." : "We’ll post the new date here and on Discord."}
                </p>
                <Link href="/events" className="group mt-5 inline-flex w-full items-center justify-between border border-white/15 px-4 py-3 font-sans text-xs font-bold uppercase tracking-[0.15em] text-white hover:border-lsr-orange">
                  <span className="inline-flex items-center gap-2">
                    <CalendarDays className="h-4 w-4 text-lsr-orange" aria-hidden /> What&apos;s next
                  </span>
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Link>
              </>
            ) : ended && !isLive ? (
              <>
                <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">Finished</p>
                <p className="mt-2 font-display font-black italic text-2xl uppercase leading-tight">This one&apos;s in the books</p>
                <div className="mt-5 flex flex-col gap-2">
                  {raceSessions.length > 0 && (
                    <a href="#results" className="group inline-flex items-center justify-between border border-white/15 px-4 py-3 font-sans text-xs font-bold uppercase tracking-[0.15em] text-white hover:border-lsr-orange">
                      <span className="inline-flex items-center gap-2">
                        <Trophy className="h-4 w-4 text-lsr-orange" aria-hidden /> Results
                      </span>
                      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                    </a>
                  )}
                  {album && (
                    <Link href={`/gallery?album=${encodeURIComponent(album.slug)}#albums`} className="group inline-flex items-center justify-between border border-white/15 px-4 py-3 font-sans text-xs font-bold uppercase tracking-[0.15em] text-white hover:border-lsr-orange">
                      <span className="inline-flex items-center gap-2">
                        <Images className="h-4 w-4 text-lsr-orange" aria-hidden /> Photos
                      </span>
                      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                    </Link>
                  )}
                  <Link href="/events" className="group inline-flex items-center justify-between border border-white/15 px-4 py-3 font-sans text-xs font-bold uppercase tracking-[0.15em] text-white hover:border-lsr-orange">
                    <span className="inline-flex items-center gap-2">
                      <CalendarDays className="h-4 w-4 text-lsr-orange" aria-hidden /> What&apos;s next
                    </span>
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </Link>
                </div>
                {/* Who came (members only, like before the event) */}
                {user && (
                  <div className="mt-6">
                    <EventRegistrationPanel eventSlug={slug} userLoggedIn attendeesOnly />
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">Sign up</p>
                {isPaidEvent && (
                  <p className="mt-2 inline-flex items-center gap-2 font-sans text-sm text-white/75">
                    <CreditCard className="h-4 w-4 text-lsr-orange" aria-hidden />
                    {formatCents(event.registrationFeeCents ?? 0)} to register
                  </p>
                )}
                {isCheckinRequired && (
                  <p className="mt-2 inline-flex items-start gap-2 font-sans text-sm text-white/75">
                    <QrCode className="mt-0.5 h-4 w-4 shrink-0 text-lsr-orange" aria-hidden />
                    Check in with the QR code at the event to count your attendance.
                  </p>
                )}
                <div className="mt-4">
                  <EventRegistrationPanel eventSlug={slug} userLoggedIn={!!user} />
                </div>
              </>
            )}
          </aside>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-12 md:py-16 space-y-16 md:space-y-20">
        {/* Live stream */}
        {isLive && event.streamUrl && (
          <section>
            <div className="mb-6 flex items-center gap-3">
              <span className={`${tag} bg-red-600 text-white`}>
                <span className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" /> Live
              </span>
              <h2 className="font-display font-black italic text-3xl uppercase">Watch now</h2>
            </div>
            <StreamPlayer streamUrl={event.streamUrl} />
          </section>
        )}

        {/* Details */}
        <section className="grid gap-4 md:grid-cols-2">
          <div className="relative border border-white/10 bg-white/[0.02] p-6 md:p-8">
            <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Where</p>
            {venue ? (
              <>
                <h2 className="mt-2 font-display font-black italic text-2xl uppercase leading-tight">{venue.name}</h2>
                {address && <p className="mt-1 font-sans text-sm text-white/60">{address}</p>}
                {venue.room && <p className="mt-1 font-sans text-sm text-white/60">{venue.room}</p>}
                {online && <p className="mt-3 font-sans text-sm text-white/65">Online event: race from your own setup. Details are shared on Discord.</p>}
                {!online && (
                  <div className="mt-4">
                    <VenueActions venue={venue} />
                  </div>
                )}
              </>
            ) : (
              <p className="mt-2 font-sans text-sm text-white/65">Location details go out on Discord.</p>
            )}
          </div>
          <div className="relative border border-white/10 bg-white/[0.02] p-6 md:p-8">
            <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Good to know</p>
            <ul className="mt-3 space-y-3 font-sans text-sm leading-relaxed text-white/70">
              {!online && venue && (
                <li>
                  Need a ride? Most in-person events have carpools; ask in the{" "}
                  <a href="https://discord.gg/5Uv9YwpnFz" target="_blank" rel="noopener noreferrer" className="font-bold text-white hover:text-lsr-orange">
                    Discord
                  </a>
                  .
                </li>
              )}
              {isPaidEvent && (
                <li>
                  Payment issues or refunds:{" "}
                  <a href="mailto:info@longhornsimracing.org" className="font-bold text-white hover:text-lsr-orange">
                    info@longhornsimracing.org
                  </a>
                </li>
              )}
              <li>
                Questions? Email{" "}
                <a href="mailto:info@longhornsimracing.org" className="font-bold text-white hover:text-lsr-orange">
                  info@longhornsimracing.org
                </a>{" "}
                or ask on Discord.
              </li>
            </ul>
          </div>
        </section>

        {/* Results */}
        {raceSessions.length > 0 && (
          <section id="results" className="scroll-mt-24">
            <div className="mb-8 md:mb-10">
              <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-3">Official results</p>
              <h2 className="font-display font-black italic text-4xl md:text-5xl uppercase leading-[0.95]">
                How it <span className="text-lsr-orange">finished</span>
              </h2>
            </div>

            {podium.length > 0 && (
              <ol className="mb-8 grid gap-3 sm:grid-cols-3">
                {podium.map((result, i) => {
                  const driver = result.participant.user;
                  const name = driver?.displayName || result.participant.displayName;
                  const body = (
                    <>
                      <div className={`absolute top-0 left-0 h-1 ${i === 0 ? "w-full" : "w-16"} bg-lsr-orange`} />
                      <span className={`font-display font-black italic text-4xl leading-none ${i === 0 ? "text-lsr-orange" : "text-white/70"}`}>P{i + 1}</span>
                      <span className="relative h-12 w-12 shrink-0 overflow-hidden border border-white/10 bg-black">
                        {driver?.avatarUrl ? (
                          <Image src={driver.avatarUrl} alt="" fill sizes="48px" className="object-cover" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center font-display font-black italic text-white/30">{initials(name)}</span>
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-sans font-bold text-sm uppercase tracking-tight text-white">{name}</span>
                        <span className="block font-sans text-xs text-white/55">{result.points ?? 0} pts</span>
                      </span>
                    </>
                  );
                  return (
                    <li key={result.id}>
                      {driver?.handle ? (
                        <Link href={`/drivers/${driver.handle}`} className="relative flex items-center gap-4 border border-white/10 bg-white/[0.02] p-4 transition-colors hover:border-lsr-orange/60">
                          {body}
                        </Link>
                      ) : (
                        <div className="relative flex items-center gap-4 border border-white/10 bg-white/[0.02] p-4">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="space-y-8">
              {raceSessions.map((session) => {
                const typeLabel = session.sessionType === "QUALIFYING" ? "Qualifying" : session.sessionType === "PRACTICE" ? "Practice" : "Race";
                const isRace = session.sessionType === "RACE";
                const lapPositions = isRace ? lapDataBySession.get(session.id) : undefined;
                return (
                  <div key={session.id}>
                    <ResultsTable
                      results={session.results}
                      title={`${typeLabel} Results${session.trackName ? ` - ${session.trackName}` : ""}`}
                      showPoints={isRace}
                      sessionType={session.sessionType}
                      positionsGained={isRace ? positionsGainedBySession.get(session.id) : undefined}
                    />
                    {lapPositions && <LapPositionChart data={lapPositions.data} drivers={lapPositions.drivers} driverCount={lapPositions.driverCount} />}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Photos */}
        {album && (
          <section>
            <div className="mb-8 flex flex-col justify-between gap-3 md:flex-row md:items-end">
              <div>
                <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-3">From the gallery</p>
                <h2 className="font-display font-black italic text-4xl md:text-5xl uppercase leading-[0.95]">
                  The <span className="text-lsr-orange">photos</span>
                </h2>
              </div>
              <Link href={`/gallery?album=${encodeURIComponent(album.slug)}#albums`} className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-lsr-orange">
                See the album <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
              {album.images.map((image) => (
                <Link key={image.id} href={`/gallery?album=${encodeURIComponent(album.slug)}#albums`} className="group relative aspect-[4/3] overflow-hidden border border-white/10 bg-black">
                  <CloudinaryImage
                    publicId={image.publicId}
                    alt={image.alt ?? ""}
                    fill
                    sizes="(min-width: 1152px) 280px, (min-width: 768px) 25vw, 50vw"
                    className="object-cover opacity-85 transition-all duration-700 group-hover:scale-105 group-hover:opacity-100"
                  />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* What's next */}
        {upcoming.length > 0 && (
          <section>
            <div className="mb-8 flex flex-col justify-between gap-3 md:flex-row md:items-end">
              <div>
                <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-3">On the calendar</p>
                <h2 className="font-display font-black italic text-4xl md:text-5xl uppercase leading-[0.95]">
                  Coming <span className="text-lsr-orange">up</span>
                </h2>
              </div>
              <Link href="/events" className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-lsr-orange">
                Full schedule <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
            <ul className="space-y-2">
              {upcoming.map((e) => (
                <AgendaRow key={e.slug} event={e} titleAs="h3" />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
