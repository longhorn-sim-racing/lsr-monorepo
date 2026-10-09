import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Metadata } from "next";
import { ArrowRight, ArrowUpRight, BookOpen, CalendarDays, Check, Flag, MessageSquare, Moon, ScrollText, Trophy } from "lucide-react";
import { siTwitch } from "simple-icons/icons";
import { BrandIcon } from "@/components/brand-icon";
import { getStandings, getPointsProgression } from "@/server/queries/standings";
import { StandingsTable } from "@/components/standings-table";
import { prisma } from "@/server/db";
import { DatabaseUnavailable } from "@/components/database-unavailable";
import { ChampionshipChart } from "@/components/championship-chart";
import { CloudinaryImage } from "@/components/cloudinary-image";
import { EventPhotoBand } from "@/components/event-photo-band";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { getActiveEntitlements } from "@/server/repos/membership.repo";
import { priceForUser, productRequiresMembership } from "@/server/services/product-pricing";
import { getLeagueApplication, getOpenLeagueSeason } from "@/server/services/league-entry.service";
import { LSC_RULES_SLUG } from "@/lib/page-slugs";
import { ProductPaymentToast } from "@/components/product-checkout-button";
import { Button } from "@/components/ui/button";
import { publicUserSelect } from "@/lib/public-user";
import { publicEventWhere } from "@/lib/events";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { parseRoundTitle } from "@/lib/rounds";
import { seasonLabel, seasonTerm } from "@/lib/seasons";
import { OFFICERS } from "@/app/about/roster";
import { EntryCta, type EntryState } from "./entry-cta";
import { LiveStream } from "./live-stream";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lone Star Cup",
  description: "The official championship series of Longhorn Sim Racing. Join our welcoming and competitive racing community.",
  alternates: {
    canonical: "/lone-star-cup",
  },
};

const LEAGUE_SLUG = "lone-star-cup";
const DISCORD_URL = "https://discord.gg/5Uv9YwpnFz";
const STANDINGS_NOTE =
  "Only users with accounts can be shown on the standings page. Accounts must be manually linked to Assetto Corsa display names. If you are not listed, please create an account and email info@longhornsimracing.org to be added.";

// Season-specific details, keyed by season slug.
const SEASON_DETAILS: Record<string, { car: string; blurb: string }> = {
  "lone-star-cup-s3": {
    car: "Mustang GT4",
    blurb:
      "Season 3 runs ten rounds on Saturdays at 10am, September 19 through November 21, in the Mustang GT4. Round 7 is a Halloween night race at Mount Panorama. Your entry fee covers both the Lone Star Cup and the Formula Sunday League.",
  },
};

// Titles come from the About page roster so the two pages never disagree
const officerTitle = (name: string) => OFFICERS.find((officer) => officer.name === name)?.title ?? "Series Director";

const DIRECTORS = [
  {
    name: "Bryan Reyes",
    title: officerTitle("Bryan Reyes"),
    photo: "/images/bryan.jpg",
    blurb:
      "Ever since I was little, I’ve been fascinated with racing. I still remember watching Cars for the first time and instantly wanting to be Lightning McQueen. After gaining 5 years of sim racing experience, I have found that I enjoy coaching and teaching others about racing as much as being on the track.",
  },
  {
    name: "Armando Martinez",
    title: officerTitle("Armando Martinez"),
    photo: "/images/armando.jpg",
    blurb:
      "I've spent most of my life racing on a controller and in all honesty am probably better on the controller than on a wheel. Recently getting a wheel has been amazing since the immersion of sim-racing is important. My goal is to teach people about racing and its tricky parts.",
  },
];

/** A season's rounds, each with its race's top three. */
async function getSeriesWithPodiums(slug: string) {
  return prisma.eventSeries.findUnique({
    where: { slug },
    include: {
      events: {
        where: publicEventWhere(),
        orderBy: { startsAtUtc: "asc" },
        include: {
          ingestedSessions: {
            where: { sessionType: "RACE" },
            take: 1, // the main race
            orderBy: { startedAt: "desc" },
            include: {
              results: {
                orderBy: { position: "asc" },
                take: 3,
                include: { participant: { include: { user: { select: publicUserSelect } } } },
              },
            },
          },
        },
      },
    },
  });
}

type SeriesWithPodiums = NonNullable<Awaited<ReturnType<typeof getSeriesWithPodiums>>>;
type RoundEvent = SeriesWithPodiums["events"][number];
type Standing = Awaited<ReturnType<typeof getStandings>>[number];

/**
 * The Twitch channel in a round's stream URL, or LSR's (where LSC races usually stream) when it
 * isn't a twitch.tv/<channel> link.
 */
