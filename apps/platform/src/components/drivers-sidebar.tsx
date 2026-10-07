"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Event, RaceResult, RaceParticipant, Round, Season, EventSeries } from "@prisma/client";
import type { PublicUser } from "@/lib/public-user";

// Define a type that covers the specific data structure we fetch
type SidebarEvent = Event & {
  round: (Round & { season: Season }) | null;
  series: EventSeries | null;
  ingestedSessions: {
    results: (RaceResult & {
      participant: RaceParticipant & {
        user: PublicUser | null;
      };
    })[];
  }[];
};

type DriversSidebarProps = {
  latestEvent: SidebarEvent | null;
  upcomingEvent: SidebarEvent | null;
};

export function DriversSidebar({ latestEvent, upcomingEvent }: DriversSidebarProps) {
  return (
    <div className="space-y-6 md:space-y-8 sticky top-24">
      <Tile 
        title="Latest Results" 
        event={latestEvent} 
        type="latest" 
        emptyMessage="Season data pending"
      />
      <Tile 
        title="Upcoming Race" 
        event={upcomingEvent} 
        type="upcoming" 
        emptyMessage="Season Completed"
      />
    </div>
  );
}

function Tile({ 
  title, 
  event, 
  type, 
  emptyMessage 
}: { 
  title: string; 
  event: SidebarEvent | null; 
  type: "latest" | "upcoming";
  emptyMessage: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const toggle = () => setIsOpen(!isOpen);

  // Derive data
  const session = event?.ingestedSessions?.[0];
  const podium = session?.results || [];
  const seasonName = event?.round?.season?.name || event?.series?.title; 

  return (
    <div className="border border-white/10 bg-white/[0.02] p-4 md:p-6">
      {/* Header - Clickable on Mobile */}
      <div 
        className="flex items-center justify-between mb-0 md:mb-6 cursor-pointer md:cursor-default"
        onClick={toggle}
      >
        <h2 className="font-display font-black italic text-xl md:text-2xl text-white uppercase tracking-normal">
          {title.split(' ')[0]} <span className="text-lsr-orange">{title.split(' ').slice(1).join(' ')}</span>
        </h2>
        
        {/* Mobile Toggle Icon */}
        <div className="md:hidden text-lsr-orange">
          {isOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </div>

        {/* Desktop Divider */}
        <div className="hidden md:block h-px flex-1 bg-white/10 ml-4" />
      </div>

      {/* Content - Collapsible on Mobile */}
      <div className={cn("mt-4 md:mt-0", isOpen ? "block" : "hidden md:block")}>
        {event ? (
          <div className="group border border-white/10 bg-black/20 hover:border-lsr-orange/50 transition-colors flex flex-col relative">
             {/* Season Badge */}
             {seasonName && (
                <div className="absolute top-2 right-2 z-10 bg-lsr-orange text-white text-[9px] font-black uppercase tracking-widest px-2 py-1">
                    {seasonName}
                </div>
             )}

            <Link href={`/events/${event.slug}`} className="block relative h-40 bg-black overflow-hidden shrink-0">
              {event.heroImageUrl ? (
                <Image
                  src={event.heroImageUrl}
                  alt={event.title}
                  fill
                  style={{ objectFit: "cover" }}
                  className="opacity-50 group-hover:opacity-80 transition-all duration-500"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[9px] uppercase tracking-widest text-white/20">No Preview</span>
                </div>
              )}
            </Link>
            
            <div className="p-4 border-b border-white/5 flex-grow">
              <div className="font-mono text-[9px] text-lsr-orange mb-1">
                {new Date(event.startsAtUtc).toLocaleDateString()}
              </div>
              <h4 className="font-sans font-bold text-xs text-white uppercase tracking-tight line-clamp-2">{event.title}</h4>
            </div>

            <div className="p-4 bg-white/[0.02]">
              {type === "latest" && (
                <div className="space-y-2 mb-3">
                  {podium.length > 0 ? (
                    podium.map((result, i) => (
                      <div key={result.id} className="flex justify-between items-center text-[10px]">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn("font-bold w-4", i === 0 ? "text-lsr-orange" : "text-white/40")}>{i + 1}</span>
                          <span className="text-white/80 truncate font-sans font-bold uppercase tracking-tight">
                            {result.participant.user?.displayName || result.participant.displayName}
                          </span>
                        </div>
                        <span className="font-mono text-lsr-orange font-bold ml-2 shrink-0">
                          {result.points ?? 0} PTS
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-2">
                         <span className="font-sans font-bold text-white/20 text-[10px] uppercase tracking-widest">
                             Pending Results
                         </span>
                     </div>
                  )}
                </div>
              )}
              
              {type === "upcoming" && (
                  <div className="mb-3 text-center">
                      <p className="font-sans font-bold text-[10px] text-white/60 uppercase tracking-widest">
                          {event.registrationEnabled ? "Registration Open" : "Coming Soon"}
                      </p>
                  </div>
              )}

              <Link href={`/events/${event.slug}`} className="block text-[9px] font-bold uppercase tracking-widest text-white/30 hover:text-lsr-orange text-center transition-colors border-t border-white/5 pt-2">
                {type === "latest" ? "View All Stats" : "Event Details"}
              </Link>
            </div>
          </div>
        ) : (
          <div className="border border-white/10 bg-black/20 p-12 text-center">
            <p className="font-sans font-bold text-white/40 uppercase tracking-widest text-sm">No Event</p>
            <p className="font-sans text-[10px] text-white/20 uppercase tracking-widest mt-2">{emptyMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
}
