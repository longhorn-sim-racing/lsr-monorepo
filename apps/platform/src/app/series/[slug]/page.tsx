import { getSeriesBySlug } from "@/server/queries/series";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
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
import { Metadata } from "next";
import { DatabaseUnavailable } from "@/components/database-unavailable";

type SeriesPageArgs = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: SeriesPageArgs): Promise<Metadata> {
  const { slug } = await params;

  let series;
  try {
    series = await getSeriesBySlug(slug);
  } catch {
    series = null;
  }

  if (!series) {
    return {
      title: "Series",
      alternates: { canonical: `/series/${slug}` },
    };
  }

  const description = `${series.title} — a championship series hosted by Longhorn Sim Racing. Schedule, standings, and race results.`;

  return {
    title: series.title,
    description,
    alternates: { canonical: `/series/${slug}` },
    openGraph: {
      title: series.title,
      description,
      type: "website",
      url: `/series/${slug}`,
    },
    twitter: {
      title: series.title,
      description,
    },
  };
}

export default async function SeriesPage({ params }: SeriesPageArgs) {
  const { slug } = await params;
  let series, standings;
  try {
    [series, standings] = await Promise.all([
      getSeriesBySlug(slug),
      getStandings(slug),
    ]);
  } catch (error) {
    console.error('[Series] Failed to load series:', error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <DatabaseUnavailable title="Series Unavailable" />
        </div>
      </main>
    );
  }

  if (!series) {
    return notFound();
  }

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://www.longhornsimracing.org/" },
      { "@type": "ListItem", position: 2, name: "Series", item: "https://www.longhornsimracing.org/events" },
      { "@type": "ListItem", position: 3, name: series.title, item: `https://www.longhornsimracing.org/series/${series.slug}` },
    ],
  };

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
          <div>
            <h1 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9]">
              {series.title}
            </h1>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-4">Official Championship Series</p>
          </div>
        </div>

        <div className="border border-white/10 bg-white/[0.02] p-1">
          <Image src="/images/lsc-landscape-website-2.png" alt="LSC Landscape Banner" width={1200} height={400} className="w-full h-auto object-cover grayscale-[0.2]" />
        </div>

        <div className="mt-12 grid grid-cols-1 lg:grid-cols-3 gap-12">
          <div className="lg:col-span-2 space-y-12">
            <section>
              <h2 className="font-display font-black italic text-3xl text-white uppercase tracking-normal mb-6 border-b border-white/10 pb-4">
                Series <span className="text-lsr-orange">Manifesto</span>
              </h2>
              <div className="prose prose-invert prose-p:font-sans prose-p:text-white/70 prose-p:leading-relaxed max-w-none">
                <p>
                  The Lone Star Cup is meant as an introduction to the exciting, competitive world of Sim Racing. Designed as a welcoming seed for aspiring racers, this league brings together members of all experience levels, from seasoned veterans to those taking their very first turn on a track. Participation in the league involves an entry fee of $20 with our primary goal being to foster a community built on sportsmanship and shared passion for the art of racing. You’ll find an environment where learning is encouraged and experienced drivers are willing to help newcomers grow. This is more than just a race; it’s a friendly, yet competitive, foundation for your sim racing journey.
                </p>
              </div>
            </section>

            <Tabs defaultValue="season1" className="w-full">
              <TabsList className="w-full justify-start bg-transparent border-b border-white/10 rounded-none h-auto p-0 gap-8">
                <TabsTrigger value="season1" className="rounded-none border-b-2 border-transparent data-[state=active]:border-lsr-orange data-[state=active]:bg-transparent data-[state=active]:text-lsr-orange font-sans font-bold uppercase tracking-widest text-xs px-0 py-4 transition-all">Current Season</TabsTrigger>
                <TabsTrigger value="history" className="rounded-none border-b-2 border-transparent data-[state=active]:border-lsr-orange data-[state=active]:bg-transparent data-[state=active]:text-lsr-orange font-sans font-bold uppercase tracking-widest text-xs px-0 py-4 transition-all">Archives</TabsTrigger>
              </TabsList>
              
              <TabsContent value="season1" className="pt-8 space-y-12 outline-none">
                <div className="grid md:grid-cols-2 gap-8">
                  <div className="border border-white/10 bg-white/[0.02] p-6">
                    <h3 className="font-sans font-black text-xs uppercase tracking-[0.2em] text-white/40 mb-4">Previous Round</h3>
                    <div className="space-y-4">
                      <div className="font-sans font-bold text-lg text-white">Placeholder Track Name</div>
                      <div className="font-mono text-xs text-lsr-orange">YYYY-MM-DD</div>
                      
                      <div className="space-y-2 pt-4 border-t border-white/5">
                        <div className="flex justify-between text-sm">
                          <span className="text-lsr-orange font-bold">P1</span>
                          <span className="text-white/80">Placeholder Driver 1</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-white/40 font-bold">P2</span>
                          <span className="text-white/80">Placeholder Driver 2</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-white/40 font-bold">P3</span>
                          <span className="text-white/80">Placeholder Driver 3</span>
                        </div>
                      </div>
                      
                      <div className="pt-4 mt-2 border-t border-white/5 flex justify-between items-center">
                        <span className="text-[10px] uppercase tracking-widest text-white/40">Fastest Lap</span>
                        <span className="text-xs font-bold text-white">Placeholder Driver 4</span>
                      </div>
                      
                      <a href="#" className="block w-full text-center bg-white/5 hover:bg-lsr-orange hover:text-white py-2 text-[10px] font-bold uppercase tracking-widest transition-colors mt-4">
                        Watch Replay
                      </a>
                    </div>
                  </div>
                  
                  <div className="border border-white/10 bg-white/[0.02] p-6">
                    <h3 className="font-sans font-black text-xs uppercase tracking-[0.2em] text-white/40 mb-4">Next Round</h3>
                    <div className="space-y-4">
                      <div className="font-sans font-bold text-lg text-white">Placeholder Track Name</div>
                      <div className="font-mono text-xs text-lsr-orange">YYYY-MM-DD</div>
                      <div className="aspect-video bg-black/50 border border-white/5 flex items-center justify-center">
                        <span className="text-[10px] uppercase tracking-widest text-white/20">Track Map Unavailable</span>
                      </div>
                    </div>
                  </div>
                </div>

                <section>
                  <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal mb-6">
                    Race <span className="text-lsr-orange">Calendar</span>
                  </h3>
                  <Carousel className="w-full">
                    <CarouselContent className="-ml-4">
                      {series.events.map((event) => (
                        <CarouselItem key={event.id} className="pl-4 md:basis-1/2">
                          <Link
                            href={`/events/${event.slug}`}
                            className="block group border border-white/10 bg-white/[0.02] hover:border-lsr-orange/50 transition-colors"
                          >
                            <div className="relative h-48 bg-black overflow-hidden">
                              {event.heroImageUrl ? (
                                <Image
                                  src={event.heroImageUrl}
                                  alt={event.title}
                                  fill
                                  style={{ objectFit: "cover" }}
                                  className="opacity-60 group-hover:opacity-80 group-hover:scale-105 transition-all duration-500"
                                />
                              ) : (
                                <div className="absolute inset-0 flex items-center justify-center">
                                  <span className="text-[10px] uppercase tracking-widest text-white/20">No Preview</span>
                                </div>
                              )}
                              <div className="absolute top-0 right-0 bg-lsr-orange text-white px-2 py-1 text-[9px] font-black uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">
                                View
                              </div>
                            </div>
                            <div className="p-4">
                              <div className="font-mono text-[10px] text-lsr-orange mb-1">
                                {new Date(event.startsAtUtc).toLocaleDateString()}
                              </div>
                              <h4 className="font-sans font-bold text-sm text-white uppercase tracking-tight truncate">{event.title}</h4>
                            </div>
                          </Link>
                        </CarouselItem>
                      ))}
                    </CarouselContent>
                    <div className="flex justify-end gap-2 mt-4">
                      <CarouselPrevious className="static translate-y-0 h-8 w-8 rounded-none border-white/10 hover:bg-lsr-orange hover:border-lsr-orange hover:text-white" />
                      <CarouselNext className="static translate-y-0 h-8 w-8 rounded-none border-white/10 hover:bg-lsr-orange hover:border-lsr-orange hover:text-white" />
                    </div>
                  </Carousel>
                </section>

                <section>
                  <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal mb-6">
                    Championship <span className="text-lsr-orange">Standings</span>
                  </h3>
                  <div className="overflow-x-auto border border-white/10">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-white/5 font-sans font-black text-[9px] uppercase tracking-widest text-white/40">
                        <tr>
                          <th className="p-4 w-12">Pos</th>
                          <th className="p-4">Driver</th>
                          <th className="p-4">Car</th>
                          <th className="p-4 text-center">Starts</th>
                          <th className="p-4 text-center">Wins</th>
                          <th className="p-4 text-center">Podiums</th>
                          <th className="p-4 text-right">Pts</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5 font-sans text-white/80">
                        {standings.map((standing: { driver: { id: string, name: string }, car: string | undefined, starts: number, wins: number, podiums: number, points: number }, index) => (
                          <tr key={standing.driver.id} className="hover:bg-white/[0.02]">
                            <td className="p-4 font-bold text-white">{index + 1}</td>
                            <td className="p-4 font-bold text-white uppercase tracking-tight">{standing.driver.name}</td>
                            <td className="p-4 text-xs text-white/50 uppercase">{standing.car}</td>
                            <td className="p-4 text-center text-white/50">{standing.starts}</td>
                            <td className="p-4 text-center text-white/50">{standing.wins}</td>
                            <td className="p-4 text-center text-white/50">{standing.podiums}</td>
                            <td className="p-4 text-right font-mono font-bold text-lsr-orange">{standing.points}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </TabsContent>
              
              <TabsContent value="history">
                <div className="border border-white/10 bg-white/[0.02] p-12 text-center">
                  <p className="font-sans font-bold text-white/40 uppercase tracking-widest text-sm">No archive data available.</p>
                </div>
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
                    Ever since I was little, I’ve been fascinated with racing. I still remember watching Cars for the first time and instantly wanting to be Lightning McQueen. After gaining 5 years of racing experience, I have found that I enjoy coaching and teaching others about racing as much as being on the track.
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
              <Image src="/images/lsc-cal.png" alt="LSC Calendar" width={1200} height={800} className="w-full h-auto opacity-80" />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
