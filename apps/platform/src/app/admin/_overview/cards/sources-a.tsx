import { formatInTimeZone } from "date-fns-tz"
import { ArrowDownRight, ArrowUpRight } from "lucide-react"
import { Panel, PanelHeader } from "@/components/admin/kit"
import { siteTrafficConnector } from "@/server/connectors/site-traffic/connector"
import { percentChange, trafficWeek } from "@/server/connectors/site-traffic/read"
import { cn } from "@/lib/utils"
import type { OverviewCard } from "./types"

/** "Oct 15" for a UTC day */
const utcDay = (day: string) => formatInTimeZone(new Date(`${day}T00:00:00.000Z`), "UTC", "MMM d")

function Change({ current, previous }: { current: number; previous: number | undefined }) {
  const change = previous === undefined ? null : percentChange(current, previous)
  if (change === null) return <span className="text-xs text-admin-subtle">No week before to compare</span>
  const up = change >= 0
  const Icon = up ? ArrowUpRight : ArrowDownRight
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-semibold", up ? "text-tone-success-foreground" : "text-tone-warning-foreground")}>
      <Icon className="size-3.5" aria-hidden />
      {up ? "+" : ""}
      {change}% <span className="font-normal text-admin-subtle">vs the week before</span>
    </span>
  )
}

/**
 * Site traffic on the Overview (Jack 2.0 sources-a, design §13): the latest 7 snapshot days against
 * the 7 before, and the top pages. Nothing shows until a snapshot exists (no "not connected" card on
 * the Overview; System → Connections says that).
 */
async function SiteTrafficCard() {
  const [week, status] = await Promise.all([trafficWeek(), siteTrafficConnector.status()])
  if (!week) return null
  const off = status.state === "off" ? " · the connection is switched off" : status.state === "error" ? " · the last snapshot failed" : ""

  return (
    <Panel className="flex flex-col">
      <PanelHeader title="Site traffic" description={`${utcDay(week.from)} to ${utcDay(week.to)} (UTC days), public pages${off}`} />
      <div className="grid grid-cols-2 gap-px border-b border-admin-row bg-admin-row">
        <div className="flex min-w-0 flex-col gap-0.5 bg-card px-4 py-3">
          <span className="text-xs font-medium text-muted-foreground">Page views</span>
          <span className="text-xl font-semibold tabular-nums">{week.current.pageviews.toLocaleString()}</span>
          <Change current={week.current.pageviews} previous={week.previous?.pageviews} />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 bg-card px-4 py-3">
          <span className="text-xs font-medium text-muted-foreground" title="Vercel counts a visitor once a day, so this is the average a day">
            Visitors a day
          </span>
          <span className="text-xl font-semibold tabular-nums">{week.current.visitorsPerDay.toLocaleString()}</span>
          <Change current={week.current.visitorsPerDay} previous={week.previous?.visitorsPerDay} />
        </div>
      </div>
      {week.topPages.length ? (
        <ul className="flex flex-col">
          {week.topPages.map((page) => (
            <li key={page.key} className="flex items-center gap-3 border-b border-admin-row px-4 py-2 text-[13px] last:border-b-0">
              {page.key.startsWith("/") ? (
                <a href={page.key} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-medium hover:underline">
                  {page.key}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate font-medium">{page.key}</span>
              )}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{page.pageviews.toLocaleString()} views</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-5 text-[13px] text-muted-foreground">No page views in these days.</p>
      )}
    </Panel>
  )
}

/** Overview cards from the sources-a track. The registry joins every track's cards and sorts them by order */
export const CARDS: OverviewCard[] = [{ id: "site-traffic", order: 30, Card: SiteTrafficCard }]