function twitchChannel(streamUrl: string | null) {
  try {
    const url = new URL(streamUrl ?? "");
    const channel = url.pathname.split("/")[1] ?? "";
    if (["twitch.tv", "www.twitch.tv", "m.twitch.tv"].includes(url.hostname) && /^[a-z0-9_]{3,25}$/i.test(channel) && channel !== "videos") {
      return channel;
    }
  } catch {}
  return "longhorn_sim_racing";
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;



const podiumOf = (event: RoundEvent) => event.ingestedSessions[0]?.results ?? [];

function driverName(result: ReturnType<typeof podiumOf>[number] | undefined) {
  return result?.participant?.user?.displayName || result?.participant?.displayName || "TBD";
}

function roundDate(date: Date, timeZone: string) {
  // "CT" rather than CDT/CST, which flips mid-season when daylight saving ends
  const zone =
    timeZone === "America/Chicago"
      ? "CT"
      : (new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "");
  return {
    day: date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone }),
    time: `${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })} ${zone}`.trim(),
  };
}

async function loadLoneStarCup() {
  const [session, league] = await Promise.all([
    getCachedSessionUser(),
    prisma.league.findUnique({ where: { slug: LEAGUE_SLUG }, select: { id: true } }),
  ]);
  // The newest season is current; the rest make up the archive.
  const seasons = league
    ? await prisma.season.findMany({
        where: { leagueId: league.id, visibility: "public", seriesId: { not: null } },
        include: { series: { select: { slug: true } } },
        orderBy: [{ startAt: { sort: "desc", nulls: "last" } }, { year: "desc" }],
      })
    : [];
  const [currentSeason, ...pastSeasons] = seasons;

  const [currentSeries, currentStandings, currentProgression, archive, entryProduct, openSeason, entitlements] =
    await Promise.all([
      currentSeason ? getSeriesWithPodiums(currentSeason.series!.slug) : null,
      currentSeason ? getStandings(currentSeason.series!.slug) : [],
      currentSeason ? getPointsProgression(currentSeason.slug) : null,
      Promise.all(
        pastSeasons.map(async (s) => ({
          id: s.id,
          label: seasonLabel(s.name),
          term: seasonTerm(s.startAt),
          series: await getSeriesWithPodiums(s.series!.slug),
          standings: await getStandings(s.series!.slug),
        })),
      ),
      prisma.product.findFirst({ where: { type: "LEAGUE_FEE", league: { slug: LEAGUE_SLUG }, active: true } }),
      league ? getOpenLeagueSeason(league.id) : null,
      session.user ? getActiveEntitlements(session.user.id) : [],
    ]);

  // Returning drivers (in a past season's standings) see their lower rate.
  const viewerIsOfficer = session.roles.some((role) => role === "officer" || role === "admin");
  const [entryPrice, application, rulesPage] = await Promise.all([
    entryProduct ? priceForUser(entryProduct, session.user?.id ?? null) : null,
    session.user && openSeason ? getLeagueApplication(session.user.id, openSeason.id) : null,
    prisma.page.findUnique({ where: { slug: LSC_RULES_SLUG }, select: { id: true, visibility: true } }),
  ]);

  return {
    session,
    league,
    currentSeason,
    currentSeries,
    currentStandings,
    currentProgression,
    archivedSeasons: archive.filter((s) => s.series && s.series.events.length > 0),
    entryProduct,
    entryPrice,
    openSeason,
    entitlements,
    application,
    rulesPublished: rulesPage?.visibility === "public",
    // An officer sees a nudge to publish the rules while they're still a draft
    rulesDraftId: rulesPage && rulesPage.visibility !== "public" && viewerIsOfficer ? rulesPage.id : null,
  };
}

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

