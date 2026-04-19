import { prisma } from '@/server/db';
import { DriversFilters } from '@/components/drivers-filters';
import { DriversSearch } from '@/components/drivers-search';
import { DriversTable } from '@/components/drivers-table';
import { DriversSidebar } from '@/components/drivers-sidebar';
import { Metadata } from 'next';
import { DatabaseUnavailable } from '@/components/database-unavailable';

export const metadata: Metadata = {
  title: "Driver Roster",
  description: "Official entry list and driver profiles for Longhorn Sim Racing.",
  alternates: {
    canonical: "/drivers",
  },
};

// ISR: regenerate at most once per day. Mutating actions (new signup,
// profile edit, results ingestion, etc.) call revalidatePath('/drivers')
// to invalidate sooner — see src/server/cache/revalidate-public.ts.
export const revalidate = 86400;

export default async function DriversIndexPage() {
  try {
    return await renderDriversPage();
  } catch (error) {
    console.error('[Drivers] Failed to load drivers:', error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <div className="mb-10">
            <h1 className="font-display font-black italic text-5xl md:text-6xl text-white uppercase tracking-normal">
              Driver <span className="text-lsr-orange">Roster</span>
            </h1>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-2">Official Entry List</p>
          </div>
          <DatabaseUnavailable title="Roster Unavailable" />
        </div>
      </main>
    );
  }
}

async function renderDriversPage() {
  const allDrivers = await prisma.user.findMany({
    where: {
      status: { not: 'deleted' },
    },
    include: {
      roles: { include: { role: true } },
      memberships: { include: { tier: true } }
    },
  });

  // Calculate All Time Points
  const driverIds = allDrivers.map(d => d.id);
  const pointsData = await prisma.entry.groupBy({
    by: ['userId'],
    _sum: { totalPoints: true },
    where: { userId: { in: driverIds } }
  });

  const pointsMap = new Map(pointsData.map(p => [p.userId, p._sum.totalPoints || 0]));

  // Sort by All Time Points Descending to assign Rank
  const rankedDrivers = allDrivers.map(d => ({
    ...d,
    allTimePoints: pointsMap.get(d.id) || 0
  })).sort((a, b) => {
    if (b.allTimePoints !== a.allTimePoints) return b.allTimePoints - a.allTimePoints;
    return a.displayName.localeCompare(b.displayName);
  }).map((d, index) => ({
    ...d,
    rank: index + 1
  }));

  const now = new Date();

  // Fetch Latest Result Event
  const latestEvent = await prisma.event.findFirst({
    where: {
      ingestedSessions: {
        some: {
          sessionType: "RACE",
          results: { some: {} }
        }
      }
    },
    orderBy: { startsAtUtc: 'desc' },
    include: {
      series: true,
      round: { include: { season: true } },
      ingestedSessions: {
        where: { sessionType: "RACE" },
        orderBy: { startedAt: 'desc' },
        take: 1,
        include: {
          results: {
            orderBy: { position: 'asc' },
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
  });

  // Fetch Upcoming Event
  const upcomingEvent = await prisma.event.findFirst({
    where: {
      startsAtUtc: { gt: now },
      status: { notIn: ["DRAFT", "CANCELLED"] },
      series: {
        slug: { contains: "lone-star-cup" }
      }
    },
    orderBy: { startsAtUtc: 'asc' },
    include: {
      series: true,
      round: { include: { season: true } },
      ingestedSessions: {
        // Included to satisfy type, returns empty usually
        include: { results: { include: { participant: { include: { user: true } } } } }
      }
    }
  });

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
          <div>
            <h1 className="font-display font-black italic text-5xl md:text-6xl text-white uppercase tracking-normal">
              Driver <span className="text-lsr-orange">Roster</span>
            </h1>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-2">Official Entry List</p>
          </div>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <DriversSearch />
            <DriversFilters />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-1">
            <DriversSidebar latestEvent={latestEvent} upcomingEvent={upcomingEvent} />
          </div>

          <div className="md:col-span-2">
            <DriversTable drivers={rankedDrivers} />
          </div>
        </div>
      </div>
    </main>
  );
}
