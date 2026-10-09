import Image from "next/image"
import Link from "next/link"
import { Bell, Settings, UserRound } from "lucide-react"
import { RacingNumber, type RacingNumberStyle } from "@/components/racing-number"
import { initials } from "@/app/drivers/names"
import { cn } from "@/lib/utils"

/** The banner across the account pages: who's signed in, and tabs between the account pages. */
export function AccountHeader({
  user,
  active,
  kicker,
}: {
  user: RacingNumberStyle & { displayName: string; handle: string; avatarUrl: string | null; signedUpAt: Date }
  active: "settings" | "notifications"
  kicker: string
}) {
  const tabs = [
    { key: "settings", label: "Settings", href: "/account", icon: Settings },
    { key: "notifications", label: "Notifications", href: "/account/notifications", icon: Bell },
    { key: "profile", label: "Driver page", href: `/drivers/${user.handle}`, icon: UserRound },
  ] as const
  const since = user.signedUpAt.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })

  return (
    <div className="relative overflow-hidden border-b border-white/10 bg-black/25">
      <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />
      <div className="relative mx-auto max-w-5xl px-6 md:px-8 pt-12 md:pt-16">
        <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">{kicker}</p>
        <div className="mt-5 flex items-center gap-5">
          <span className="relative h-16 w-16 shrink-0 overflow-hidden border border-white/15 bg-black md:h-20 md:w-20">
            {user.avatarUrl ? (
              <Image src={user.avatarUrl} alt="" fill sizes="80px" className="object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center font-display font-black italic text-2xl text-white/30">{initials(user.displayName)}</span>
            )}
          </span>
          <div className="min-w-0">
            <h1 className="truncate font-display font-black italic text-4xl md:text-5xl uppercase leading-none text-white">{user.displayName}</h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm text-white/55">
              <span>@{user.handle}</span>
              <span aria-hidden>·</span>
              <span>Member since {since}</span>
              <RacingNumber user={user} size="xs" />
            </p>
          </div>
        </div>
        <nav aria-label="Account" className="-mx-6 mt-8 flex overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:px-0">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const current = tab.key === active
            return (
              <Link
                key={tab.key}
                href={tab.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-3.5 font-sans font-bold text-[11px] uppercase tracking-[0.2em] transition-colors first:pl-0",
                  current ? "border-lsr-orange text-white" : "border-transparent text-white/50 hover:text-white",
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {tab.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </div>
  )
}
