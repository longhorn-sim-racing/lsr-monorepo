import type { Metadata } from "next"
import Link from "next/link"
import { Badge, EmptyState, Notice, PageHeader, Pager, Panel, PanelHeader } from "@/components/admin/kit"
import { requireOfficerPage } from "@/server/auth/guards"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { discordConnector } from "@/server/connectors/discord/connector"
import { discordPostingForPage } from "@/server/discord-post/connection"
import { serverPrivacyNote } from "@/server/discord-post/privacy-note"
import { channelsView, listPosts, listRules, pendingDiscordProposals, postCounts, POST_VIEWS, POSTS_PAGE_SIZE, readableText, seriesOptions, type PostListView } from "@/server/discord-post/queries"
import { readRoles } from "@/server/discord-post/role-sync"
import { NewPostButton, type PingOption } from "./_components/compose"
import { PostFilters, PostList } from "./_components/post-list"
import { RulesPanel, type RoleOption } from "./_components/rules-panel"
import { ChannelsPanel, PrivacyNotePanel } from "./_components/side-panels"

export const dynamic = "force-dynamic"

/** An officer's post is sent from this page's action: a slow Discord gets a minute (the same as Connections and Notifications) */
export const maxDuration = 60

export const metadata: Metadata = { title: "Announcements" }

const MAX_PAGE = 1_000

const EMPTY: Record<PostListView, string> = {
  scheduled: "Nothing is waiting to be posted. Rules schedule reminders here, and so do officers' scheduled posts and applied proposals.",
  sent: "Nothing has been posted yet.",
  problems: "No failed or cancelled posts.",
  all: "Nothing has been posted or scheduled yet.",
}

/** The bot's view of the roles, for ping pickers: pingable roles, and @everyone and @here when it may ping them. Nothing while Discord is off or can't be read */
async function pingChoices(): Promise<{ roles: RoleOption[]; pings: PingOption[] }> {
  const posting = await discordPostingForPage()
  if (!posting) return { roles: [], pings: [] }
  const live = await readRoles(posting.client, posting.writer).catch(() => null)
  if (!live) return { roles: [], pings: [] }
  const roles = live.roles
    .filter((r) => r.position > 0 && !r.managed && (r.mentionable || live.mentionEveryone))
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name }))
  const pings: PingOption[] = [...roles.map((r) => ({ value: r.id, label: `@${r.name}` })), ...(live.mentionEveryone ? [{ value: "everyone", label: "@everyone" }, { value: "here", label: "@here" }] : [])]
  return { roles, pings }
}

/**
 * Community → Announcements (#188, design §12.1, §13): what the club's bot posts to Discord. Standing
 * rules, the outbox (scheduled, sent, failed and cancelled posts, with where each came from), posting
 * channels, Discord proposals waiting for an officer, and the server privacy note. Officers see it all,
 * post, cancel, retry and pause rules; admins set up rules and pick the channels.
 */