function Podium({ results, size = "sm" }: { results: ReturnType<typeof podiumOf>; size?: "sm" | "lg" }) {
  return (
    <ol className={size === "lg" ? "space-y-2.5" : "space-y-1.5"}>
      {[1, 2, 3].map((position) => {
        const result = results.find((r) => r.position === position);
        return (
          <li key={position} className="flex items-center gap-3">
            <span
              className={`font-display font-black italic leading-none ${size === "lg" ? "w-8 text-2xl" : "w-5 text-sm"} ${
                position === 1 ? "text-lsr-orange" : "text-white/35"
              }`}
            >
              P{position}
            </span>
            <span className={`truncate font-sans ${size === "lg" ? "text-base" : "text-xs"} ${position === 1 ? "font-bold text-white" : "text-white/70"}`}>
              {driverName(result)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function LeaderCard({ standing, place }: { standing: Standing; place: number }) {
  return (
    <div className={`relative border p-5 md:p-6 ${place === 1 ? "border-lsr-orange/60 bg-lsr-orange/[0.07]" : "border-white/10 bg-white/[0.02]"}`}>
      {place === 1 && <div className="absolute top-0 left-0 h-1 w-full bg-lsr-orange" />}
      <div className="flex items-baseline justify-between gap-3">
        <span className={`font-display font-black italic text-4xl leading-none ${place === 1 ? "text-lsr-orange" : "text-white/30"}`}>P{place}</span>
        <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">
          {standing.wins} {standing.wins === 1 ? "win" : "wins"} · {standing.podiums} {standing.podiums === 1 ? "podium" : "podiums"}
        </span>
      </div>
      <Link
        href={standing.driver.handle ? `/drivers/${standing.driver.handle}` : "#standings"}
        className="mt-4 block truncate font-display font-black italic text-2xl md:text-3xl text-white uppercase tracking-normal hover:text-lsr-orange transition-colors"
      >
        {standing.driver.name}
      </Link>
      <p className="mt-1 font-sans text-sm text-white/60">
        <span className="font-bold text-white">{standing.points}</span> points
      </p>
    </div>
  );
}

export default async function LoneStarCupPage() {
  let data: Awaited<ReturnType<typeof loadLoneStarCup>>;
  try {
    data = await loadLoneStarCup();
  } catch (error) {
    console.error('[LoneStarCup] Failed to load series data:', error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <h1 className="mb-10 font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9]">
            Lone Star <span className="text-lsr-orange">Cup</span>
          </h1>
          <DatabaseUnavailable title="Championship Data Unavailable" />
        </div>
      </main>
    );
  }

  const {
    session,
    league,
    currentSeason,
    currentSeries,
    currentStandings,
    currentProgression,
    archivedSeasons,
    entryProduct,
    entryPrice,
    openSeason,
    entitlements,
    application,
    rulesPublished,
    rulesDraftId,
  } = data;

  if (!currentSeason || !currentSeries) {
    return notFound();
  }

  const isEntered = !!league && entitlements.some(
    (entitlement) => entitlement.kind === "league_access" && entitlement.leagueId === league.id,
  );
  const needsMembership =
    !!entryProduct &&
    productRequiresMembership(entryProduct) &&
    !entitlements.some((entitlement) => entitlement.kind === "lsr_member");

  const entry: EntryState = isEntered
    ? { kind: "entered" }
    : !openSeason || !entryProduct || !entryPrice
      ? { kind: "unavailable" }
      : !session.user
        ? { kind: "signin", priceCents: entryPrice.amountCents }
        : needsMembership
          ? { kind: "membership" }
          : {
              kind: "open",
              applied: !!application,
              priceCents: entryPrice.amountCents,
              returningCents: entryPrice.returningAmountCents,
              isReturning: entryPrice.tier === "returning",
            };

  const now = new Date();
  const events = currentSeries.events;
  const rounds = events.map((event, i) => ({ event, ...parseRoundTitle(event.title, i) }));
  const nextIndex = rounds.findIndex((round) => new Date(round.event.endsAtUtc) > now);
  const next = nextIndex === -1 ? null : rounds[nextIndex];
  const completed = nextIndex === -1 ? rounds.length : nextIndex;
  const last = completed > 0 ? rounds[completed - 1] : null;
  const nextLive = next ? new Date(next.event.startsAtUtc) <= now : false;

  // The Twitch player only loads around a round (30 min before to an hour after), so the
  // page doesn't pull in Twitch the rest of the week. It still only appears once the channel is live.
  const streamRound = rounds.find(
    (round) =>
      now.getTime() >= round.event.startsAtUtc.getTime() - 30 * 60_000 &&
      now.getTime() <= round.event.endsAtUtc.getTime() + 60 * 60_000,
  );
  const streamChannel = streamRound ? twitchChannel(streamRound.event.streamUrl) : null;
  // Links follow the round being streamed (or the next one), and always go to Twitch
  const watchUrl = `https://www.twitch.tv/${twitchChannel((streamRound ?? next)?.event.streamUrl ?? null)}`;

  const label = seasonLabel(currentSeason.name);
  const term = seasonTerm(currentSeason.startAt);
  const details = SEASON_DETAILS[currentSeason.slug];
  const firstDate = events[0] ? roundDate(events[0].startsAtUtc, events[0].timezone || DEFAULT_TIMEZONE) : null;
  const weekday = events[0]?.startsAtUtc.toLocaleDateString("en-US", { weekday: "long", timeZone: events[0].timezone || DEFAULT_TIMEZONE });

  const facts = [
    rounds.length > 0 ? plural(rounds.length, "round") : null,
    weekday && firstDate ? `${weekday}s · ${firstDate.time}` : null,
    details?.car ?? null,
    "Assetto Corsa",
  ].filter(Boolean) as string[];

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <ProductPaymentToast />

      {/* Hero */}
      <div className="relative border-b border-white/10 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <CloudinaryImage
            publicId="gallery/lone-star-cup-season-2/lsc2watkinsglen"
            alt=""
            fill
            sizes="100vw"
            preload
            className="object-cover object-[center_65%] opacity-70"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/70 via-lsr-charcoal/30 to-lsr-charcoal" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal/95 via-lsr-charcoal/60 to-transparent" />
        </div>

        <div className={`relative z-10 mx-auto max-w-6xl px-6 md:px-8 pt-20 pb-14 md:pt-28 md:pb-20 ${streamChannel ? "xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,500px)] xl:items-center xl:gap-12" : ""}`}>
          <div>
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-5">
              {label}
              {term ? ` · ${term}` : ""}
            </p>
            <h1>
              <span className="sr-only">Lone Star Cup</span>
              <Image
                src="/images/lone-star-cup-logo.png"
                alt=""
                width={509}
                height={218}
                preload
                className="h-auto w-56 sm:w-72 md:w-80 drop-shadow-2xl"
              />
            </h1>
            <p className="mt-7 max-w-xl font-sans text-base md:text-xl font-bold text-white/85 leading-relaxed">
              LSR&apos;s own championship: a full season of races, one grid, and points toward the title.
            </p>
            <ul className="mt-6 flex flex-wrap gap-2">
              {facts.map((fact) => (
                <li key={fact} className="border border-white/15 bg-lsr-charcoal/50 px-3 py-1.5 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/80">
                  {fact}
                </li>
              ))}
            </ul>
            <div className="mt-9 flex flex-col sm:flex-row sm:flex-wrap sm:items-start gap-4 sm:gap-6">
              <EntryCta state={entry} />
              <div className="flex flex-wrap gap-2">
                {rulesPublished && (
                  <Button asChild className="h-12 rounded-none border border-white/20 bg-lsr-charcoal/40 px-5 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
                    <Link href="/lone-star-cup/rules">
                      <BookOpen className="mr-2 h-3.5 w-3.5" />
                      Rules
                    </Link>
                  </Button>
                )}
                <Button asChild className="h-12 rounded-none border border-white/20 bg-lsr-charcoal/40 px-5 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
                  <a href="#schedule">
                    <CalendarDays className="mr-2 h-3.5 w-3.5" />
                    Schedule
                  </a>
                </Button>
                <Button asChild className="h-12 rounded-none border border-white/20 bg-lsr-charcoal/40 px-5 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
                  <a href={watchUrl} target="_blank" rel="noopener noreferrer">
                    <BrandIcon icon={siTwitch} label="" className="mr-2 h-3.5 w-3.5" />
                    Watch on Twitch
                  </a>
                </Button>
              </div>
            </div>
          </div>
          {/* During a round's broadcast window, the stream shows here once the channel is live */}
          {streamChannel && <LiveStream channel={streamChannel} />}
        </div>
      </div>

      {/* Season progress */}
      <section aria-label="Season progress" className="border-b border-white/10 bg-black/25">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-6 md:py-7 flex flex-col md:flex-row md:items-center gap-4 md:gap-10">
          <div className="shrink-0">
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">
              {rounds.length === 0 ? "Coming up" : next ? (nextLive ? "Racing now" : "Next up") : "Season complete"}
            </p>
            <p className="mt-1 font-display font-black italic text-2xl md:text-3xl uppercase leading-none">
              {rounds.length === 0 ? (
                <>
                  {label} <span className="text-lsr-orange">schedule soon</span>
                </>
              ) : next ? (
                <>
                  {next.name} <span className="text-lsr-orange">{next.track}</span>
                </>
              ) : (
                <>
                  {label} <span className="text-lsr-orange">is in the books</span>
                </>
              )}
            </p>
          </div>
          {rounds.length > 0 && (
          <div className="flex-1">
            <div className="flex gap-1" aria-hidden>
              {rounds.map((round, i) => (
                <span
                  key={round.event.id}
                  className={`h-2 flex-1 -skew-x-[20deg] ${i < completed ? "bg-lsr-orange" : i === completed ? "bg-white/50" : "bg-white/10"}`}
                />
              ))}
            </div>
            <p className="mt-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">
              {completed} of {plural(rounds.length, "round")} run
            </p>
          </div>
          )}
          {next && nextLive && (
            <a
              href={watchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-2 bg-lsr-orange px-4 h-10 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white hover:bg-white hover:text-lsr-charcoal transition-colors"
            >
              <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
              Watch live
            </a>
          )}
          {next && !nextLive && (
            <Link
              href={`/events/${next.event.slug}`}
              className="group inline-flex shrink-0 items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white hover:text-lsr-orange transition-colors"
            >
              {(() => {
                const d = roundDate(next.event.startsAtUtc, next.event.timezone || DEFAULT_TIMEZONE);
                return `${d.day} · ${d.time}`;
              })()}
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
            </Link>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-16 md:py-24 space-y-24 md:space-y-32">
        {/* Next and last round */}
        <section className="grid gap-4 md:gap-6 md:grid-cols-[3fr_2fr]">
          <div className="relative overflow-hidden border border-white/10 bg-white/[0.02] p-6 md:p-10">
            {next?.event.heroImageUrl && (
              <div className="absolute inset-0">
                <Image
                  src={next.event.heroImageUrl}
                  alt=""
                  fill
                  sizes="(min-width: 1152px) 660px, (min-width: 768px) 60vw, 100vw"
                  className="object-cover opacity-50"
                />
                <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal via-lsr-charcoal/75 to-lsr-charcoal/10" />
                <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal/70 to-transparent" />
              </div>
            )}
            <div className="absolute top-0 left-0 z-10 h-1 w-24 bg-lsr-orange" />
            <div className="relative">
              {next ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">
                      {nextLive ? "Racing now" : "Next round"}
                    </p>
                    {next.night && (
                      <span className="inline-flex items-center gap-1 bg-white/10 px-2 py-0.5 font-sans font-bold text-[9px] uppercase tracking-[0.2em] text-white/80">
                        <Moon className="h-3 w-3" /> {next.note}
                      </span>
                    )}
                    {next.final && (
                      <span className="inline-flex items-center gap-1 bg-lsr-orange px-2 py-0.5 font-sans font-bold text-[9px] uppercase tracking-[0.2em] text-white">
                        <Flag className="h-3 w-3" /> Finale
                      </span>
                    )}
                  </div>
                  <div className="mt-5 flex items-end gap-5">
                    <span className="font-display font-black italic text-7xl md:text-9xl leading-[0.8] text-white/10">
                      {next.final ? "FIN" : next.number!.padStart(2, "0")}
                    </span>
                    <h2 className="font-display font-black italic text-4xl md:text-6xl uppercase leading-[0.9]">{next.track}</h2>
                  </div>
                  {(() => {
                    const d = roundDate(next.event.startsAtUtc, next.event.timezone || DEFAULT_TIMEZONE);
                    return (
                      <p className="mt-6 font-sans text-base md:text-lg text-white/75">
                        {d.day} at <span className="font-bold text-white">{d.time}</span>
                      </p>
                    );
                  })()}
                  <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-3">
                    <Link
                      href={`/events/${next.event.slug}`}
                      className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white hover:text-lsr-orange transition-colors"
                    >
                      Event details
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                    </Link>
                    <a
                      href={watchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white transition-colors"
                    >
                      <BrandIcon icon={siTwitch} label="" className="h-3.5 w-3.5" />
                      {nextLive ? "Watch live on Twitch" : "Streams on Twitch"}
                      <ArrowUpRight className="h-3 w-3" />
                    </a>
                  </div>
                </>
              ) : rounds.length === 0 ? (
                <>
                  <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Coming up</p>
                  <h2 className="mt-5 font-display font-black italic text-4xl md:text-6xl uppercase leading-[0.9]">
                    {label} <span className="text-lsr-orange">is coming</span>
                  </h2>
                  <p className="mt-6 font-sans text-base text-white/65">The schedule goes up here once the rounds are set. Watch Discord for dates.</p>
                </>
              ) : (
                <>
                  <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Season complete</p>
                  <h2 className="mt-5 font-display font-black italic text-4xl md:text-6xl uppercase leading-[0.9]">
                    See you <span className="text-lsr-orange">next season</span>
                  </h2>
                  <p className="mt-6 font-sans text-base text-white/65">Final standings are below. Watch Discord for the next season&apos;s dates.</p>
                </>
              )}
            </div>
          </div>

          <div className="group/photo relative overflow-hidden border border-white/10 bg-white/[0.02] p-6 md:p-8 flex flex-col">
            <EventPhotoBand src={last?.event.heroImageUrl ?? null} sizes="(min-width: 1152px) 440px, (min-width: 768px) 40vw, 100vw" />
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">Last round</p>
            {last ? (
              <>
                <h3 className="mt-3 font-display font-black italic text-2xl md:text-3xl uppercase leading-tight">
                  {last.short} <span className="text-lsr-orange">{last.track}</span>
                </h3>
                <p className="mt-1 font-sans text-xs text-white/45">{roundDate(last.event.startsAtUtc, last.event.timezone || DEFAULT_TIMEZONE).day}</p>
                <div className="mt-6 flex-1">
                  {podiumOf(last.event).length > 0 ? (
                    <Podium results={podiumOf(last.event)} size="lg" />
                  ) : (
                    <p className="font-sans text-sm text-white/50">Results will show here once they&apos;re posted.</p>
                  )}
                </div>
                <Link
                  href={`/events/${last.event.slug}`}
                  className="group mt-6 inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-lsr-orange transition-colors"
                >
                  Full results
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                </Link>
              </>
            ) : (
              <p className="mt-4 font-sans text-sm text-white/50">Round 1 hasn&apos;t run yet.</p>
            )}
          </div>
        </section>

        {/* Schedule */}
        <section>
          <SectionHeading kicker={`${label} calendar`} id="schedule">
            The <span className="text-lsr-orange">schedule</span>
          </SectionHeading>
          {rounds.length === 0 && (
            <p className="border border-white/10 bg-white/[0.02] p-8 text-center font-sans text-sm text-white/55">
              Rounds go up here once the season&apos;s schedule is set.
            </p>
          )}
          <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 md:gap-3">
            {rounds.map((round, i) => {
              const done = i < completed;
              const isNext = i === completed;
              const winner = podiumOf(round.event).find((r) => r.position === 1);
              const d = roundDate(round.event.startsAtUtc, round.event.timezone || DEFAULT_TIMEZONE);
              return (
                <li key={round.event.id}>
                  <Link
                    href={`/events/${round.event.slug}`}
                    className={`group relative flex h-full min-h-[150px] flex-col overflow-hidden border p-4 transition-colors ${
                      isNext
                        ? "border-lsr-orange/70 bg-lsr-orange/[0.08]"
                        : done
                          ? "border-white/10 bg-white/[0.015] hover:border-white/30"
                          : "border-white/10 bg-white/[0.03] hover:border-lsr-orange/50"
                    }`}
                  >
                    {round.event.heroImageUrl && (
                      <>
                        <Image
                          src={round.event.heroImageUrl}
                          alt=""
                          fill
                          sizes="(min-width: 1024px) 220px, (min-width: 640px) 33vw, 50vw"
                          className={`object-cover transition-opacity duration-500 ${
                            done ? "opacity-15 grayscale group-hover:opacity-30" : isNext ? "opacity-45" : "opacity-30 group-hover:opacity-50"
                          }`}
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal via-lsr-charcoal/60 to-lsr-charcoal/40" />
                      </>
                    )}
                    <div className="relative flex flex-1 flex-col">
                      <div className="flex items-start justify-between gap-2">
                        <span className={`font-display font-black italic text-3xl leading-none ${isNext ? "text-lsr-orange" : done ? "text-white/20" : "text-white/40"}`}>
                          {round.short}
                        </span>
                        {done ? (
                          <Check className="h-4 w-4 text-white/30" role="img" aria-label="Done" />
                        ) : round.night ? (
                          <Moon className="h-4 w-4 text-white/60" role="img" aria-label="Night race" />
                        ) : round.final ? (
                          <Flag className="h-4 w-4 text-lsr-orange" role="img" aria-label="Finale" />
                        ) : null}
                      </div>
                      <p className={`mt-3 font-sans font-bold text-sm uppercase tracking-tight leading-tight ${done ? "text-white/55" : "text-white"} group-hover:text-lsr-orange transition-colors`}>
                        {round.track}
                      </p>
                      <p className="mt-1 font-sans text-[11px] text-white/40">{d.day}</p>
                      <div className="mt-auto pt-3">
                        {done && winner ? (
                          <p className="truncate font-sans text-[11px] text-white/60">
                            <Trophy className="mr-1 inline h-3 w-3 text-lsr-orange" />
                            {driverName(winner)}
                          </p>
                        ) : isNext ? (
                          <p className="font-sans font-bold text-[9px] uppercase tracking-[0.2em] text-lsr-orange">{nextLive ? "Racing now" : "Next"}</p>
                        ) : round.note ? (
                          <p className="font-sans font-bold text-[9px] uppercase tracking-[0.15em] text-white/50">{round.note}</p>
                        ) : null}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>

        {/* Standings */}
        <section>
          <SectionHeading kicker={`${label} championship`} id="standings">
            The <span className="text-lsr-orange">standings</span>
          </SectionHeading>
          {currentStandings.length > 0 ? (
            <div className="space-y-4 md:space-y-6">
              <div className="grid gap-3 md:gap-4 md:grid-cols-3">
                {currentStandings.slice(0, 3).map((standing, i) => (
                  <LeaderCard key={standing.driver.id || i} standing={standing} place={i + 1} />
                ))}
              </div>
              <StandingsTable standings={currentStandings} title="Championship Standings" infoText={STANDINGS_NOTE} />
              {currentProgression && <ChampionshipChart progression={currentProgression} />}
            </div>
          ) : (
            <div className="border border-white/10 bg-white/[0.02] p-10 md:p-14 text-center">
              <p className="font-display font-black italic text-2xl md:text-3xl uppercase">
                Standings are <span className="text-lsr-orange">on the way</span>
              </p>
              <p className="mx-auto mt-3 max-w-lg font-sans text-sm text-white/55 leading-relaxed">
                They fill in as race results are posted. {STANDINGS_NOTE.split(". ").slice(1).join(". ")}
              </p>
            </div>
          )}
        </section>

        {/* How it works */}
        <section>
          <SectionHeading kicker="Join the grid">
            How to <span className="text-lsr-orange">enter</span>
          </SectionHeading>
          <div className="grid gap-10 lg:grid-cols-[2fr_3fr] lg:gap-16">
            <div className="space-y-5 font-sans text-white/65 leading-relaxed">
              <p>
                The Lone Star Cup brings together members of all experience levels, from season veterans to those taking their first turns on a track. It&apos;s built on sportsmanship, and the grid helps newcomers find their pace.
              </p>
              {details && <p>{details.blurb}</p>}
            </div>
            <ol className="grid gap-px bg-white/10 border border-white/10 sm:grid-cols-2">
              {[
                { title: "Make an account", body: "You enter with your LSR account. Once it's linked to your Assetto Corsa name, your results show up in the standings." },
                { title: "Fill out the entry form", body: "Your Discord name, your experience and what you race on. Pick a car number while you're there." },
                {
                  title: "Pay the entry fee",
                  body: entryPrice
                    ? `${entryPrice.tier === "returning" ? "Your returning-driver rate is" : "It's"} $${(entryPrice.amountCents / 100).toFixed(2)}${
                        entryPrice.returningAmountCents !== null && entryPrice.tier !== "returning"
                          ? ` ($${(entryPrice.returningAmountCents / 100).toFixed(2)} for returning drivers)`
                          : ""
                      }, paid securely on Stripe.`
                    : "Paid securely on Stripe once the form is in.",
                },
                { title: "Get your Discord role", body: "The comp team gives you the LSC role on Discord, and you're set for race day." },
              ].map((step, i) => (
                <li key={step.title} className="bg-lsr-charcoal p-6 md:p-7">
                  <span className="font-display font-black italic text-4xl text-white/10 leading-none">0{i + 1}</span>
                  <h3 className="mt-3 font-sans font-black text-sm uppercase tracking-[0.15em] text-white">{step.title}</h3>
                  <p className="mt-2 font-sans text-sm text-white/55 leading-relaxed">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Rules */}
        {rulesPublished ? (
          <section className="relative overflow-hidden border border-white/10 bg-white/[0.02] p-6 md:p-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
            <div className="flex gap-5">
              <ScrollText className="h-10 w-10 shrink-0 text-lsr-orange" />
              <div>
                <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Before race day</p>
                <h2 className="mt-2 font-display font-black italic text-3xl md:text-4xl uppercase leading-none">
                  The <span className="text-lsr-orange">rules</span>
                </h2>
                <p className="mt-3 max-w-xl font-sans text-sm md:text-base text-white/60 leading-relaxed">
                  Race format, car setup, practice, qualifying and race rules. Entering means you agree to them, so give them a read.
                </p>
              </div>
            </div>
            <Button asChild className="h-12 shrink-0 rounded-none bg-lsr-orange px-7 font-sans text-xs font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
              <Link href="/lone-star-cup/rules">Read the rules</Link>
            </Button>
          </section>
        ) : rulesDraftId ? (
          <section className="border border-dashed border-amber-500/40 bg-amber-500/5 p-6 md:p-8 font-sans text-sm text-amber-100/80">
            <p className="font-bold uppercase tracking-[0.2em] text-[10px] text-amber-300">Officers only</p>
            <p className="mt-2">
              The rules are still a draft, so visitors don&apos;t see them yet. Once Competition signs off,{" "}
              <Link href={`/admin/pages/${rulesDraftId}`} className="underline hover:text-white">publish them in Admin → Pages</Link>{" "}
              and they show up here and as a Rules button at the top of this page.{" "}
              <Link href="/lone-star-cup/rules" className="underline hover:text-white">Preview the draft</Link>.
            </p>
          </section>
        ) : null}

        {/* Directors */}
        <section>
          <SectionHeading kicker="Race control">
            Series <span className="text-lsr-orange">directors</span>
          </SectionHeading>
          <div className="grid gap-4 md:gap-6 md:grid-cols-2">
            {DIRECTORS.map((director) => (
              <article key={director.name} className="group grid grid-cols-[112px_1fr] sm:grid-cols-[180px_1fr] border border-white/10 bg-white/[0.02] overflow-hidden">
                <div className="relative aspect-[4/5] sm:aspect-auto sm:min-h-[240px] overflow-hidden border-r border-white/10 bg-black">
                  <Image
                    src={director.photo}
                    alt={director.name}
                    fill
                    sizes="(min-width: 640px) 180px, 112px"
                    className="object-cover opacity-85 transition-all duration-500 group-hover:scale-105 group-hover:opacity-100"
                  />
                </div>
                <div className="p-5 md:p-7">
                  <h3 className="font-display font-black italic text-2xl md:text-3xl text-white uppercase tracking-normal leading-tight">{director.name}</h3>
                  <p className="mt-1 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange">{director.title}</p>
                  <p className="mt-4 font-sans text-sm text-white/65 leading-relaxed">{director.blurb}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* Archive */}
        {archivedSeasons.length > 0 && (
          <section>
            <SectionHeading kicker="Hall of champions">
              Past <span className="text-lsr-orange">seasons</span>
            </SectionHeading>
            <div className="space-y-4">
              {archivedSeasons.map((season) => {
                const pastRounds = season.series!.events.map((event, i) => ({ event, ...parseRoundTitle(event.title, i) }));
                const champion = season.standings[0];
                return (
                  <details key={season.id} className="group/season border border-white/10 bg-white/[0.02] open:bg-white/[0.03]">
                    <summary className="grid cursor-pointer list-none gap-x-6 gap-y-2 p-6 md:grid-cols-[1fr_auto] md:items-center md:p-8 [&::-webkit-details-marker]:hidden">
                      <span className="block font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">
                        {season.term ? `${season.term} · ` : ""}
                        {plural(pastRounds.length, "round")}
                      </span>
                      <h3 className="font-display font-black italic text-3xl md:text-4xl uppercase leading-none md:col-start-1">{season.label}</h3>
                      <span className="mt-2 flex items-center gap-6 md:col-start-2 md:row-span-2 md:row-start-1 md:mt-0">
                        {champion && (
                          <span className="block text-left md:text-right">
                            <span className="block font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">
                              <Trophy className="mr-1 inline h-3 w-3" /> Champion
                            </span>
                            <span className="block mt-1 font-display font-black italic text-xl md:text-2xl uppercase">{champion.driver.name}</span>
                            <span className="block font-sans text-xs text-white/50">
                              {champion.points} pts · {champion.wins} {champion.wins === 1 ? "win" : "wins"}
                            </span>
                          </span>
                        )}
                        <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/40 group-open/season:hidden">Show</span>
                        <span className="hidden group-open/season:inline font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/40">Hide</span>
                      </span>
                    </summary>
                    <div className="space-y-6 border-t border-white/10 p-6 md:p-8">
                      <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                        {pastRounds.map((round) => {
                          const winner = podiumOf(round.event).find((r) => r.position === 1);
                          return (
                            <li key={round.event.id}>
                              <Link
                                href={`/events/${round.event.slug}`}
                                className="group flex h-full flex-col border border-white/10 bg-black/20 p-3 transition-colors hover:border-lsr-orange/50"
                              >
                                <span className="font-display font-black italic text-lg leading-none text-white/30">{round.short}</span>
                                <span className="mt-2 font-sans font-bold text-xs uppercase tracking-tight text-white group-hover:text-lsr-orange transition-colors">
                                  {round.track}
                                </span>
                                <span className="mt-auto pt-2 truncate font-sans text-[11px] text-white/55">
                                  {winner ? (
                                    <>
                                      <Trophy className="mr-1 inline h-3 w-3 text-lsr-orange" />
                                      {driverName(winner)}
                                    </>
                                  ) : (
                                    "No results"
                                  )}
                                </span>
                              </Link>
                            </li>
                          );
                        })}
                      </ol>
                      {season.standings.length > 0 && (
                        <StandingsTable standings={season.standings} title={`${season.label} final standings`} infoText={STANDINGS_NOTE} />
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* Closing CTA */}
      <section className="relative overflow-hidden border-t border-white/10">
        <div className="absolute inset-0 z-0">
          <CloudinaryImage
            publicId="gallery/lone-star-cup-season-2/lsc2daytona"
            alt=""
            fill
            sizes="100vw"
            className="object-cover opacity-55"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal via-lsr-charcoal/80 to-lsr-charcoal/30" />
        </div>
        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 py-20 md:py-28">
          <div className="max-w-xl">
            <h2 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9]">
              Grab a <span className="text-lsr-orange">grid slot</span>
            </h2>
            <p className="mt-5 font-sans text-base md:text-lg text-white/70 leading-relaxed">
              {entry.kind === "entered"
                ? next
                  ? `You're on the grid. ${next.final ? "The finale" : next.name} is at ${next.track}.`
                  : "You're on the grid. Watch Discord for what's next."
                : entry.kind === "unavailable"
                  ? "Entry is closed right now. Say hi on Discord in the meantime."
                  : next
                    ? `${next.final ? "The finale" : next.name} is at ${next.track}. Enter and race the rest of the season.`
                    : "Entry is open. Watch Discord for race dates."}
            </p>
            <div className="mt-8 flex flex-col sm:flex-row sm:items-start gap-4">
              <EntryCta state={entry} />
              <Button
                asChild
                className="h-12 rounded-none border border-white/20 bg-lsr-charcoal/40 px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal"
              >
                <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
                  <MessageSquare className="mr-2 h-3.5 w-3.5" />
                  Join the Discord
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
