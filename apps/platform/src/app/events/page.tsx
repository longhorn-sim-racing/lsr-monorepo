import Image from "next/image";
import Link from "next/link";
import { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { ArrowRight, CalendarDays, Clock, Images, MapPin, MessageSquare, Monitor, Radio } from "lucide-react";
import { siInstagram } from "simple-icons/icons";
import { Button } from "@/components/ui/button";
import { BrandIcon } from "@/components/brand-icon";
import { CloudinaryImage } from "@/components/cloudinary-image";
import { DatabaseUnavailable } from "@/components/database-unavailable";
import { INSTAGRAM_PROFILE_URL } from "@/lib/instagram";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { getSchedule, type ScheduleEvent } from "@/server/queries/schedule";
import { Schedule } from "./schedule";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Events Schedule",
  description: "View the official Longhorn Sim Racing event calendar, upcoming races, and past results.",
  alternates: {
    canonical: "/events",
  },
};

const DISCORD_URL = "https://discord.gg/5Uv9YwpnFz";

const ghostButton =
  "h-12 rounded-none border border-white/20 bg-lsr-charcoal/40 px-5 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal";
const primaryButton =
  "h-12 rounded-none bg-lsr-orange px-7 font-sans text-xs font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "Starts in 2 days" */
function countdown(startsAt: string, now: Date) {
  const hours = (new Date(startsAt).getTime() - now.getTime()) / 3_600_000;
  if (hours < 1) return "Starting soon";
  if (Math.round(hours) < 24) return `Starts in ${plural(Math.round(hours), "hour")}`;
  return `Starts in ${plural(Math.max(1, Math.round(hours / 24)), "day")}`;
}

/** The next (or live) event, in the hero's right half */
function NextUp({ event, now }: { event: ScheduleEvent; now: Date }) {
  const live = event.state === "live";
  const Where = event.online ? Monitor : MapPin;
  return (
    <aside aria-label={live ? "Happening now" : "Next event"} className="relative mt-12 overflow-hidden border border-white/15 bg-lsr-charcoal/75 backdrop-blur-sm xl:mt-0">
      <div className={`absolute top-0 left-0 z-10 h-1 ${live ? "w-full bg-red-600" : "w-24 bg-lsr-orange"}`} />
      {event.photo && (
        <div className="relative h-36 overflow-hidden border-b border-white/10">
          <Image src={event.photo} alt="" fill sizes="(min-width: 1280px) 460px, 100vw" className="object-cover opacity-75" />
          <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal/90 to-transparent" />
        </div>
      )}
      <div className="p-6 md:p-7">
        <p className={`inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.3em] ${live ? "text-red-400" : "text-lsr-orange"}`}>
          {live ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-red-500 motion-safe:animate-pulse" /> Happening now
            </>
          ) : (
            <>Next up · {countdown(event.startsAt, now)}</>
          )}
        </p>
        <p className="mt-3 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">{event.series ?? event.family}</p>
        <h2 className="mt-1 font-display font-black italic text-3xl md:text-4xl uppercase leading-[0.95] text-white">
          {event.round ? (
            <>
              {event.round.name} <span className="text-lsr-orange">{event.round.track}</span>
            </>
          ) : (
            event.title
          )}
        </h2>
        <ul className="mt-5 space-y-2 font-sans text-sm text-white/75">
          <li className="flex items-center gap-2.5">
            <CalendarDays className="h-4 w-4 shrink-0 text-lsr-orange" aria-hidden />
            {event.date}
          </li>
          <li className="flex items-center gap-2.5">
            <Clock className="h-4 w-4 shrink-0 text-lsr-orange" aria-hidden />
            {event.time}
          </li>
          {event.venue && (
            <li className="flex items-center gap-2.5">
              <Where className="h-4 w-4 shrink-0 text-lsr-orange" aria-hidden />
              {event.mapsUrl && !event.online ? (
                <a href={event.mapsUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-white/25 underline-offset-4 hover:text-lsr-orange">
                  {event.venue}
                </a>
              ) : (
                event.venue
              )}
            </li>
          )}
        </ul>
        <div className="mt-7 flex flex-wrap gap-3">
          {live && event.streamUrl ? (
            <Button asChild className="h-11 rounded-none bg-red-600 px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
              <a href={event.streamUrl} target="_blank" rel="noopener noreferrer">
                <Radio className="mr-2 h-3.5 w-3.5" />
                Watch live
              </a>
            </Button>
          ) : event.registration === "open" && !event.viewer ? (
            <Button asChild className="h-11 rounded-none bg-lsr-orange px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
              <Link href={`/events/${event.slug}`}>Register</Link>
            </Button>
          ) : null}
          <Button asChild className="h-11 rounded-none border border-white/20 bg-transparent px-5 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
            <Link href={`/events/${event.slug}`}>
              {event.viewer === "registered" ? "You're in · Details" : "Event details"}
              <ArrowRight className="ml-2 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </aside>
  );
}

