import Image from "next/image";
import Link from "next/link";
import { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { ArrowDown, ArrowRight, Flag, Pencil, Trophy, UserPlus, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CloudinaryImage } from "@/components/cloudinary-image";
import { DatabaseUnavailable } from "@/components/database-unavailable";
import { EventPhotoBand } from "@/components/event-photo-band";
import { RacingNumber } from "@/components/racing-number";
import { StatusIcons } from "@/components/status-indicators";
import { getStatusIndicators } from "@/lib/status-indicators";
import { parseRoundTitle } from "@/lib/rounds";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { getRoster, type Roster as RosterData, type RosterDriver } from "@/server/queries/roster";
import { Roster } from "./roster";
import { initials } from "./initials";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Driver Roster",
  description: "Official entry list and driver profiles for Longhorn Sim Racing.",
  alternates: {
    canonical: "/drivers",
  },
};

const STANDINGS_NOTE =
  "All-time points add up every season with uploaded results. Results count once a driver's sim name is linked to their account; if yours is missing, email info@longhornsimracing.org.";

const ghostButton =
  "h-12 rounded-none border border-white/20 bg-lsr-charcoal/40 px-5 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal";
const primaryButton =
  "h-12 rounded-none bg-lsr-orange px-7 font-sans text-xs font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal";

const RACE_PHOTO_SIZES = "(min-width: 1152px) 560px, (min-width: 768px) 50vw, 100vw";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function SectionHeading({ kicker, children, id, aside }: { kicker: string; children: React.ReactNode; id?: string; aside?: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-24 mb-10 md:mb-12 flex flex-col md:flex-row md:items-end justify-between gap-4">
      <div>
        <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-3">{kicker}</p>
        <h2 className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal leading-[0.95]">
          {children}
        </h2>
      </div>
      {aside}
    </div>
  );
}

function Avatar({ driver, size, className }: { driver: Pick<RosterDriver, "avatarUrl" | "displayName">; size: number; className?: string }) {
  return (
    <div className={`relative shrink-0 overflow-hidden border border-white/10 bg-black ${className ?? ""}`} style={{ width: size, height: size }}>
      {driver.avatarUrl ? (
        <Image src={driver.avatarUrl} alt="" fill sizes={`${size}px`} className="object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-display font-black italic text-white/25" style={{ fontSize: size / 3 }}>
          {initials(driver.displayName)}
        </span>
      )}
    </div>
  );
}

function TitleChips({ titles }: { titles: string[] }) {
  if (titles.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {titles.map((title) => (
        <span
          key={title}
          className="inline-flex items-center gap-1 bg-lsr-orange/15 px-1.5 py-0.5 font-sans font-bold text-[9px] uppercase tracking-[0.15em] text-lsr-orange"
        >
          <Trophy className="h-2.5 w-2.5" aria-hidden />
          {title} champ
        </span>
      ))}
    </span>
  );
}

/** "Sat, Oct 10 · 10:00 AM CT" in the event's own time zone */
function raceTime(date: Date, timeZone: string) {
  // "CT" rather than CDT/CST, which flips mid-season when daylight saving ends
  const zone =
    timeZone === "America/Chicago"
      ? "CT"
      : (new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "");
  const day = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  return `${day} · ${time} ${zone}`.trim();
}

/** "Lights out in 3 days" */
function countdown(start: Date, now: Date) {
  const hours = (start.getTime() - now.getTime()) / 3_600_000;
  if (hours < 1) return "Lights out within the hour";
  if (hours < 24) return `Lights out in ${plural(Math.round(hours), "hour")}`;
  return `Lights out in ${plural(Math.round(hours / 24), "day")}`;
}

/** A round's name and track for Lone Star Cup events, otherwise the event's own title */
function raceHeading(event: { title: string; series: { slug: string } | null }) {
  if (!event.series?.slug.includes("lone-star-cup")) return { name: event.title, track: null };
  const round = parseRoundTitle(event.title, 0);
  return { name: round.name, track: round.track };
}

