import Link from "next/link"
import { Badge, EmptyState, Notice, Panel, PanelBody, PanelHeader, Stat, StatRow, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { ChartView } from "@/components/jack/parts/chart-view"
import { PartLink } from "@/components/jack/parts/part-link"
import { chicagoDay } from "@/lib/dates"
import { instagramInsightsConnector } from "@/server/connectors/instagram/connector"
import { instagramAccountDays, instagramInsightsOverview, listPostInsights } from "@/server/queries/instagram-insights"
import { ago, centralDateTime, connectionBadge, dailyDate, formatCount, signed, weekChange } from "../../streams/format"
import type { InstagramSection } from "./types"

const DAY = 86_400_000

/**
 * Insights on Content → Instagram (#188, design §13): the account's daily numbers and each post's,
 * from the snapshots the insights jobs keep (Instagram drops account numbers after 90 days). Officers
 * see it all; switching the connector on happens on System → Connections.
 */
async function InsightsSection() {
  const now = new Date()
  const today = chicagoDay(now)
  const [status, overview, days, posts] = await Promise.all([
    instagramInsightsConnector.status(),
    instagramInsightsOverview(now),
    instagramAccountDays({ from: new Date(today.getTime() - 90 * DAY) }),
    listPostInsights({ limit: 30 }),
  ])
  const badge = connectionBadge(status.state)
  const { followers, week, previousWeek } = overview
  const daysWithNumbers = days.filter((d) => d.reach !== null || d.views !== null)
  const anyData = days.length > 0 || posts.some((p) => p.insightsAt)

  return (
    <Panel>
      <PanelHeader
        title="Insights"
        description="Reach, views and followers, kept here because Instagram drops account numbers after 90 days. Instagram sends each day's numbers up to 2 days late."
        actions={<Badge tone={badge.tone}>{badge.label}</Badge>}
      />
      <PanelBody className="flex flex-col gap-4">
        {status.state !== "connected" && (
          <Notice tone={status.state === "error" ? "danger" : "info"} title={status.state === "error" ? "The last insights sync failed" : "Insights aren't switched on"}>
            {status.state === "error" ? (
              <>{status.lastError}</>
            ) : (
              <>
                The access token above needs Instagram&apos;s insights permission (instagram_business_manage_insights) as well as the basic one: generate it again with both and paste it. Then an admin switches on Instagram insights on{" "}
                <Link href="/admin/connections" className="underline underline-offset-2">
                  System → Connections
                </Link>{" "}
                and its two jobs on{" "}
                <Link href="/admin/jobs" className="underline underline-offset-2">
                  Scheduled jobs
                </Link>
                .
              </>
            )}
          </Notice>
        )}

        {anyData ? (
          <>
            <StatRow className="mb-0">
              <Stat label="Followers" value={formatCount(followers.latest?.followers)} hint={followers.change30 !== null ? `${signed(followers.change30)} in 30 days` : followers.latest ? `As of ${dailyDate(followers.latest.date)}` : undefined} />
              <Stat label="Reach, last 7 days" value={formatCount(week.reach)} hint={weekChange(week.reach, previousWeek.reach) ?? "Daily reach added up"} />
              <Stat label="Views, last 7 days" value={formatCount(week.views)} hint={weekChange(week.views, previousWeek.views) ?? undefined} />
              <Stat label="Interactions, last 7 days" value={formatCount(week.totalInteractions)} hint={weekChange(week.totalInteractions, previousWeek.totalInteractions) ?? undefined} />
              <Stat label="Follows, last 7 days" value={week.follows === null ? "—" : `${signed(week.follows)} / ${signed(week.unfollows === null ? null : -week.unfollows)}`} hint="Follows / unfollows" />
            </StatRow>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {daysWithNumbers.length > 1 ? (
                <ChartView chart={{ type: "line", title: "Reach and views per day", xKey: "date", series: [{ key: "reach", label: "Reach" }, { key: "views", label: "Views" }], rows: daysWithNumbers.map((d) => ({ date: dailyDate(d.date), reach: d.reach, views: d.views })) }} />
              ) : (
                <EmptyState title="No daily numbers yet" description="A day's numbers come in the day after its first snapshot." className="py-6" />
              )}
              {days.length > 1 ? (
                <ChartView chart={{ type: "line", title: "Followers", xKey: "date", series: [{ key: "followers", label: "Followers" }], rows: days.map((d) => ({ date: dailyDate(d.date), followers: d.followers })) }} />
              ) : (
                <EmptyState title="No follower history yet" description="The daily snapshot saves the follower count once a day." className="py-6" />
              )}
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-xs text-admin-subtle">Each post&apos;s lifetime numbers{overview.postsUpdatedAt ? `, last read ${ago(overview.postsUpdatedAt)}` : ""}. Carousels count as one post; stories aren&apos;t included.</p>
              <Table minWidth={760}>
                <THead>
                  <TH>Posted</TH>
                  <TH>Post</TH>
                  <TH className="text-right">Reach</TH>
                  <TH className="text-right">Likes</TH>
                  <TH className="text-right">Comments</TH>
                  <TH className="text-right">Saves</TH>
                  <TH className="text-right">Shares</TH>
                  <TH className="text-right">Views</TH>
                </THead>
                <tbody>
                  {posts.map((post) => (
                    <TR key={post.id}>
                      <TD className="whitespace-nowrap">{centralDateTime(post.postedAt)}</TD>
                      <TD className="max-w-[300px]">
                        <PartLink url={post.permalink} className="line-clamp-1">
                          {post.caption?.trim() || "Untitled post"}
                        </PartLink>
                      </TD>
                      {[post.reach, post.likes, post.comments, post.saved, post.shares, post.views].map((value, i) => (
                        <TD key={i} className="text-right">
                          {value === null ? <span className="text-admin-subtle">—</span> : formatCount(value)}
                        </TD>
                      ))}
                    </TR>
                  ))}
                </tbody>
              </Table>
            </div>
          </>
        ) : (
          <EmptyState title="No insights saved yet" description="Numbers show up here once Instagram insights is switched on and its jobs have run." className="py-6" />
        )}
      </PanelBody>
    </Panel>
  )
}

/** Instagram page sections from the sources-b track */
export const SECTIONS: InstagramSection[] = [{ id: "insights", order: 10, Section: InsightsSection }]
