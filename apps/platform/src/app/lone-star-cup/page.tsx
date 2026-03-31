import { notFound } from "next/navigation";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import Image from "next/image";
import Link from "next/link";
import { getStandings } from "@/server/queries/standings";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StandingsTable } from "@/components/standings-table";
import { prisma } from "@/server/db";
import { Metadata } from "next";
import { DatabaseUnavailable } from "@/components/database-unavailable";
import { ChampionshipChart } from "@/components/championship-chart";

export const metadata: Metadata = {
  title: "Lone Star Cup",
  description: "The official championship series of Longhorn Sim Racing. Join our welcoming and competitive racing community.",
  alternates: {
    canonical: "/lone-star-cup",
  },
};

// Helper to fetch series with event results for podiums
async function getSeriesWithPodiums(slug: string) {
  return prisma.eventSeries.findUnique({
    where: { slug },
    include: {
      events: {
        orderBy: { startsAtUtc: "asc" },
        include: {
          venue: true,
          ingestedSessions: {
            where: { sessionType: "RACE" },
            take: 1, // Take the main race session
            orderBy: { startedAt: "desc" },
            include: {
              results: {
                orderBy: { position: "asc" },
                take: 3,
                include: {
                  participant: {
                    include: { user: true }
                  }
                }
              }
            }
          }
        }
      }
    }
  });
}

