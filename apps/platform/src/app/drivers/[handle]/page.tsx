import Image from "next/image";
import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { Metadata } from "next";
import { ArrowLeft, ArrowRight, Car, Check, Flag, Globe, Pencil, Trophy } from "lucide-react";
import { siInstagram, siTwitch, siYoutube } from "simple-icons/icons";
import { Button } from "@/components/ui/button";
import { BrandIcon } from "@/components/brand-icon";
import { CloudinaryImage } from "@/components/cloudinary-image";
import { DatabaseUnavailable } from "@/components/database-unavailable";
import { RacingNumber } from "@/components/racing-number";
import { StatusBadges } from "@/components/status-indicators";
import { AgendaRow } from "@/components/events/agenda-row";
import { getStatusIndicators } from "@/lib/status-indicators";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { getDriverProfile, type DriverProfile } from "@/server/queries/driver-profile";
import { getSchedule } from "@/server/queries/schedule";
import { initials } from "../names";
import { CANONICAL_SITE_URL } from "@/lib/site-url";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  let profile: DriverProfile | null = null;
  try {
    profile = await getDriverProfile(handle);
  } catch {
    profile = null;
  }
  if (!profile) return { title: "Driver", alternates: { canonical: `/drivers/${handle}` } };

  const { user } = profile;
  const description = user.bio?.slice(0, 155) || `${user.displayName}: driver page, race history and stats with Longhorn Sim Racing at UT Austin.`;
  return {
    title: user.displayName,
    description,
    alternates: { canonical: `/drivers/${handle}` },
    openGraph: { title: user.displayName, description, type: "profile", url: `/drivers/${handle}` },
    twitter: { title: user.displayName, description },
  };
}

const SOCIALS = [
  { key: "instagram", label: "Instagram", icon: siInstagram },
  { key: "twitch", label: "Twitch", icon: siTwitch },
  { key: "youtube", label: "YouTube", icon: siYoutube },
] as const;