export default async function EventsIndexPage() {
  let events: ScheduleEvent[];
  let signedIn: boolean;
  try {
    const session = await getCachedSessionUser();
    signedIn = !!session.user;
    events = await getSchedule(session.user?.id ?? null);
  } catch (error) {
    unstable_rethrow(error);
    console.error("[Events] Failed to load events:", error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <h1 className="mb-10 font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9]">
            The <span className="text-lsr-orange">Schedule</span>
          </h1>
          <DatabaseUnavailable title="Schedule Unavailable" />
        </div>
      </main>
    );
  }

  const now = new Date();
  const ahead = events.filter((e) => !e.ended && e.state !== "cancelled" && e.state !== "postponed");
  const next = ahead.find((e) => e.state === "live") ?? ahead[0] ?? null;
  const hosted = events.filter((e) => e.ended && e.state === "past").length;
  // Events in the month of the next one, e.g. "In October"
  const nextMonth = ahead[0]?.month ?? null;
  const thisMonth = ahead.filter((e) => e.month === nextMonth).length;
  const kinds = new Set(events.map((e) => e.family)).size;

  const stats = [
    { value: ahead.length, label: "On the calendar" },
    { value: thisMonth, label: nextMonth ? `In ${nextMonth.split(" ")[0]}` : "This month" },
    { value: hosted, label: "Events hosted" },
    { value: kinds, label: "Series and socials" },
  ];

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Longhorn Sim Racing Events",
    numberOfItems: events.length,
    itemListElement: events.map((event, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `https://www.longhornsimracing.org/events/${event.slug}`,
      name: event.title,
    })),
  };

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd).replace(/</g, "\\u003c") }} />

      {/* Hero */}
      <div className="relative border-b border-white/10 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <CloudinaryImage
            publicId="gallery/sim-night-race-club/img-9963"
            alt=""
            fill
            sizes="100vw"
            preload
            className="object-cover object-[center_45%] opacity-70"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/70 via-lsr-charcoal/30 to-lsr-charcoal" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal/95 via-lsr-charcoal/60 to-transparent" />
        </div>
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />
        <div className={`relative z-10 mx-auto max-w-6xl px-6 md:px-8 pt-20 pb-14 md:pt-28 md:pb-20 ${next ? "xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,440px)] xl:items-center xl:gap-14" : ""}`}>
          <div>
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-5">Official event calendar</p>
            <h1 className="font-display font-black italic text-6xl md:text-8xl text-white uppercase tracking-normal leading-[0.9]">
              The <span className="text-lsr-orange">schedule</span>
            </h1>
            <p className="mt-7 max-w-xl font-sans text-base md:text-xl font-bold text-white/85 leading-relaxed">
              League races, sim nights, socials and days at the track. Everything Longhorn Sim Racing has on, in one place.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button asChild className={primaryButton}>
                <a href="#upcoming">
                  <CalendarDays className="mr-2 h-4 w-4" />
                  What&apos;s coming up
                </a>
              </Button>
              <Button asChild className={ghostButton}>
                <a href="#past">
                  <Images className="mr-2 h-3.5 w-3.5" />
                  Past events
                </a>
              </Button>
            </div>
          </div>
          {next && <NextUp event={next} now={now} />}
        </div>
      </div>

      {/* Stats */}
      <section aria-label="Events in numbers" className="border-b border-white/10 bg-black/25">
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

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-16 md:py-24">
        <Schedule events={events} />
      </div>

      {/* Closing CTA */}
      <section className="relative overflow-hidden border-t border-white/10">
        <div className="absolute inset-0 z-0">
          <CloudinaryImage
            publicId="gallery/harris-hill-raceway/dsc00587"
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
              Never miss <span className="text-lsr-orange">a race</span>
            </h2>
            <p className="mt-5 font-sans text-base md:text-lg text-white/70 leading-relaxed">
              New events land on Discord first, then here and on Instagram.
              {signedIn ? " Your registrations show on your driver page." : " Make an account to register in one click."}
            </p>
            <div className="mt-8 flex flex-col sm:flex-row sm:flex-wrap sm:items-start gap-4">
              <Button asChild className={primaryButton}>
                <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
                  <MessageSquare className="mr-2 h-4 w-4" />
                  Join the Discord
                </a>
              </Button>
              <Button asChild className={ghostButton}>
                <a href={INSTAGRAM_PROFILE_URL} target="_blank" rel="noopener noreferrer">
                  <BrandIcon icon={siInstagram} label="" className="mr-2 h-3.5 w-3.5" />
                  Follow on Instagram
                </a>
              </Button>
              {!signedIn && (
                <Button asChild className={ghostButton}>
                  <Link href="/auth/signin?next=/events">Sign in</Link>
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
