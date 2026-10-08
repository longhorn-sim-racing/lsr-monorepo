import { Calendar, Clock, MapPin, Send } from "lucide-react"
import { LocalTime, LocalTimeRange } from "@/components/ui/local-time"
import Image from "next/image"
import SectionReveal from "./SectionReveal"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { Event, Venue, EventSeries } from "@prisma/client"
import { isEventLive } from "@/lib/events"

type Props = {
  index: number
  featuredEvent?: Event & { venue: Venue | null, series: EventSeries | null }
  upcomingEvents: (Event & { venue: Venue | null, series: EventSeries | null })[]
}

export default function NextEvent({ index, featuredEvent, upcomingEvents }: Props) {
  const nextEventDate = featuredEvent ? new Date(featuredEvent.startsAtUtc) : null
  const nextEventEndDate = featuredEvent ? new Date(featuredEvent.endsAtUtc) : null

  const venue = featuredEvent?.venue
  const directionsUrl = venue?.googleMapsUrl || null
  const featuredIsLive = featuredEvent ? isEventLive(featuredEvent) : false;

  return (
    <SectionReveal index={index} className="mx-auto max-w-6xl" clipClass="rounded-none">
      <div className="rounded-none border-l-4 border-lsr-orange bg-white/[0.03] p-6 md:p-10">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between mb-8">
          <div>
            <h2 className="font-sans font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal">
              The <span className="text-lsr-orange text-outline-sm">Schedule</span>
            </h2>
            {featuredEvent ? (
              <p className="font-sans font-medium text-white/60 mt-2 uppercase tracking-[0.2em] text-xs">
                Next Event: <span className="text-white">{featuredEvent.title}</span>
              </p>
            ) : (
              <p className="font-sans font-medium text-white/60 mt-2 uppercase tracking-[0.2em] text-xs">Schedule is being finalized</p>
            )}
          </div>
          <Button asChild variant="outline" className="border-white/20 hover:bg-white hover:text-lsr-charcoal rounded-none px-8 font-bold uppercase tracking-widest text-xs h-12">
            <Link href="/events">View All Events</Link>
          </Button>
        </div>

        {featuredEvent && nextEventDate && nextEventEndDate && (
          <div className="mt-8 grid md:grid-cols-2 gap-10">
            <div className="flex flex-col justify-center">
              <div className="flex items-stretch gap-3 mb-6 h-6">
                {featuredIsLive && (
                  <div className="flex items-center gap-1.5 border border-red-600/30 bg-red-600/10 px-3 rounded-none">
                      <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-600"></span>
                      </span>
                      <span className="font-display font-black text-red-500 uppercase tracking-widest text-[10px] italic pt-0.5">Live Now</span>
                  </div>
                )}
                {featuredEvent.series && (
                  <div className="flex items-center border border-lsr-orange text-lsr-orange px-3 rounded-none">
                    <span className="text-[10px] font-black uppercase tracking-widest pt-0.5">{featuredEvent.series.title}</span>
                  </div>
                )}
              </div>
              
              <h3 className="font-sans font-bold text-3xl text-white mb-4 leading-tight">{featuredEvent.title}</h3>
              <p className="font-sans text-white/70 mb-8 leading-relaxed">{featuredEvent.summary}</p>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-sm mb-8">
                <div className="space-y-4">
                  <div className="flex items-center gap-3 text-white/90 font-bold uppercase tracking-wider text-[11px]">
                    <Calendar className="h-4 w-4 text-lsr-orange" />
                    <span><LocalTime date={nextEventDate} format="weekday-date" /></span>
                  </div>
                  <div className="flex items-center gap-3 text-white/90 font-bold uppercase tracking-wider text-[11px]">
                    <Clock className="h-4 w-4 text-lsr-orange" />
                    <span>
                      <LocalTimeRange start={nextEventDate} end={nextEventEndDate} />
                    </span>
                  </div>
                </div>
                
                {venue && (
                  <div className="flex items-start gap-3">
                    <MapPin className="h-4 w-4 mt-0.5 text-lsr-orange" />
                    <div>
                      {directionsUrl ? (
                        <Link href={directionsUrl} target="_blank" rel="noopener noreferrer" className="text-white hover:text-lsr-orange font-bold uppercase tracking-wider text-[11px] transition-colors flex items-center gap-1">
                          <span>{venue.name}</span>
                          <Send className="h-3 w-3" />
                        </Link>
                      ) : (
                        <span className="text-white font-bold uppercase tracking-wider text-[11px]">{venue.name}</span>
                      )}
                      <div className="text-[10px] text-white/40 uppercase tracking-widest mt-1">
                        {[venue.city, venue.state].filter(Boolean).join(", ")}
                      </div>
                    </div>
                  </div>
                )}
              </div>
              
              <Button asChild className="bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal rounded-none font-bold uppercase tracking-widest w-fit px-8">
                <Link href={`/events/${featuredEvent.slug}`}>Event Details</Link>
              </Button>
            </div>
            
            <div className="relative group overflow-hidden border border-white/10 bg-black aspect-video">
              {featuredEvent.heroImageUrl ? (
                <>
                  <Image
                    src={featuredEvent.heroImageUrl}
                    alt={featuredEvent.title}
                    width={800}
                    height={600}
                    className="object-cover w-full h-full opacity-80 group-hover:scale-105 group-hover:opacity-100 transition-all duration-700"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                </>
              ) : (
                <div className="flex items-center justify-center h-full bg-white/5 uppercase tracking-[0.2em] text-[10px] text-white/30 font-bold">
                  Track Preview Unavailable
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-12 pt-12 border-t border-white/5">
          <h4 className="font-sans font-bold text-xs text-lsr-orange uppercase tracking-[0.3em] mb-6">Upcoming Events</h4>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {upcomingEvents.length > 0 ? upcomingEvents.slice(0, 4).map((event) => {
              const eventDate = new Date(event.startsAtUtc)
              const live = isEventLive(event);
              return (
                <Link key={event.id} href={`/events/${event.slug}`} className="group block border border-white/5 bg-white/5 p-5 hover:bg-white/10 transition-all">
                  <div className="flex justify-between items-start mb-4 h-5">
                    <div className="flex flex-wrap gap-1 h-full items-center">
                      {live ? (
                        <div className="flex items-center gap-1.5 border border-red-600/30 bg-red-600/10 px-1.5 h-full rounded-none">
                            <span className="relative flex h-1.5 w-1.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-600"></span>
                            </span>
                            <span className="font-display font-black text-red-500 uppercase tracking-widest text-[8px] italic pt-0.5">Live</span>
                        </div>
                      ) : (
                        <div className="text-[10px] font-bold text-white/40 uppercase tracking-widest flex items-center h-full">
                          <LocalTime date={eventDate} format="short-date" />
                        </div>
                      )}
                    </div>
                    {event.series && (
                      <div className="flex items-center text-[8px] font-black text-lsr-orange uppercase tracking-widest border border-lsr-orange/30 px-1.5 h-full rounded-none">
                        <span className="pt-0.5">{event.series.title}</span>
                      </div>
                    )}
                  </div>
                  <div className="font-sans font-bold text-white text-sm group-hover:text-lsr-orange transition-colors line-clamp-2 min-h-[2.5rem]">
                    {event.title}
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-[9px] font-black text-white/30 uppercase tracking-[0.2em] group-hover:text-white transition-colors">Details</span>
                    <div className="h-px flex-1 bg-white/5 mx-3 group-hover:bg-lsr-orange/50 transition-colors" />
                  </div>
                </Link>
              )
            }) : Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="border border-white/5 bg-white/5 p-5 opacity-30">
                <div className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-4">TBD</div>
                <div className="font-sans font-bold text-white text-sm">To Be Announced</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SectionReveal>
  )
}