/** 105,800 ms → "1:45.800" */
function lapTime(ms: number | null) {
  if (!ms) return null;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${minutes}:${seconds}`;
}

const ordinalPlace = (n: number | null) => (n ? `P${n}` : "—");

function SectionHeading({ kicker, children, id, aside }: { kicker: string; children: React.ReactNode; id?: string; aside?: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-24 mb-6 md:mb-8 flex flex-col md:flex-row md:items-end justify-between gap-3">
      <div>
        <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-2">{kicker}</p>
        <h2 className="font-display font-black italic text-3xl md:text-4xl text-white uppercase tracking-normal leading-[0.95]">{children}</h2>
      </div>
      {aside}
    </div>
  );
}

export default async function DriverProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;

  let profile: DriverProfile | null;
  let viewerId: string | null = null;
  try {
    const [loaded, session] = await Promise.all([getDriverProfile(handle), getCachedSessionUser()]);
    profile = loaded;
    viewerId = session.user?.id ?? null;
  } catch (error) {
    unstable_rethrow(error);
    console.error("[DriverProfile] Failed to load driver:", error);
    return (
      <div className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <DatabaseUnavailable title="Driver Profile Unavailable" />
        </div>
      </div>
    );
  }
  if (!profile) return notFound();

  const { user, driver, seasons, races, cars, events } = profile;
  const isMe = viewerId === user.id;
  const myEvents = isMe
    ? (
        await getSchedule(user.id).catch((error) => {
          console.error("[DriverProfile] Failed to load schedule:", error);
          return [];
        })
      ).filter((e) => e.viewer && !e.ended)
    : [];

  const socials = (user.socials as Record<string, string> | null) ?? {};
  const links = [
    ...SOCIALS.filter((s) => /^https?:\/\//i.test(socials[s.key] ?? "")).map((s) => ({ ...s, href: socials[s.key] })),
  ];
  const website = /^https?:\/\//i.test(socials.website ?? "") ? socials.website : null;

  const indicators = driver
    ? getStatusIndicators({ roles: driver.roles, activeTierKey: driver.tierKey, officerTitle: driver.officerTitle })
    : [];
  const joined = user.signedUpAt.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const missing = isMe
    ? [!user.avatarUrl && "a photo", user.racingNumber == null && "a car number", !user.bio && "a short bio"].filter((x): x is string => !!x)
    : [];
  const details = [
    user.major && { label: "Studies", value: user.major },
    user.gradYear && { label: "Class of", value: String(user.gradYear) },
    user.iRating && { label: "iRating", value: user.iRating.toLocaleString("en-US") },
  ].filter((d): d is { label: string; value: string } => !!d);

  const stats = driver
    ? [
        { label: "All-time rank", value: driver.rank ? `P${driver.rank}` : "—" },
        { label: "Points", value: driver.points },
        { label: "Starts", value: driver.starts },
        { label: "Wins", value: driver.wins },
        { label: "Podiums", value: driver.podiums },
        { label: "Best finish", value: driver.bestFinish ? `P${driver.bestFinish}` : "—" },
      ]
    : [];
  const hasRacing = (driver?.starts ?? 0) > 0 || races.length > 0;

  const personJsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: user.displayName,
    alternateName: `@${user.handle}`,
    url: `${CANONICAL_SITE_URL}/drivers/${user.handle}`,
    image: user.avatarUrl || undefined,
    description: user.bio || undefined,
    memberOf: { "@type": "SportsOrganization", name: "Longhorn Sim Racing", url: CANONICAL_SITE_URL },
    sameAs: [...links.map((l) => l.href), ...(website ? [website] : [])],
  };
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${CANONICAL_SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Drivers", item: `${CANONICAL_SITE_URL}/drivers` },
      { "@type": "ListItem", position: 3, name: user.displayName, item: `${CANONICAL_SITE_URL}/drivers/${user.handle}` },
    ],
  };
  const jsonLd = (data: object) => JSON.stringify(data).replace(/</g, "\\u003c");

  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(personJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }} />

      {/* Hero */}
      <div className="relative overflow-hidden border-b border-white/10">
        <div className="absolute inset-0 z-0">
          <CloudinaryImage
            publicId="gallery/liveries/caracciola-karussell-2"
            alt=""
            fill
            preload
            sizes="100vw"
            className="object-cover object-[center_55%] opacity-70"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/50 via-transparent to-lsr-charcoal" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal/90 via-lsr-charcoal/55 to-transparent" />
        </div>
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />
        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 pt-10 pb-12 md:pt-14 md:pb-16">
          <Link href="/drivers" className="group inline-flex items-center gap-2 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/60 transition-colors hover:text-lsr-orange">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-1" />
            Driver roster
          </Link>
          <div className="mt-8 flex flex-col gap-6 md:flex-row md:items-end md:gap-8">
            <div className="relative h-28 w-28 shrink-0 overflow-hidden border-2 border-white/15 bg-black shadow-2xl md:h-40 md:w-40">
              {user.avatarUrl ? (
                <Image src={user.avatarUrl} alt={user.displayName} fill sizes="160px" preload className="object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center font-display font-black italic text-5xl text-white/25">{initials(user.displayName)}</span>
              )}
              <div className="absolute bottom-0 left-0 h-1 w-full bg-lsr-orange" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <RacingNumber user={user} size="lg" />
                {driver?.titles.map((title, i) => (
                  <span key={`${title}-${i}`} className="inline-flex items-center gap-1.5 bg-lsr-orange px-2 py-1 font-sans font-bold text-[10px] uppercase tracking-[0.15em] text-white">
                    <Trophy className="h-3 w-3" aria-hidden />
                    {title} champion
                  </span>
                ))}
              </div>
              <h1 className="mt-3 break-words font-display font-black italic text-5xl md:text-7xl uppercase leading-[0.9] text-white">{user.displayName}</h1>
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm text-white/60">
                <span>@{user.handle}</span>
                <span aria-hidden>·</span>
                <span>On the roster since {joined}</span>
              </p>
              {indicators.length > 0 && (
                <div className="mt-4">
                  <StatusBadges indicators={indicators} />
                </div>
              )}
            </div>
            {isMe && (
              <Button asChild className="h-11 shrink-0 self-start rounded-none border border-white/20 bg-lsr-charcoal/50 px-5 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal md:self-end">
                <Link href={`/drivers/${user.handle}/edit`}>
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit profile
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Career stats */}
      {hasRacing && (
        <section aria-label="Career stats" className="border-b border-white/10 bg-black/25">
          <dl className="mx-auto grid max-w-6xl grid-cols-3 md:grid-cols-6">
            {stats.map((stat, i) => (
              <div
                key={stat.label}
                className={`flex flex-col-reverse px-4 py-5 md:px-6 md:py-7 ${i % 3 !== 0 ? "border-l border-white/10" : ""} ${i >= 3 ? "border-t border-white/10 md:border-t-0" : ""} ${i === 3 ? "md:border-l" : ""}`}
              >
                <dt className="mt-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">{stat.label}</dt>
                <dd className="font-display font-black italic text-3xl md:text-4xl leading-none text-white">{stat.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-12 md:py-16 space-y-16 md:space-y-20">
        {/* Owner nudge */}
        {missing.length > 0 && (
          <div className="relative flex flex-col gap-4 border border-lsr-orange/40 bg-lsr-orange/[0.06] p-5 md:flex-row md:items-center md:justify-between md:p-6">
            <div>
              <p className="font-display font-black italic text-xl uppercase text-white">Finish your driver page</p>
              <p className="mt-1 font-sans text-sm text-white/70">Add {missing.join(", ").replace(/, ([^,]*)$/, " and $1")} so people can find you on the grid.</p>
            </div>
            <Button asChild className="h-11 shrink-0 rounded-none bg-lsr-orange px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
              <Link href={`/drivers/${user.handle}/edit`}>Edit profile</Link>
            </Button>
          </div>
        )}

        {/* About */}
        {(user.bio || details.length > 0 || links.length > 0 || website) && (
          <section className={`grid gap-8 lg:gap-12 ${user.bio ? "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : ""}`}>
            <div>
              <SectionHeading kicker="Who's driving">
                About <span className="text-lsr-orange">{user.displayName.split(" ")[0]}</span>
              </SectionHeading>
              {user.bio && <p className="max-w-2xl whitespace-pre-line font-sans text-base md:text-lg leading-relaxed text-white/80">{user.bio}</p>}
            </div>
            {(details.length > 0 || links.length > 0 || website) && (
              <div className={`relative self-start border border-white/10 bg-white/[0.02] p-6 ${user.bio ? "" : "max-w-xl"}`}>
                <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
                {details.length > 0 && (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
                    {details.map((d) => (
                      <div key={d.label}>
                        <dt className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">{d.label}</dt>
                        <dd className="mt-1 font-sans text-sm font-bold text-white">{d.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {(links.length > 0 || website) && (
                  <div className={`flex flex-wrap gap-2 ${details.length > 0 ? "mt-6 border-t border-white/10 pt-5" : ""}`}>
                    {links.map((link) => (
                      <a
                        key={link.key}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer nofollow ugc"
                        className="inline-flex h-10 items-center gap-2 border border-white/15 px-3 font-sans text-xs font-bold text-white/80 transition-colors hover:border-lsr-orange hover:text-lsr-orange"
                      >
                        <span aria-hidden>
                          <BrandIcon icon={link.icon} label="" className="h-3.5 w-3.5" />
                        </span>
                        {link.label}
                      </a>
                    ))}
                    {website && (
                      <a
                        href={website}
                        target="_blank"
                        rel="noopener noreferrer nofollow ugc"
                        className="inline-flex h-10 items-center gap-2 border border-white/15 px-3 font-sans text-xs font-bold text-white/80 transition-colors hover:border-lsr-orange hover:text-lsr-orange"
                      >
                        <Globe className="h-3.5 w-3.5" aria-hidden />
                        Website
                      </a>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* The owner's own upcoming events */}
        {isMe && myEvents.length > 0 && (
          <section>
            <SectionHeading
              kicker="Only you see this"
              aside={
                <Link href="/account" className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-lsr-orange">
                  Your account <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                </Link>
              }
            >
              Your <span className="text-lsr-orange">events</span>
            </SectionHeading>
            <ul className="space-y-2">
              {myEvents.slice(0, 4).map((event) => (
                <AgendaRow key={event.slug} event={event} titleAs="h3" />
              ))}
            </ul>
          </section>
        )}

        {/* Seasons */}
        {seasons.length > 0 && (
          <section>
            <SectionHeading kicker="League record">
              Seasons <span className="text-lsr-orange">entered</span>
            </SectionHeading>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {seasons.map((s) => (
                <li key={s.slug} className="relative border border-white/10 bg-white/[0.02] p-5">
                  <div className={`absolute top-0 left-0 h-1 ${s.rank === 1 ? "w-full" : "w-16"} bg-lsr-orange`} />
                  <p className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">{s.league ?? "League"}</p>
                  <p className="mt-1 font-display font-black italic text-2xl uppercase text-white">{s.season}</p>
                  <div className="mt-4 flex items-end justify-between gap-4">
                    <p className="font-display font-black italic leading-none">
                      <span className={`text-5xl ${s.rank === 1 ? "text-lsr-orange" : "text-white"}`}>{ordinalPlace(s.rank)}</span>
                      {s.field > 0 && s.rank && <span className="ml-2 font-sans not-italic text-xs font-bold text-white/45">of {s.field}</span>}
                    </p>
                    <p className="font-sans text-sm text-white/70">
                      <span className="font-display font-black italic text-2xl text-white">{s.points}</span> pts
                    </p>
                  </div>
                  <p className="mt-4 border-t border-white/10 pt-3 font-sans text-xs text-white/55">
                    {s.starts} {s.starts === 1 ? "start" : "starts"}
                    {s.wins > 0 ? ` · ${s.wins} ${s.wins === 1 ? "win" : "wins"}` : ""}
                    {s.podiums > 0 ? ` · ${s.podiums} ${s.podiums === 1 ? "podium" : "podiums"}` : ""}
                    {s.car ? ` · ${s.car}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Race results */}
        {races.length > 0 && (
          <section>
            <SectionHeading kicker="Every uploaded race">
              Race <span className="text-lsr-orange">results</span>
            </SectionHeading>
            <ol className="divide-y divide-white/5 border border-white/10">
              {races.map((race) => (
                <li key={race.id}>
                  <Link
                    href={`/events/${race.eventSlug}`}
                    className="group grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-4 px-4 py-3.5 transition-colors hover:bg-white/[0.03] md:grid-cols-[4.5rem_minmax(0,1fr)_9rem_6rem_5rem] md:px-5"
                  >
                    <span className={`font-display font-black italic text-2xl md:text-3xl leading-none ${race.position === 1 ? "text-lsr-orange" : race.position <= 3 ? "text-white" : "text-white/50"}`}>
                      P{race.position}
                      <span className="block font-sans not-italic text-[10px] font-bold tracking-normal text-white/35">of {race.field}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-sans font-bold text-sm uppercase tracking-tight text-white group-hover:text-lsr-orange transition-colors">{race.title}</span>
                      <span className="mt-0.5 block truncate font-sans text-xs text-white/50">
                        {race.date}
                        {race.series ? ` · ${race.series}` : ""}
                        <span className="md:hidden"> · {race.car}</span>
                        {!race.finished && <span className="text-red-300"> · {race.status}</span>}
                      </span>
                    </span>
                    <span className="hidden truncate font-sans text-xs text-white/60 md:block">{race.car}</span>
                    <span className="hidden font-mono text-xs text-white/60 md:block">{lapTime(race.bestLapTime) ?? "—"}</span>
                    <span className="text-right font-display font-black italic text-lg text-white">
                      {race.points ?? 0}
                      <span className="ml-1 font-sans not-italic text-[10px] font-bold text-white/40">pts</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* Cars and events */}
        {(cars.length > 0 || events.length > 0) && (
          <section className="grid gap-12 lg:grid-cols-2">
            {cars.length > 0 && (
              <div>
                <SectionHeading kicker="In the garage">
                  Cars <span className="text-lsr-orange">driven</span>
                </SectionHeading>
                <ul className="space-y-2">
                  {cars.map((car) => (
                    <li key={car.car} className="flex items-center gap-4 border border-white/10 bg-white/[0.02] px-4 py-3">
                      <Car className="h-5 w-5 shrink-0 text-lsr-orange" aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-sans font-bold text-sm uppercase tracking-tight text-white">{car.car}</span>
                      <span className="shrink-0 font-sans text-xs text-white/60">
                        {car.races} {car.races === 1 ? "race" : "races"}
                        {car.wins > 0 ? ` · ${car.wins} ${car.wins === 1 ? "win" : "wins"}` : ` · best P${car.bestFinish}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {events.length > 0 && (
              <div>
                <SectionHeading kicker="Checked in at">
                  Events <span className="text-lsr-orange">attended</span>
                </SectionHeading>
                <ul className="space-y-2">
                  {events.map((event) => (
                    <li key={event.slug}>
                      <Link href={`/events/${event.slug}`} className="group flex items-center gap-4 border border-white/10 bg-white/[0.02] px-4 py-3 transition-colors hover:border-lsr-orange/50">
                        <Check className="h-5 w-5 shrink-0 text-emerald-300" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-sans font-bold text-sm uppercase tracking-tight text-white group-hover:text-lsr-orange transition-colors">{event.title}</span>
                          <span className="block font-sans text-xs text-white/50">{event.date}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* Nothing yet */}
        {!hasRacing && events.length === 0 && (
          <div className="relative border border-white/10 bg-white/[0.02] p-8 text-center md:p-12">
            <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
            <Flag className="mx-auto h-8 w-8 text-white/25" aria-hidden />
            <p className="mt-4 font-display font-black italic text-2xl uppercase text-white/85">No races yet</p>
            <p className="mt-2 font-sans text-sm text-white/55">
              {isMe ? "Results show up here after your first race." : `${user.displayName.split(" ")[0]}'s results show up here after their first race.`}
            </p>
            <Button asChild className="mt-6 h-11 rounded-none bg-lsr-orange px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
              <Link href="/events">See what&apos;s coming up</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
