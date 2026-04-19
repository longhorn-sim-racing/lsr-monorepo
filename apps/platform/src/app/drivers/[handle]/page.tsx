import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getOwnerStatus } from '@/lib/owner';
import { getDriverStats } from "@/server/queries/drivers";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { getUpcomingRegistrations } from "@/server/queries/events";
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// New Components
import { DriverHero } from '@/components/drivers/profile/driver-hero';
import { DriverIdentityStrip } from '@/components/drivers/profile/driver-identity-strip';
import { DriverParticipation } from '@/components/drivers/profile/driver-participation';
import { DriverPerformance } from '@/components/drivers/profile/driver-performance';
import { DriverEventHistory } from '@/components/drivers/profile/driver-event-history';
import { DriverMetadata } from '@/components/drivers/profile/driver-metadata';
import { Metadata } from 'next';
import { DatabaseUnavailable } from '@/components/database-unavailable';

export const revalidate = 60;

export async function generateMetadata({
  params,
}: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;

  let stats;
  try {
    stats = await getDriverStats(handle);
  } catch {
    stats = null;
  }

  if (!stats?.user) {
    return {
      title: "Driver",
      alternates: { canonical: `/drivers/${handle}` },
    };
  }

  const { user } = stats;
  const description =
    user.bio?.slice(0, 155) ||
    `${user.displayName} — driver profile, race history, and stats with Longhorn Sim Racing at UT Austin.`;

  return {
    title: user.displayName,
    description,
    alternates: { canonical: `/drivers/${handle}` },
    openGraph: {
      title: user.displayName,
      description,
      type: "profile",
      url: `/drivers/${handle}`,
    },
    twitter: {
      title: user.displayName,
      description,
    },
  };
}

export default async function DriverProfilePage({
  params,
}: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;

  let stats;
  try {
    stats = await getDriverStats(handle);
  } catch (error) {
    console.error('[DriverProfile] Failed to load driver:', error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <DatabaseUnavailable title="Driver Profile Unavailable" />
        </div>
      </main>
    );
  }

  if (!stats) return notFound();

  const { user, currentSeason, allTime, history, eventHistory } = stats;
  if (user.status === 'deleted') return notFound();

  let isOwner = false;
  let isMe = false;
  let upcomingRegistrations: Awaited<ReturnType<typeof getUpcomingRegistrations>> = [];
  try {
    ({ isOwner } = await getOwnerStatus(user.id));
    const { user: sessionUser } = await getCachedSessionUser();
    isMe = sessionUser?.id === user.id;
    if (isMe) upcomingRegistrations = await getUpcomingRegistrations(user.id);
  } catch {
    // Non-critical — render profile without ownership/registration features
  }
  const socials = (user.socials as Record<string, string> | null) ?? {};

  const personJsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: user.displayName,
    alternateName: `@${user.handle}`,
    url: `https://www.longhornsimracing.org/drivers/${user.handle}`,
    image: user.avatarUrl || undefined,
    description: user.bio || undefined,
    memberOf: {
      "@type": "SportsOrganization",
      name: "Longhorn Sim Racing",
      url: "https://www.longhornsimracing.org",
    },
    sameAs: Object.values(socials).filter((v): v is string => typeof v === "string" && v.length > 0),
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://www.longhornsimracing.org/" },
      { "@type": "ListItem", position: 2, name: "Drivers", item: "https://www.longhornsimracing.org/drivers" },
      { "@type": "ListItem", position: 3, name: user.displayName, item: `https://www.longhornsimracing.org/drivers/${user.handle}` },
    ],
  };

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">

        <div className="flex items-center justify-between mb-8">
          <Link href="/drivers" className="group inline-flex items-center gap-3 text-[10px] font-sans font-bold uppercase tracking-[0.25em] text-lsr-orange hover:text-white transition-colors">
            <div className="h-px w-8 bg-lsr-orange/30 group-hover:bg-white group-hover:w-12 transition-all" />
            Back to Drivers
          </Link>
          
          {isOwner && (
            <div className="md:hidden">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      asChild
                      size="sm"
                      className={cn(
                        "rounded-none font-bold uppercase tracking-widest text-[10px] h-8 transition-all border-0",
                        "bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal",
                        !user.bio && "relative overflow-hidden"
                      )}
                    >
                      <Link href={`/drivers/${user.handle}/edit`}>
                        <span className="relative z-10">Edit Profile</span>
                        {!user.bio && (
                          <span className="absolute inset-0 animate-shine bg-gradient-to-r from-transparent via-white/50 to-transparent" />
                        )}
                      </Link>
                    </Button>
                  </TooltipTrigger>
                  {!user.bio && (
                    <TooltipContent className="bg-lsr-orange text-white border-none rounded-none text-xs font-bold uppercase tracking-wider">
                      <p>Complete your profile to stand out on the grid!</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </div>
          )}
        </div>

        {/* 1. HERO: IDENTITY */}
        <DriverHero user={user} isOwner={isOwner} totalRegistrations={stats.totalRegistrations} />

        {/* 2. HUMAN IDENTITY STRIP */}
        <DriverIdentityStrip user={user} />

        {/* 3. PARTICIPATION (Private / Owner Only) */}
        <DriverParticipation isMe={isMe} upcomingRegistrations={upcomingRegistrations} />

        {/* 4. PERFORMANCE CORE */}
        <DriverPerformance 
            history={history} 
            allTime={allTime} 
            currentSeason={currentSeason} 
        />

        {/* 5. EVENT HISTORY */}
        <DriverEventHistory eventHistory={eventHistory} />

        {/* 6. METADATA / LINKS */}
        <DriverMetadata socials={socials} iRating={user.iRating} />

      </div>
    </main>
  );
}
