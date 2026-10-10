import Image from "next/image"
import Link from "next/link"
import { ArrowRight, Check, Clock, MapPin, Monitor, Moon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ScheduleEvent } from "@/server/queries/schedule"
import { formatCentsShort } from "@/lib/money"

export function EventTitle({ event }: { event: ScheduleEvent }) {
  if (!event.round) return <>{event.title}</>
  return (
    <>
      {event.round.name} <span className="text-lsr-orange">{event.round.track}</span>
    </>
  )
}

/** The small labels above an event's title */
function Tags({ event }: { event: ScheduleEvent }) {
  const tag = "inline-flex items-center gap-1 px-1.5 py-0.5 font-sans font-bold text-[9px] uppercase tracking-[0.15em]"
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/50 mr-1">{event.series ?? event.family}</span>
      {event.state === "live" && (
        <span className={`${tag} bg-red-600 text-white`}>
          <span className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" /> Live now
        </span>
      )}
      {event.state === "cancelled" && <span className={`${tag} bg-red-900/60 text-red-200`}>Cancelled</span>}
      {event.state === "postponed" && <span className={`${tag} bg-amber-900/50 text-amber-200`}>Postponed</span>}
      {event.viewer === "registered" && (
        <span className={`${tag} bg-emerald-900/50 text-emerald-200`}>
          <Check className="h-2.5 w-2.5" aria-hidden /> You&apos;re in
        </span>
      )}
      {event.viewer === "waitlisted" && <span className={`${tag} bg-white/10 text-white/80`}>Waitlisted</span>}
      {event.round?.night && (
        <span className={`${tag} bg-white/10 text-white/80`}>
          <Moon className="h-2.5 w-2.5" aria-hidden /> {event.round.note}
        </span>
      )}
      {event.round?.final && <span className={`${tag} bg-lsr-orange text-white`}>Finale</span>}
    </div>
  )
}

function Where({ event }: { event: ScheduleEvent }) {
  if (!event.venue) return null
  const Icon = event.online ? Monitor : MapPin
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-lsr-orange" aria-hidden />
      <span className="truncate">
        {event.venue}
        {event.place && !event.online ? ` · ${event.place}` : ""}
      </span>
    </span>
  )
}

/**
 * One upcoming event as a row: date plate, tags, title, time and place, and the action that
 * applies (watch, register, join the waitlist). `titleAs` keeps the heading order right wherever
 * the list sits.
 */
export function AgendaRow({ event, titleAs: Title = "h4" }: { event: ScheduleEvent; titleAs?: "h3" | "h4" }) {
  const off = event.state === "cancelled" || event.state === "postponed"
  const watch = event.state === "live" && !!event.streamUrl
  const register = (event.registration === "open" || event.registration === "waitlist") && !event.viewer
  const note = event.registration === "soon" ? "Registration soon" : event.registration === "full" && !event.viewer ? "Full" : null
  return (
    <li>
      <div
        className={cn(
          "group relative overflow-hidden border transition-colors has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-lsr-orange",
          event.state === "live" ? "border-red-600/60 bg-red-600/[0.06]" : "border-white/10 bg-white/[0.02] hover:border-lsr-orange/50",
        )}
      >
        {event.photo && (
          <div aria-hidden className="absolute inset-y-0 right-0 hidden w-2/5 md:block">
            <Image src={event.photo} alt="" fill sizes="460px" className="object-cover opacity-40 transition-opacity duration-500 group-hover:opacity-60" />
            <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal via-lsr-charcoal/60 to-transparent" />
          </div>
        )}
        <div className="relative grid grid-cols-[60px_minmax(0,1fr)] items-center gap-4 p-4 md:grid-cols-[76px_minmax(0,1fr)_auto] md:gap-6 md:p-5">
          <div className={cn("flex flex-col items-center justify-center border-r border-white/10 pr-4 md:pr-6", off && "opacity-50")}>
            <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange">{event.weekday}</span>
            <span className="font-display font-black italic text-4xl md:text-5xl leading-none text-white">{event.day}</span>
          </div>
          <div className="min-w-0">
            <Tags event={event} />
            <Title className={cn("mt-1.5 font-display font-black italic text-xl md:text-2xl uppercase leading-tight text-white", off && "line-through decoration-white/40")}>
              <Link href={`/events/${event.slug}`} className="outline-hidden after:absolute after:inset-0 group-hover:text-white">
                <EventTitle event={event} />
              </Link>
            </Title>
            <div className="mt-2 flex flex-col gap-1 font-sans text-xs text-white/60 sm:flex-row sm:flex-wrap sm:gap-x-5">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 shrink-0 text-lsr-orange" aria-hidden />
                {event.time}
              </span>
              <Where event={event} />
            </div>
            {event.summary && !event.round && <p className="mt-2 hidden max-w-xl font-sans text-xs text-white/45 line-clamp-1 md:block">{event.summary}</p>}
          </div>
          {/* On phones this sits under the details, and only when there's something to act on */}
          <div
            className={cn(
              "col-span-2 items-center justify-between gap-3 border-t border-white/5 pt-3 md:col-span-1 md:flex md:flex-col md:items-end md:border-0 md:pt-0",
              watch || register || note ? "flex" : "hidden",
            )}
          >
            {watch ? (
              <a
                href={event.streamUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="relative z-10 inline-flex h-9 items-center gap-2 bg-red-600 px-4 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white hover:bg-white hover:text-lsr-charcoal"
              >
                Watch live
              </a>
            ) : register ? (
              <span className="inline-flex h-9 items-center bg-lsr-orange px-4 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white">
                {event.registration === "waitlist" ? "Join waitlist" : `Register${event.feeCents ? ` · ${formatCentsShort(event.feeCents)}` : ""}`}
              </span>
            ) : note ? (
              <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/50">{note}</span>
            ) : (
              <span />
            )}
            <ArrowRight className="h-4 w-4 text-white/40 transition-all group-hover:translate-x-1 group-hover:text-lsr-orange" aria-hidden />
          </div>
        </div>
      </div>
    </li>
  )
}
