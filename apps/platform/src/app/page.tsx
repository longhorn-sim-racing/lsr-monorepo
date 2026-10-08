import HomePageClient from "@/components/home-page-client"
import { getAllPosts } from "@/lib/news"
import { prisma } from "@/server/db"
import { getNextEventForHomepage } from "@/server/queries/events"
import { getFeaturedGalleryImages } from "@/server/queries/gallery"
import { getSystemSetting, SETTINGS, type HotlapSettings } from "@/lib/email/settings"
import { Event, EventSeries, Venue } from "@prisma/client"
import { Metadata } from "next"
import { publicUserSelect } from "@/lib/public-user"

/** The homepage leaderboard shows this many drivers; only these are sent to the browser. */
const LEADERBOARD_SIZE = 5

export const metadata: Metadata = {
  title: "Longhorn Sim Racing | UT Austin Simulation Racing",
  description: "The official sim racing organization at UT Austin. Compete in competitive leagues, join community events, and connect with fellow motorsports enthusiasts.",
  alternates: {
    canonical: "/",
  },
}

export default async function Home() {
  const [posts, upcomingEventsRaw, galleryImages, drivers, hotlap] = await Promise.all([
    getAllPosts().catch((e) => {
      console.error('[Home] Failed to load posts:', e);
      return [];
    }),
    getNextEventForHomepage().catch((e) => {
      console.error('[Home] Failed to load events:', e);
      return [];
    }),
    getFeaturedGalleryImages().catch((e) => {
      console.error('[Home] Failed to load gallery:', e);
      return [];
    }),
    loadDriverLeaderboard().catch((e) => {
      console.error('[Home] Failed to load drivers:', e);
      return [];
    }),
    getSystemSetting<HotlapSettings>(SETTINGS.HOTLAP).catch((e) => {
      console.error('[Home] Failed to load hotlap:', e);
      return null;
    }),
  ]);

  const featuredEvent = upcomingEventsRaw.length > 0 ? upcomingEventsRaw[0] : null
  const upcomingEvents = upcomingEventsRaw.length > 0 ? upcomingEventsRaw.slice(1) : []

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Longhorn Sim Racing',
    alternateName: 'LSR',
    url: 'https://www.longhornsimracing.org/',
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <HomePageClient
        posts={posts}
        featuredEvent={featuredEvent as Event & { venue: Venue | null; series: EventSeries | null; }}
        upcomingEvents={upcomingEvents as (Event & { venue: Venue | null; series: EventSeries | null; })[]}
        drivers={drivers}
        galleryImages={galleryImages}
        hotlap={hotlap ?? null}
      />
    </>
  )
}

/** Top drivers by all-time points. Public fields only: this goes to a client component. */
async function loadDriverLeaderboard() {
  const rawDrivers = await prisma.user.findMany({
    where: { status: { not: "deleted" } },
    select: publicUserSelect,
  });

  const driverIds = rawDrivers.map(d => d.id);
  const pointsData = await prisma.entry.groupBy({
    by: ['userId'],
    _sum: { totalPoints: true },
    where: { userId: { in: driverIds } }
  });

  const pointsMap = new Map(pointsData.map(p => [p.userId, p._sum.totalPoints || 0]));

  return rawDrivers.map(d => ({
    ...d,
    allTimePoints: pointsMap.get(d.id) || 0
  })).sort((a, b) => {
    if (b.allTimePoints !== a.allTimePoints) return b.allTimePoints - a.allTimePoints;
    return a.displayName.localeCompare(b.displayName);
  }).slice(0, LEADERBOARD_SIZE);
}
