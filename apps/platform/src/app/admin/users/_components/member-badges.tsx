import { Badge, type Tone } from "@/components/admin/kit"
import { getStatusIndicators } from "@/lib/status-indicators"
import { cn } from "@/lib/utils"

const INDICATOR_TONE: Record<string, Tone> = {
  officer: "accent",
  partner: "info",
}

const ACCOUNT_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_verification: { label: "Unverified", tone: "warning" },
  retired: { label: "Retired", tone: "neutral" },
  deleted: { label: "Deleted", tone: "danger" },
}

/**
 * The badges a member shows on the site (officer, alumni, partner, LSC driver...), as admin Badges, plus
 * their account status when it isn't active. Uses the same rules as the public pages.
 */
export function MemberBadges({
  roles,
  activeTierKey,
  officerTitle,
  status,
  empty = null,
  className,
}: {
  roles: string[]
  activeTierKey: string | null
  officerTitle: string | null
  status?: string
  /** Shown when there are no badges */
  empty?: React.ReactNode
  className?: string
}) {
  const indicators = getStatusIndicators({ roles, activeTierKey, officerTitle })
  const accountStatus = status ? ACCOUNT_STATUS[status] : undefined
  if (indicators.length === 0 && !accountStatus) return <>{empty}</>

  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {accountStatus && <Badge tone={accountStatus.tone}>{accountStatus.label}</Badge>}
      {indicators.map(({ key, icon: Icon, label }) => (
        <Badge key={key} tone={INDICATOR_TONE[key] ?? "neutral"}>
          <Icon className="size-3" aria-hidden />
          {label}
        </Badge>
      ))}
    </span>
  )
}