export default async function AnnouncementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOfficerPage()
  const params = await searchParams
  const one = (key: string) => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }
  const view: PostListView = (POST_VIEWS as readonly string[]).includes(one("view") ?? "") ? (one("view") as PostListView) : "scheduled"
  const pageNumber = Number.parseInt(one("page") ?? "", 10)
  const page = Number.isInteger(pageNumber) && pageNumber > 0 ? Math.min(pageNumber, MAX_PAGE) : 1
  const now = new Date()

  const [session, status, rules, counts, list, pending, channels, note, series, choices] = await Promise.all([
    getCachedSessionUser(),
    discordConnector.status(),
    listRules(),
    postCounts(),
    listPosts(view, page, now),
    pendingDiscordProposals(now),
    channelsView(),
    serverPrivacyNote(),
    seriesOptions(),
    pingChoices(),
  ])
  const isAdmin = session.roles.includes("admin")
  const connected = status.state === "connected" || status.state === "error"
  const allowed = channels.allowed.map((c) => ({ id: c.id, name: c.name }))
  const pageCount = Math.max(1, Math.ceil(list.total / POSTS_PAGE_SIZE))
  const hrefFor = (n: number) => {
    const query = new URLSearchParams()
    if (view !== "scheduled") query.set("view", view)
    if (n > 1) query.set("page", String(n))
    const text = query.toString()
    return text ? `/admin/announcements?${text}` : "/admin/announcements"
  }
  const rulesOn = rules.filter((r) => r.enabled).length
  const noteNames = { channels: new Map(note.channels.map((c) => [c.id, c.name])), roles: new Map<string, string>() }

  return (
    <>
      <PageHeader
        title="Announcements"
        description={`What the club's bot posts to Discord · ${rulesOn} of ${rules.length} ${rules.length === 1 ? "rule" : "rules"} on · ${counts.scheduled} scheduled`}
        actions={connected && allowed.length ? <NewPostButton channels={allowed} pings={choices.pings} /> : undefined}
      />

      {!connected ? (
        <Notice tone={status.state === "off" ? "neutral" : "warning"} title="Discord isn't connected" className="mb-4">
          {status.state === "off" ? "It's set up but switched off" : `It isn't set up yet (missing ${[...status.missingEnv, ...status.missingSettings].join(", ")})`}, so nothing is posted: scheduled posts wait, and are cancelled once they&apos;re 6 hours late. An admin switches it on from{" "}
          <Link href="/admin/connections" className="font-medium text-foreground underline-offset-2 hover:underline">
            Connections
          </Link>
          .
        </Notice>
      ) : !allowed.length ? (
        <Notice tone="warning" title="No posting channels yet" className="mb-4">
          Nothing can be posted until an admin picks the channels the bot may post in (Posting channels, below).
        </Notice>
      ) : null}

      <RulesPanel rules={rules} isAdmin={isAdmin} channels={allowed} roles={choices.roles} series={series} />

      <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel>
          <PanelHeader title="Posts" description="Everything the bot posts goes through here, from rules, Jack's applied proposals and officers. A post is never sent twice." />
          <div className="border-b border-admin-row px-4 py-2.5">
            <PostFilters view={view} counts={counts} />
          </div>
          {list.posts.length ? (
            <>
              <PostList posts={list.posts} />
              {pageCount > 1 && <Pager page={Math.min(page, pageCount)} pageCount={pageCount} hrefFor={hrefFor} summary={`${list.total.toLocaleString("en-US")} posts`} />}
            </>
          ) : (
            <EmptyState title="No posts here" description={EMPTY[view]} />
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader title="Waiting for approval" description="Discord posts and rules Jack proposed. Open the room to apply or discard the card." />
            {pending.length ? (
              <ul className="flex flex-col">
                {pending.map((p) => (
                  <li key={p.id} className="flex flex-col gap-0.5 border-b border-admin-row px-4 py-2.5 last:border-b-0">
                    <Link href={p.href} className="break-words text-[13px] font-semibold hover:underline">
                      {p.title}
                    </Link>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-admin-subtle">
                      <Badge>{p.kind === "discord.rule" ? "Rule (admins apply)" : "Post"}</Badge>
                      {p.when}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing waiting" description="Ask Jack in a room to draft a post or set up a rule; its card shows up here until someone applies or discards it." />
            )}
          </Panel>

          <ChannelsPanel allowed={allowed} choices={channels.choices.map((c) => ({ id: c.id, name: c.name }))} isAdmin={isAdmin} />

          <PrivacyNotePanel text={note.text} readable={readableText(note.text, noteNames)} syncedChannels={note.channels.map((c) => c.name)} channels={connected ? allowed : []} pings={choices.pings} />
        </div>
      </div>

      <p className="mt-4 text-xs text-admin-subtle">
        Role sync and the events mirrored to Discord (with how many members are interested) are on{" "}
        <Link href="/admin/discord" className="underline-offset-2 hover:text-foreground hover:underline">
          Community → Discord
        </Link>
        .
      </p>
    </>
  )
}
