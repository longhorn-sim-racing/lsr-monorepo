import Link from "next/link"
import { ExternalLink } from "lucide-react"
import { Badge, EmptyState, Panel, PanelBody, PanelHeader } from "@/components/admin/kit"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { discordPostingForPage } from "@/server/discord-post/connection"
import { mirroredEvents, roleSyncView, ruleSummary } from "@/server/discord-post/queries"
import { readRoleSafety, ROLE_CONDITIONS } from "@/server/discord-post/role-sync"
import { RoleSyncPanel } from "../_post/role-sync-panel"
import type { DiscordSection } from "./types"

/** The server's roles and channel overwrites as the bot sees them, or null while Discord is off or can't be read */
async function liveRoles() {
  const posting = await discordPostingForPage()
  if (!posting) return null
  return readRoleSafety(posting.client, posting.writer).catch(() => null)
}

/** Role sync rules: which Discord role linked members get, and when (admins change them) */
async function RoleSyncSection() {
  const [session, live] = await Promise.all([getCachedSessionUser(), liveRoles()])
  const view = await roleSyncView(live)
  const conditions = Object.entries(ROLE_CONDITIONS).map(([value, c]) => ({ value, label: c.label, description: c.description }))
  return <RoleSyncPanel view={view} conditions={conditions} isAdmin={session.roles.includes("admin")} />
}

/** Events the event mirror put on Discord's Events list, with how many members are interested */
async function DiscordEventsSection() {
  const { events, mirrorOn } = await mirroredEvents()
  if (!events.length && !mirrorOn) return null
  return (
    <Panel>
      <PanelHeader title="Events on Discord" description="Public events the event mirror added to the server's Events list, with how many members marked themselves interested (read every 15 minutes)." />
      {events.length ? (
        <ul className="flex flex-col">
          {events.map((event) => (
            <li key={event.eventId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-admin-row px-4 py-2.5 last:border-b-0">
              <span className="flex min-w-0 flex-col">
                <Link href={`/admin/events/${event.eventId}/manage`} className="truncate text-[13px] font-semibold hover:underline">
                  {event.title}
                </Link>
                <span className="text-xs text-admin-subtle">
                  {event.starts}
                  {event.past ? " · over" : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <Badge tone={event.interested ? "info" : "neutral"}>{event.interested === null ? "No count yet" : `${event.interested} interested`}</Badge>
                {event.discordUrl && (
                  <a href={event.discordUrl} target="_blank" rel="noreferrer" className="text-admin-subtle hover:text-foreground" aria-label={`Open ${event.title} in Discord`}>
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing mirrored yet" description="The event mirror adds upcoming public events on its next run (every 15 minutes)." />
      )}
    </Panel>
  )
}

/** A line on what posts to Discord, pointing at Announcements */
async function PostingSummarySection() {
  const summary = await ruleSummary()
  return (
    <Panel>
      <PanelHeader title="Posting to Discord" description="Standing rules, scheduled posts and the posting channels are on Community → Announcements." />
      <PanelBody className="flex flex-col gap-2 text-[13px]">
        {summary.on.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
            {summary.on.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No standing rules are on.</p>
        )}
        <p className="text-xs text-admin-subtle">
          {summary.off ? `${summary.off} more ${summary.off === 1 ? "rule is" : "rules are"} off · ` : ""}
          {summary.scheduled} {summary.scheduled === 1 ? "post" : "posts"} scheduled ·{" "}
          <Link href="/admin/announcements" className="font-medium text-foreground underline-offset-2 hover:underline">
            Announcements
          </Link>
        </p>
      </PanelBody>
    </Panel>
  )
}

/**
 * Discord page sections from the discord-post track (T8): role-sync rules, the events mirrored to
 * Discord with their interested counts, and a summary of what posts, with a link to Community →
 * Announcements.
 */
export const SECTIONS: DiscordSection[] = [
  { id: "role-sync", order: 10, Section: RoleSyncSection },
  { id: "discord-events", order: 20, Section: DiscordEventsSection },
  { id: "posting-summary", order: 30, Section: PostingSummarySection },
]
