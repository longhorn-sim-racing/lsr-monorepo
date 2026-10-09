import Image from "next/image";
import Link from "next/link";
import { ArrowRight, CalendarDays, Clock, MapPin, Monitor, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ScheduleEvent } from "@/server/queries/schedule";

/** The next (or live) event as a panel, for a hero's right half */
export function NextUp({ event }: { event: ScheduleEvent }) {
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
            <>Next up{event.startsIn ? ` · ${event.startsIn}` : ""}</>
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
        {event.summary && !event.round && <p className="mt-3 font-sans text-sm text-white/60 line-clamp-2">{event.summary}</p>}
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
          ) : (event.registration === "open" || event.registration === "waitlist") && !event.viewer ? (
            <Button asChild className="h-11 rounded-none bg-lsr-orange px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
              <Link href={`/events/${event.slug}`}>{event.registration === "waitlist" ? "Join the waitlist" : "Register"}</Link>
            </Button>
          ) : null}
          <Button asChild className="h-11 rounded-none border border-white/20 bg-transparent px-5 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
            <Link href={`/events/${event.slug}`}>
              {event.viewer === "registered" ? "You're in · Details" : event.viewer === "waitlisted" ? "Waitlisted · Details" : "Event details"}
              <ArrowRight className="ml-2 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </aside>
  );
}