export default async function LoneStarCupPage() {
  let currentSeries, currentStandings, s1Series, s1Standings;
  try {
    [currentSeries, currentStandings, s1Series, s1Standings] = await Promise.all([
      getSeriesWithPodiums("lone-star-cup-s2"),
      getStandings("lone-star-cup-s2"),
      getSeriesWithPodiums("lone-star-cup-s1"),
      getStandings("lone-star-cup-s1"),
    ]);
  } catch (error) {
    console.error('[LoneStarCup] Failed to load series data:', error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <div className="mb-10">
            <h1 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9]">
              Lone Star Cup
            </h1>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-4">Official Championship Series</p>
          </div>
          <DatabaseUnavailable title="Championship Data Unavailable" />
        </div>
      </main>
    );
  }

  // We only strictly require the current series to exist for the page to render meaningfully
  if (!currentSeries) {
    return notFound();
  }

  // Archive structure for extensibility
  const archivedSeasons = [
    { 
      id: "s1", 
      label: "Season 1", 
      series: s1Series, 
      standings: s1Standings 
    }
  ].filter(s => s.series);

  // Logic for Next/Previous Round
  const now = new Date();
  const sortedEvents = currentSeries.events; // Already sorted by ASC date in query
  
  // Find first event in future
  const nextEventIndex = sortedEvents.findIndex(e => new Date(e.startsAtUtc) > now);
  
  const nextEvent = nextEventIndex !== -1 ? sortedEvents[nextEventIndex] : null;
  // Previous is the one before next, OR the last one if no next event (season over)
  const prevEvent = nextEventIndex > 0 ? sortedEvents[nextEventIndex - 1] : (nextEventIndex === -1 && sortedEvents.length > 0 ? sortedEvents[sortedEvents.length - 1] : null);

  const getDriverName = (r: any) => r?.participant?.user?.displayName || r?.participant?.displayName || "TBD";

  // Helper for Prev Event Podium
  const prevResults = prevEvent?.ingestedSessions[0]?.results || [];
  const p1 = prevResults.find(r => r.position === 1);
  const p2 = prevResults.find(r => r.position === 2);
  const p3 = prevResults.find(r => r.position === 3);

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
          <div>
            <h1 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9]">
              Lone Star Cup
            </h1>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-4">Official Championship Series</p>
          </div>
        </div>

        <div className="border border-white/10 bg-white/[0.02] p-1">
          <Image src="/images/LSC26Header2.png" alt="LSC Landscape Banner" width={1200} height={400} className="w-full h-auto object-cover" />
        </div>

        <div className="mt-12 grid grid-cols-1 lg:grid-cols-3 gap-12">
          <div className="lg:col-span-2 space-y-12">
            <section>
              <h2 className="font-display font-black italic text-3xl text-white uppercase tracking-normal mb-6 border-b border-white/10 pb-4">
                Series <span className="text-lsr-orange">Overview</span>
              </h2>
              <div className="prose prose-invert prose-p:font-sans prose-p:text-white/70 prose-p:leading-relaxed max-w-none">
                <p>
                  The Lone Star Cup, not only an introduction to the competitive world of Sim Racing but also a platform to show your skills. This league brings together members of all experience levels, from season veterans to those taking their first turns on a track. Participation in this league involves an entry fee of $10 ($5 if returning league participant) and is meant to help build a community built on sportsmanship and shared passion for the art of racing. You will go head to head in an environment that is built on encouragement and willingness to help newcomers.
                </p>
                <p>&nbsp;</p>
                <p>
                  This season we will take you around 10 tracks, with the final racing being at the Nurburgring or for many The Green Hell. This season we are doing something new with a "Mystery Race" where the track won't be revealed until the DAY OF the race (4/04). Good luck and happy racing.
                </p>
              </div>
            </section>

            <Tabs defaultValue="current" className="w-full">
              <TabsList className="w-full justify-start bg-transparent border-b border-white/10 rounded-none h-auto p-0 gap-8">
                <TabsTrigger value="current" className="rounded-none border-b-2 border-transparent data-[state=active]:border-lsr-orange data-[state=active]:bg-transparent data-[state=active]:text-lsr-orange font-sans font-bold uppercase tracking-widest text-xs px-0 py-4 transition-all">Current Season (S2)</TabsTrigger>
                <TabsTrigger value="history" className="rounded-none border-b-2 border-transparent data-[state=active]:border-lsr-orange data-[state=active]:bg-transparent data-[state=active]:text-lsr-orange font-sans font-bold uppercase tracking-widest text-xs px-0 py-4 transition-all">Archive</TabsTrigger>
              </TabsList>
              
              {/* CURRENT SEASON (S2) */}
              <TabsContent value="current" className="pt-8 outline-none">
                <div className="bg-white/[0.02] border border-white/10 p-6 md:p-8 space-y-12">
                    {/* Dashboard / Next Round */}
                    <div className="grid md:grid-cols-2 gap-8">
                    {/* Previous Round */}
                    <div className="border border-white/10 bg-black/20 p-6 flex flex-col h-full">
                        <h3 className="font-sans font-black text-xs uppercase tracking-[0.2em] text-white/40 mb-4">Previous Round</h3>
                        {prevEvent ? (
                            <div className="space-y-4 flex-1 flex flex-col">
                                <div className="font-sans font-bold text-lg text-white leading-tight">{prevEvent.title}</div>
                                <div className="font-mono text-xs text-lsr-orange">{new Date(prevEvent.startsAtUtc).toLocaleDateString()}</div>
                                
                                {prevResults.length > 0 ? (
                                    <div className="space-y-2 pt-4 border-t border-white/5 mt-auto">
                                        <div className="flex justify-between text-sm items-center">
                                            <span className="text-lsr-orange font-bold w-6">P1</span>
                                            <span className="text-white/80 truncate flex-1 text-right">{p1 ? getDriverName(p1) : "-"}</span>
                                        </div>
                                        <div className="flex justify-between text-sm items-center">
                                            <span className="text-white/40 font-bold w-6">P2</span>
                                            <span className="text-white/80 truncate flex-1 text-right">{p2 ? getDriverName(p2) : "-"}</span>
                                        </div>
                                        <div className="flex justify-between text-sm items-center">
                                            <span className="text-white/40 font-bold w-6">P3</span>
                                            <span className="text-white/80 truncate flex-1 text-right">{p3 ? getDriverName(p3) : "-"}</span>
                                        </div>
                                        <Link href={`/events/${prevEvent.slug}`} className="block w-full text-center bg-white/5 hover:bg-lsr-orange hover:text-white py-2 text-[10px] font-bold uppercase tracking-widest transition-colors mt-4">
                                            View Full Results
                                        </Link>
                                    </div>
                                ) : (
                                    <div className="pt-4 border-t border-white/5 mt-auto">
                                        <p className="text-xs text-white/40 italic">Results pending or unavailable.</p>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="flex-1 flex items-center justify-center border border-dashed border-white/10">
                                <span className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/20">No Previous Race</span>
                            </div>
                        )}
                    </div>
                    
                    {/* Next Round */}
                    <div className="border border-white/10 bg-black/20 p-6 flex flex-col h-full">
                        <h3 className="font-sans font-black text-xs uppercase tracking-[0.2em] text-white/40 mb-4">Next Round</h3>
                        {nextEvent ? (
                            <div className="space-y-4 flex-1">
                                <div className="font-sans font-bold text-lg text-white leading-tight">{nextEvent.title}</div>
                                <div className="font-mono text-xs text-lsr-orange">{new Date(nextEvent.startsAtUtc).toLocaleDateString()}</div>
                                <div className="aspect-video bg-black border border-white/10 relative overflow-hidden group mt-4">
                                    {nextEvent.heroImageUrl ? (
                                        <Image src={nextEvent.heroImageUrl} alt={nextEvent.title} fill className="object-cover opacity-60" />
                                    ) : (
                                        <div className="absolute inset-0 flex items-center justify-center">
                                            <span className="text-[10px] uppercase tracking-widest text-white/20">Track Map Unavailable</span>
                                        </div>
                                    )}
                                </div>
                                <Link href={`/events/${nextEvent.slug}`} className="block w-full text-center bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal py-2 text-[10px] font-bold uppercase tracking-widest transition-colors mt-4">
                                    Event Details
                                </Link>
                            </div>
                        ) : (
                            <div className="flex-1 flex items-center justify-center border border-dashed border-white/10">
                                <span className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/20">Season Completed</span>
                            </div>
                        )}
                    </div>
                    </div>

                    <section>
                    <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal mb-6">
                        Race <span className="text-lsr-orange">Calendar</span>
                    </h3>
                    <Carousel className="w-full">
                        <CarouselContent className="-ml-4">
                        {currentSeries.events.map((event) => {
                            // Extract podium if available (Same logic as archive)
                            const raceSession = event.ingestedSessions[0];
                            const results = raceSession?.results || [];
                            const p1 = results.find(r => r.position === 1);
                            const p2 = results.find(r => r.position === 2);
                            const p3 = results.find(r => r.position === 3);
                            
                            return (
                                <CarouselItem key={event.id} className="pl-4 md:basis-1/2 lg:basis-1/3">
                                <div className="group border border-white/10 bg-black/20 hover:border-lsr-orange/50 transition-colors h-full flex flex-col">
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

                                    {/* Podium Section */}
                                    <div className="p-4 bg-white/[0.02]">
                                        <div className="space-y-2 mb-3">
                                            <div className="flex justify-between items-center text-[10px]">
                                                <span className="font-bold text-lsr-orange w-4">1</span>
                                                <span className="text-white/80 truncate flex-1 text-right">{p1 ? getDriverName(p1) : "TBD"}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-[10px]">
                                                <span className="font-bold text-white/40 w-4">2</span>
                                                <span className="text-white/60 truncate flex-1 text-right">{p2 ? getDriverName(p2) : "TBD"}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-[10px]">
                                                <span className="font-bold text-white/40 w-4">3</span>
                                                <span className="text-white/60 truncate flex-1 text-right">{p3 ? getDriverName(p3) : "TBD"}</span>
                                            </div>
                                        </div>
                                        <Link href={`/events/${event.slug}`} className="block text-[9px] font-bold uppercase tracking-widest text-white/30 hover:text-lsr-orange text-center transition-colors border-t border-white/5 pt-2">
                                            View Results
                                        </Link>
                                    </div>
                                </div>
                                </CarouselItem>
                            );
                        })}
                        </CarouselContent>
                        <div className="flex justify-end gap-2 mt-4">
                        <CarouselPrevious className="static translate-y-0 h-8 w-8 rounded-none border-white/10 hover:bg-lsr-orange hover:border-lsr-orange hover:text-white" />
                        <CarouselNext className="static translate-y-0 h-8 w-8 rounded-none border-white/10 hover:bg-lsr-orange hover:border-lsr-orange hover:text-white" />
                        </div>
                    </Carousel>
                    </section>

                    <section>
                    {currentStandings.length > 0 ? (
                        <StandingsTable 
                            standings={currentStandings} 
                            title="Championship Standings" 
                            infoText="Only users with accounts can be shown on the standings page. Accounts must be manually linked to Assetto Corsa display names. If you are not listed, please create an account and email info@longhornsimracing.org to be added."
                        />
                    ) : (
                        <div className="border border-white/10 bg-black/20 p-12 text-center">
                            <p className="font-sans font-bold text-white/40 uppercase tracking-widest text-sm">No Data to Display Yet</p>
                            <p className="font-sans text-[10px] text-white/20 uppercase tracking-widest mt-2">Standings will populate after the first round</p>
                        </div>
                    )}
                    </section>
                </div>
              </TabsContent>
              
              {/* ARCHIVE (List of Previous Seasons) */}
              <TabsContent value="history" className="pt-8 space-y-12 outline-none">
                {archivedSeasons.length > 0 ? (
                  archivedSeasons.map((season) => (
                    <div key={season.id} className="bg-white/[0.02] border border-white/10 p-6 md:p-8 space-y-10">
                      <div className="flex flex-col md:flex-row md:items-baseline justify-between border-b border-white/10 pb-4 gap-2">
                        <h3 className="font-display font-black italic text-3xl text-white uppercase tracking-normal">
                          {season.label} <span className="text-lsr-orange">Archive</span>
                        </h3>
                        <span className="font-mono text-xs text-white/40 uppercase tracking-widest">{season.series?.title}</span>
                      </div>

                      {/* Race Calendar */}
                      <div className="space-y-4">
                        <h4 className="font-sans font-black text-xs uppercase tracking-[0.2em] text-white/60">Race Calendar</h4>
                        <Carousel className="w-full">
                          <CarouselContent className="-ml-4">
                            {season.series!.events.map((event) => {
                                // Extract podium if available
                                const raceSession = event.ingestedSessions[0];
                                const results = raceSession?.results || [];
                                const p1 = results.find(r => r.position === 1);
                                const p2 = results.find(r => r.position === 2);
                                const p3 = results.find(r => r.position === 3);
                                
                                const getDriverName = (r: any) => r?.participant?.user?.displayName || r?.participant?.displayName || "TBD";

                                return (
                                  <CarouselItem key={event.id} className="pl-4 md:basis-1/2 lg:basis-1/3">
                                    <div className="group border border-white/10 bg-black/20 hover:border-lsr-orange/50 transition-colors h-full flex flex-col">
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

                                      {/* Podium Section */}
                                      <div className="p-4 bg-white/[0.02]">
                                          <div className="space-y-2 mb-3">
                                              <div className="flex justify-between items-center text-[10px]">
                                                  <span className="font-bold text-lsr-orange w-4">1</span>
                                                  <span className="text-white/80 truncate flex-1 text-right">{p1 ? getDriverName(p1) : "TBD"}</span>
                                              </div>
                                              <div className="flex justify-between items-center text-[10px]">
                                                  <span className="font-bold text-white/40 w-4">2</span>
                                                  <span className="text-white/60 truncate flex-1 text-right">{p2 ? getDriverName(p2) : "TBD"}</span>
                                              </div>
                                              <div className="flex justify-between items-center text-[10px]">
                                                  <span className="font-bold text-white/40 w-4">3</span>
                                                  <span className="text-white/60 truncate flex-1 text-right">{p3 ? getDriverName(p3) : "TBD"}</span>
                                              </div>
                                          </div>
                                          <Link href={`/events/${event.slug}`} className="block text-[9px] font-bold uppercase tracking-widest text-white/30 hover:text-lsr-orange text-center transition-colors border-t border-white/5 pt-2">
                                              View Results
                                          </Link>
                                      </div>
                                    </div>
                                  </CarouselItem>
                                );
                            })}
                          </CarouselContent>
                          <div className="flex justify-end gap-2 mt-4">
                            <CarouselPrevious className="static translate-y-0 h-6 w-6 rounded-none border-white/10 hover:bg-lsr-orange hover:border-lsr-orange hover:text-white" />
                            <CarouselNext className="static translate-y-0 h-6 w-6 rounded-none border-white/10 hover:bg-lsr-orange hover:border-lsr-orange hover:text-white" />
                          </div>
                        </Carousel>
                      </div>

                      {/* Standings */}
                      <div className="space-y-4">
                        {season.standings.length > 0 ? (
                            <StandingsTable 
                                standings={season.standings} 
                                title="Final Standings" 
                                infoText="Only users with accounts can be shown on the standings page. Accounts must be manually linked to Assetto Corsa display names. If you are not listed, please create an account and email info@longhornsimracing.org to be added."
                            />
                        ) : (
                            <div className="border border-white/10 bg-black/20 p-8 text-center">
                                <p className="font-sans font-bold text-white/40 uppercase tracking-widest text-xs">No Data Archived</p>
                            </div>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="border border-white/10 bg-white/[0.02] p-12 text-center">
                    <p className="font-sans font-bold text-white/40 uppercase tracking-widest text-sm">No archive data available.</p>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>

          <div className="lg:col-span-1 space-y-12">
            <section>
              <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal mb-6 border-b border-white/10 pb-4">
                Series <span className="text-lsr-orange">Directors</span>
              </h3>
              <div className="space-y-8">
                <div className="group">
                  <div className="relative aspect-square border border-white/10 bg-black overflow-hidden mb-4">
                    <Image src="/images/bryan.jpg" alt="Bryan" fill style={{ objectFit: "cover" }} className="opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500" />
                  </div>
                  <h4 className="font-display font-black italic text-xl text-white uppercase tracking-normal">Bryan Reyes</h4>
                  <p className="font-sans font-bold text-[9px] uppercase tracking-widest text-lsr-orange mb-3">Competitive Lead</p>
                  <p className="font-sans text-xs text-white/60 leading-relaxed">
                    Ever since I was little, I’ve been fascinated with racing. I still remember watching Cars for the first time and instantly wanting to be Lightning McQueen. After gaining 5 years of sim racing experience, I have found that I enjoy coaching and teaching others about racing as much as being on the track.
                  </p>
                </div>

                <div className="group">
                  <div className="relative aspect-square border border-white/10 bg-black overflow-hidden mb-4">
                    <Image src="/images/armando.jpg" alt="Armando" fill style={{ objectFit: "cover" }} className="opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500" />
                  </div>
                  <h4 className="font-display font-black italic text-xl text-white uppercase tracking-normal">Armando Martinez</h4>
                  <p className="font-sans font-bold text-[9px] uppercase tracking-widest text-lsr-orange mb-3">Competitive Officer</p>
                  <p className="font-sans text-xs text-white/60 leading-relaxed">
                    I've spent most of my life racing on a controller and in all honesty am probably better on the controller than on a wheel. Recently getting a wheel has been amazing since the immersion of sim-racing is important. My goal is to teach people about racing and its tricky parts.
                  </p>
                </div>
              </div>
            </section>

            <div className="border border-white/10 p-1 bg-white/[0.02]">
              <Image src="/images/LSCSchedule26.png" alt="LSC Calendar" width={1200} height={800} className="w-full h-auto opacity-80" />
            </div>

            {currentStandings.length > 0 && (
              <ChampionshipChart standings={currentStandings} />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