function PodiumCard({ driver, place }: { driver: RosterDriver; place: number }) {
  const first = place === 1;
  return (
    <Link
      href={`/drivers/${driver.handle}`}
      className={`group relative block overflow-hidden border bg-white/[0.02] p-6 transition-colors hover:border-lsr-orange/70 md:p-7 ${
        first ? "border-lsr-orange/40 md:order-2 md:pb-10 md:pt-10" : place === 2 ? "border-white/10 md:order-1" : "border-white/10 md:order-3"
      }`}
    >
      <div className={`absolute top-0 left-0 h-1 ${first ? "w-full" : "w-24"} bg-lsr-orange`} />
      <span
        aria-hidden
        className="pointer-events-none absolute -right-3 -top-8 font-display font-black italic text-[10rem] leading-none text-white/[0.04] select-none"
      >
        {place}
      </span>
      <div className="relative flex items-center gap-4">
        <Avatar driver={driver} size={first ? 88 : 72} className="transition-colors group-hover:border-lsr-orange" />
        <div className="min-w-0">
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">
            P{place}
            {first ? " · All-time leader" : ""}
          </p>
          <p className="mt-1 font-display font-black italic text-2xl md:text-[1.7rem] uppercase leading-none text-white break-words">
            {driver.displayName}
          </p>
          <p className="mt-1 truncate font-sans text-[11px] text-white/40">@{driver.handle}</p>
        </div>
      </div>
      <div className="relative mt-3 min-h-5">
        <TitleChips titles={driver.titles} />
      </div>
      <div className="relative mt-4 flex items-end justify-between gap-4">
        <p className="font-display font-black italic leading-none text-white">
          <span className={first ? "text-6xl" : "text-5xl"}>{driver.points}</span>
          <span className="ml-1.5 font-sans not-italic font-bold text-[10px] uppercase tracking-[0.2em] text-white/50">pts</span>
        </p>
        <RacingNumber user={driver} size="md" />
      </div>
      <dl className="relative mt-5 grid grid-cols-4 gap-2 border-t border-white/10 pt-4">
        {[
          ["Seasons", driver.seasons],
          ["Starts", driver.starts],
          ["Wins", driver.wins],
          ["Podiums", driver.podiums],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="font-sans font-bold text-[9px] uppercase tracking-[0.2em] text-white/40">{label}</dt>
            <dd className="mt-1 font-display font-bold italic text-xl text-white">{value}</dd>
          </div>
        ))}
      </dl>
    </Link>
  );
}

