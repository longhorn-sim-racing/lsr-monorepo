
import Link from 'next/link';
import { User, UserRole, Role, UserMembership, MembershipTier } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBadges } from "@/components/status-indicators";
import { getStatusIndicators, getActiveTierKey } from "@/lib/status-indicators";
import { RacingNumber } from "@/components/racing-number";

type DriverHeroProps = {
  user: User & {
    roles: (UserRole & { role: Role })[];
    memberships: (UserMembership & { tier: MembershipTier })[];
    officerTitle: string | null;
  };
  isOwner: boolean;
  totalRegistrations: number;
};

export function DriverHero({ user, isOwner, totalRegistrations }: DriverHeroProps) {
  const initials = user.displayName
    .split(' ')
    .map(n => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const roleKeys = user.roles.map(r => r.role.key);

  // Membership Logic
  const activeMembership = user.memberships.find(m => !m.validTo || new Date(m.validTo) > new Date());

  // Only non-dues tiers get a label; LSR is dues-optional, so no "Dues Paid" / "Rookie".
  const membershipLabel =
    activeMembership?.tier.key === "ALUMNI"
      ? "ALUMNI"
      : activeMembership?.tier.key === "PARTNER"
        ? activeMembership.tier.label
        : null;

  const getJoinedSeason = (date: Date) => {
    const month = date.getMonth();
    const year = date.getFullYear();
    let season = "Fall";
    if (month >= 0 && month <= 4) season = "Spring";
    else if (month >= 5 && month <= 6) season = "Summer";
    return `${season} ${year}`;
  };

  const membershipInfo = [
    membershipLabel,
    `Joined ${getJoinedSeason(new Date(user.signedUpAt))}`,
    `${totalRegistrations} Event${totalRegistrations === 1 ? '' : 's'}`
  ].filter(Boolean).join(" · ");

  return (
    <div className="border-t-4 border-lsr-orange bg-lsr-charcoal border-b border-l border-r border-white/10 p-6 md:p-12 relative overflow-hidden">
      <div className="absolute top-4 right-4 flex gap-2">
        <div className="h-2 w-2 bg-lsr-orange animate-pulse" />
        <div className="h-2 w-2 bg-white/10" />
        <div className="h-2 w-2 bg-white/10" />
      </div>

      <div className="flex flex-col md:flex-row items-start gap-6 md:gap-12 relative z-10">
        <div className="flex flex-row items-start gap-5 md:gap-12 w-full md:w-auto">
          <div className="h-24 w-24 md:h-40 md:w-40 border border-white/20 bg-black flex-shrink-0 relative">
            <Avatar className="h-full w-full rounded-none">
              <AvatarImage src={user.avatarUrl ?? undefined} className="object-cover" />
              <AvatarFallback className="text-xl md:text-3xl font-black bg-white/5 text-white/20 rounded-none">{initials || 'U'}</AvatarFallback>
            </Avatar>
            <div className="absolute -bottom-2 -right-2 md:-bottom-3 md:-right-3 w-8 h-8 md:w-12 md:h-12 border-b-2 border-r-2 border-lsr-orange" />
          </div>

          <div className="flex-grow pt-0 md:pt-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-2 md:mb-4">
              <span className="bg-white/10 text-white/60 px-1.5 py-0.5 md:px-2 text-[8px] md:text-[9px] font-bold uppercase tracking-widest">
                Driver Profile
              </span>

              {user.status === 'pending_verification' && (
                <span className="bg-red-900/50 text-red-200 border border-red-900 px-1.5 py-0.5 text-[8px] md:text-[9px] font-bold uppercase tracking-widest">
                  Verification Pending
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-baseline gap-x-3 md:gap-x-5 gap-y-1 mb-1 md:mb-2">
              <RacingNumber user={user} size="xl" />
              <h1 className="font-display font-black italic text-3xl sm:text-4xl md:text-7xl text-white uppercase tracking-normal leading-[0.9] md:leading-[0.85] min-w-0 break-words">
                {user.displayName}
              </h1>
            </div>
            <p className="font-mono text-lsr-orange text-xs md:text-base tracking-widest truncate">@{user.handle}</p>

            {/* Desktop Badges + Membership Info */}
            <div className="hidden md:flex flex-row items-center gap-6 mt-6">
              <StatusBadges
                indicators={getStatusIndicators({
                  roles: roleKeys,
                  activeTierKey: getActiveTierKey(user.memberships),
                  officerTitle: user.officerTitle,
                })}
              />

              <span className="font-sans font-bold text-[9px] text-lsr-orange/80 uppercase tracking-[0.2em]">
                {membershipInfo}
              </span>
            </div>
          </div>
        </div>

        {/* Mobile Badges + Membership Info (Full Width) */}
        <div className="md:hidden w-full space-y-4 mt-6 pt-6 border-t border-white/5">
          <StatusBadges
            indicators={getStatusIndicators({
              roles: roleKeys,
              activeTierKey: getActiveTierKey(user.memberships),
              officerTitle: user.officerTitle,
            })}
          />

          <p className="font-sans font-bold text-[8px] text-lsr-orange/80 uppercase tracking-[0.2em] leading-relaxed">
            {membershipInfo}
          </p>
        </div>

        {isOwner && (
          <div className="hidden md:block absolute top-0 right-0 p-8 z-20">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    asChild
                    size="sm"
                    className={cn(
                      "rounded-none font-bold uppercase tracking-widest text-[10px] h-10 transition-all border-0",
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
    </div>
  );
}