function StandingsRows({ drivers }: { drivers: RosterDriver[] }) {
  const th = "px-2 md:px-3 py-3.5 font-sans font-bold text-[9px] uppercase tracking-[0.2em] text-white/40";
  const stat = "hidden md:table-cell px-3 py-3 text-center font-display font-bold italic text-lg text-white/80";
  return (
    <div className="overflow-x-auto border border-white/10">
      <table className="w-full text-sm">
        <thead className="border-b border-white/10 bg-white/[0.04]">
          <tr>
            <th scope="col" className={`${th} w-10 md:w-14 text-center`}>Pos</th>
            <th scope="col" className={`${th} text-left`}>Driver</th>
            <th scope="col" className={`${th} hidden md:table-cell text-center`}>Seasons</th>
            <th scope="col" className={`${th} hidden md:table-cell text-center`}>Starts</th>
            <th scope="col" className={`${th} hidden md:table-cell text-center`}>Wins</th>
            <th scope="col" className={`${th} hidden md:table-cell text-center`}>Podiums</th>
            <th scope="col" className={`${th} hidden md:table-cell text-center`}>Best</th>
            <th scope="col" className={`${th} w-14 md:w-20 text-right pr-4 md:pr-5`}>Pts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {drivers.map((driver) => {
            const indicators = getStatusIndicators({
              roles: driver.roles,
              activeTierKey: driver.tierKey,
              officerTitle: driver.officerTitle,
            });
            return (
              <tr key={driver.id} className="group transition-colors hover:bg-white/[0.03]">
                <td className="px-2 md:px-3 py-3 text-center font-display font-black italic text-xl text-white/30">{driver.rank}</td>
                <td className="px-2 md:px-3 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar driver={driver} size={40} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Link
                          href={`/drivers/${driver.handle}`}
                          className="font-sans font-bold uppercase tracking-tight text-white transition-colors hover:text-lsr-orange"
                        >
                          {driver.displayName}
                        </Link>
                        <TitleChips titles={driver.titles} />
                        <StatusIcons indicators={indicators} />
                      </div>
                      <p className="mt-0.5 font-sans text-[11px] text-white/40">@{driver.handle}</p>
                      <p className="mt-0.5 font-sans text-[11px] text-white/55 md:hidden">
                        {plural(driver.starts, "start")}
                        {driver.wins > 0 ? ` · ${plural(driver.wins, "win")}` : ""}
                      </p>
                    </div>
                  </div>
                </td>
                <td className={stat}>{driver.seasons}</td>
                <td className={stat}>{driver.starts}</td>
                <td className={stat}>{driver.wins || <span className="text-white/20">—</span>}</td>
                <td className={stat}>{driver.podiums || <span className="text-white/20">—</span>}</td>
                <td className={stat}>{driver.bestFinish ? `P${driver.bestFinish}` : <span className="text-white/20">—</span>}</td>
                <td className="px-2 md:px-3 py-3 pr-4 md:pr-5 text-right font-display font-black italic text-2xl text-white">{driver.points}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LatestResultCard({ event }: { event: RosterData["latestResult"] }) {
  if (!event) {
    return (
      <div className="relative border border-white/10 bg-white/[0.02] p-6 md:p-8">
        <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
        <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">Latest result</p>
        <p className="mt-3 font-sans text-sm text-white/55">Results show up here once the first race is uploaded.</p>
      </div>
    );
  }
  const heading = raceHeading(event);
  const podium = event.ingestedSessions[0]?.results ?? [];
  const date = event.startsAtUtc.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: event.timezone || DEFAULT_TIMEZONE,
  });
  return (
    <div className="group relative flex flex-col overflow-hidden border border-white/10 bg-white/[0.02] p-6 md:p-8">
      <div className="absolute top-0 left-0 z-10 h-1 w-24 bg-lsr-orange" />
      <EventPhotoBand src={event.heroImageUrl} sizes={RACE_PHOTO_SIZES} />
      <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">
        Latest result · {date}
      </p>
      <h3 className="mt-3 font-display font-black italic text-3xl uppercase leading-none text-white">
        {heading.name} {heading.track && <span className="text-lsr-orange">{heading.track}</span>}
      </h3>
      {event.series && <p className="mt-2 font-sans text-xs text-white/45">{event.series.title}</p>}
      <ol className="mt-6 space-y-2">
        {podium.map((result, i) => {
          const user = result.participant.user;
          const name = user?.displayName || result.participant.displayName;
          return (
            <li key={result.id} className="flex items-center gap-3 border border-white/5 bg-black/20 px-3 py-2">
              <span className={`w-6 font-display font-black italic text-xl ${i === 0 ? "text-lsr-orange" : "text-white/40"}`}>{i + 1}</span>
              <Avatar driver={{ avatarUrl: user?.avatarUrl ?? null, displayName: name }} size={32} />
              {user ? (
                <Link href={`/drivers/${user.handle}`} className="min-w-0 flex-1 truncate font-sans font-bold text-xs uppercase tracking-tight text-white hover:text-lsr-orange">
                  {name}
                </Link>
              ) : (
                <span className="min-w-0 flex-1 truncate font-sans font-bold text-xs uppercase tracking-tight text-white/80">{name}</span>
              )}
              <span className="shrink-0 font-sans font-bold text-[10px] uppercase tracking-[0.15em] text-white/50">
                {result.points ?? 0} pts
              </span>
            </li>
          );
        })}
      </ol>
      <Link
        href={`/events/${event.slug}`}
        className="group mt-6 inline-flex items-center gap-2 self-start font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white hover:text-lsr-orange"
      >
        Full results <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
      </Link>
    </div>
  );
}

function NextRaceCard({ event }: { event: RosterData["nextRace"] }) {
  const heading = event ? raceHeading(event) : null;
  return (
    <div className="group relative flex flex-col overflow-hidden border border-white/10 bg-white/[0.02] p-6 md:p-8">
      <div className="absolute top-0 left-0 z-10 h-1 w-24 bg-lsr-orange" />
      <Flag aria-hidden className="pointer-events-none absolute -bottom-6 -right-6 h-40 w-40 -rotate-12 text-white/[0.03]" />
      <EventPhotoBand src={event?.heroImageUrl ?? null} sizes={RACE_PHOTO_SIZES} />
      <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">Next race</p>
      {event && heading ? (
        <>
          <h3 className="mt-3 font-display font-black italic text-3xl uppercase leading-none text-white">
            {heading.name} {heading.track && <span className="text-lsr-orange">{heading.track}</span>}
          </h3>
          {event.series && <p className="mt-2 font-sans text-xs text-white/45">{event.series.title}</p>}
          <p className="mt-6 font-display font-bold italic text-2xl uppercase text-white">
            {raceTime(event.startsAtUtc, event.timezone || DEFAULT_TIMEZONE)}
          </p>
          <p className="mt-2 inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange">
            <span className="h-1.5 w-1.5 rounded-full bg-lsr-orange animate-pulse" />
            {countdown(event.startsAtUtc, new Date())}
          </p>
          <div className="mt-auto flex flex-wrap gap-x-6 gap-y-3 pt-8">
            <Link href={`/events/${event.slug}`} className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white hover:text-lsr-orange">
              Event details <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
            </Link>
            <Link href="/lone-star-cup" className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/60 hover:text-lsr-orange">
              Lone Star Cup <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="mt-3 font-sans text-sm text-white/55">
            The next Lone Star Cup round shows up here once it&apos;s on the calendar.
          </p>
          <Link href="/lone-star-cup" className="group mt-6 inline-flex items-center gap-2 self-start font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white hover:text-lsr-orange">
            Lone Star Cup <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
          </Link>
        </>
      )}
    </div>
  );
}

export default async function DriversIndexPage() {
  let data: RosterData;
  let session: Awaited<ReturnType<typeof getCachedSessionUser>>;
  try {
    [data, session] = await Promise.all([getRoster(), getCachedSessionUser()]);
  } catch (error) {
    unstable_rethrow(error);
    console.error("[Drivers] Failed to load drivers:", error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <h1 className="mb-10 font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9]">
            Driver <span className="text-lsr-orange">Roster</span>
          </h1>
          <DatabaseUnavailable title="Roster Unavailable" />
        </div>
      </main>
    );
  }

  const { drivers, latestResult, nextRace, scoredRaces } = data;
  const viewer = session.user;
  const scorers = drivers.filter((driver) => driver.rank !== null);
  const podium = scorers.slice(0, 3);
  const winners = drivers.filter((driver) => driver.wins > 0).length;

  const stats = [
    { value: drivers.length, label: "Drivers on the roster" },
    { value: scorers.length, label: "Have scored points" },
    { value: scoredRaces, label: scoredRaces === 1 ? "Race with results" : "Races with results" },
    { value: winners, label: winners === 1 ? "Race winner" : "Different race winners" },
  ];

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Longhorn Sim Racing Driver Roster",
    numberOfItems: drivers.length,
    itemListElement: drivers.map((driver, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `https://www.longhornsimracing.org/drivers/${driver.handle}`,
      name: driver.displayName,
    })),
  };

  const profileCta = viewer ? (
    <Button asChild className={primaryButton}>
      <Link href={`/drivers/${viewer.handle}`}>
        <UserRound className="mr-2 h-4 w-4" />
        Your profile
      </Link>
    </Button>
  ) : (
    <Button asChild className={primaryButton}>
      <Link href="/auth/signin?next=/drivers">
        <UserPlus className="mr-2 h-4 w-4" />
        Join the roster
      </Link>
    </Button>
  );

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd).replace(/</g, "\\u003c") }}
      />

      {/* Hero */}
      <div className="relative border-b border-white/10 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <CloudinaryImage
            publicId="gallery/lsr-x-wcsr/img-0168"
            alt=""
            fill
            sizes="100vw"
            preload
            className="object-cover object-[center_40%] opacity-70"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/70 via-lsr-charcoal/30 to-lsr-charcoal" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal/95 via-lsr-charcoal/60 to-transparent" />
        </div>
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />
        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 pt-20 pb-14 md:pt-28 md:pb-20">
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-5">Driver roster</p>
          <h1 className="font-display font-black italic text-6xl md:text-8xl text-white uppercase tracking-normal leading-[0.9]">
            Meet the <span className="text-lsr-orange">grid</span>
          </h1>
          <p className="mt-7 max-w-xl font-sans text-base md:text-xl font-bold text-white/85 leading-relaxed">
            Every Longhorn Sim Racing driver, from first laps to championship winners. Find a teammate, scout a rival, or put
            yourself on the list.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            {profileCta}
            <Button asChild className={ghostButton}>
              <a href="#standings">
                <Trophy className="mr-2 h-3.5 w-3.5" />
                <span className="sm:hidden">Standings</span>
                <span className="hidden sm:inline">All-time standings</span>
              </a>
            </Button>
            <Button asChild className={ghostButton}>
              <a href="#roster">
                <ArrowDown className="mr-2 h-3.5 w-3.5" />
                Find a driver
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Stats */}
      <section aria-label="Roster in numbers" className="border-b border-white/10 bg-black/25">
        <dl className="mx-auto grid max-w-6xl grid-cols-2 md:grid-cols-4">
          {stats.map((stat, i) => (
            <div
              key={stat.label}
              className={`flex flex-col-reverse px-6 py-6 md:px-8 md:py-8 ${i % 2 === 1 ? "border-l border-white/10" : ""} ${i >= 2 ? "border-t border-white/10 md:border-t-0" : ""} ${i === 2 ? "md:border-l" : ""}`}
            >
              <dt className="mt-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">{stat.label}</dt>
              <dd className="font-display font-black italic text-4xl md:text-5xl leading-none text-white">{stat.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-16 md:py-24 space-y-24 md:space-y-32">
        {/* Latest and next */}
        <section aria-label="Latest result and next race" className="grid gap-4 md:gap-6 md:grid-cols-2">
          <LatestResultCard event={latestResult} />
          <NextRaceCard event={nextRace} />
        </section>

        {/* All-time standings */}
        <section>
          <SectionHeading kicker="Every season, every point" id="standings">
            All-time <span className="text-lsr-orange">standings</span>
          </SectionHeading>
          {scorers.length === 0 ? (
            <p className="border border-white/10 bg-white/[0.02] p-8 text-center font-sans text-sm text-white/55">
              Points show up here once race results are uploaded.
            </p>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-3 md:items-end md:gap-5">
                {podium.map((driver, i) => (
                  <PodiumCard key={driver.id} driver={driver} place={i + 1} />
                ))}
              </div>
              {scorers.length > 3 && (
                <div className="mt-6">
                  <StandingsRows drivers={scorers.slice(3)} />
                </div>
              )}
              <p className="mt-4 max-w-3xl font-sans text-[11px] leading-relaxed text-white/40">{STANDINGS_NOTE}</p>
            </>
          )}
        </section>

        {/* Directory */}
        <section>
          <SectionHeading kicker={`${plural(drivers.length, "driver")} and counting`} id="roster">
            The <span className="text-lsr-orange">roster</span>
          </SectionHeading>
          <Roster drivers={drivers} />
        </section>
      </div>

      {/* Closing CTA */}
      <section className="relative overflow-hidden border-t border-white/10">
        <div className="absolute inset-0 z-0">
          <CloudinaryImage
            publicId="gallery/cota-track-day/image-3"
            alt=""
            fill
            sizes="100vw"
            className="object-cover object-[center_60%] opacity-55"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal via-lsr-charcoal/80 to-lsr-charcoal/30" />
        </div>
        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 py-20 md:py-28">
          <div className="max-w-xl">
            <h2 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9]">
              {viewer ? (
                <>
                  Make it <span className="text-lsr-orange">yours</span>
                </>
              ) : (
                <>
                  Get on the <span className="text-lsr-orange">roster</span>
                </>
              )}
            </h2>
            <p className="mt-5 font-sans text-base md:text-lg text-white/70 leading-relaxed">
              {viewer
                ? "Add a photo, pick your car number and write a bio. Every result you score lands on your profile."
                : "Make an account and you get your own driver page: a photo, your car number, and every result you score. No experience needed."}
            </p>
            <div className="mt-8 flex flex-col sm:flex-row sm:items-start gap-4">
              {viewer ? (
                <Button asChild className={primaryButton}>
                  <Link href={`/drivers/${viewer.handle}/edit`}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit your profile
                  </Link>
                </Button>
              ) : (
                profileCta
              )}
              <Button asChild className={ghostButton}>
                <Link href="/lone-star-cup">
                  <Flag className="mr-2 h-3.5 w-3.5" />
                  Race the Lone Star Cup
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
