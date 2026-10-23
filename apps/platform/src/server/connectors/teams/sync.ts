import { sleep } from "../google-drive/client"
import { GraphApiError, type GraphClient, type GraphPage } from "../microsoft/graph"
import { messagesPath, toTeamsMessage, type GraphChatMessage } from "./messages"
import type { TeamsStore } from "./store"

/**
 * The Teams reconcile (design §12.8; research/microsoft-graph.md §3e, §5): once a day, each configured
 * channel's messages delta brings our copy in line with Teams, catching anything a change notification
 * missed (Graph sends no "missed" event for chat messages). Microsoft allows polling a channel once a
 * day, so this is the only scheduled read; change notifications do the rest.
 *
 * - A channel's first sync lists its messages with their replies ($expand=replies, 50 threads a page),
 *   then takes a delta link.
 * - Later syncs follow the stored delta link (TeamsChannel.deltaLink). Delta lists thread starts only,
 *   so each changed thread's replies are read again.
 * - Deleted messages lose their text. Channels taken out of MS_CHANNEL_IDS stop syncing and their
 *   messages are deleted.
 * - Calls on one channel are at least a second apart (Graph's limit is one per second per channel).
 * - Resumable: a first listing's position is in the connector's cursor; a delta that runs out of time
 *   keeps the old link and is read again next run (every step is idempotent).
 */

/** ConnectorState.cursor for teams: how far each channel's first listing got (Graph's next-page links, no credentials) */
export type TeamsCursor = { backfill?: Record<string, string> }

export type TeamsSyncCounts = { messages: number; deleted: number; threads: number; channels: number; droppedChannels: number; droppedMessages: number }

export type TeamsSyncOptions = {
  graph: GraphClient
  teamId: string
  channelIds: string[]
  store: TeamsStore
  cursor: TeamsCursor | null | undefined
  signal: AbortSignal
  deadline: number
  saveCursor?: (cursor: TeamsCursor) => Promise<void>
  log?: (line: string) => void
  now?: () => Date
  /** The least time between two calls on one channel (default 1 s; tests pass 0) */
  channelIntervalMs?: number
}

/** Graph's largest page of channel messages */
const PAGE = 50

export async function syncTeams(options: TeamsSyncOptions): Promise<{ cursor: TeamsCursor; counts: TeamsSyncCounts; more: boolean }> {
  const { graph, teamId, channelIds, store, signal, deadline, log = () => {} } = options
  const now = options.now ?? (() => new Date())
  const interval = options.channelIntervalMs ?? 1_000
  const counts: TeamsSyncCounts = { messages: 0, deleted: 0, threads: 0, channels: 0, droppedChannels: 0, droppedMessages: 0 }
  const timeLeft = () => !signal.aborted && Date.now() < deadline
  const cursor: TeamsCursor = structuredClone(options.cursor ?? {})
  cursor.backfill ??= {}
  const save = async () => options.saveCursor?.(cursor)
  const lastCall = new Map<string, number>()
  let more = false

  /** Waits until a second has passed since the last call on this channel */
  async function pace(channelId: string) {
    const wait = (lastCall.get(channelId) ?? 0) + interval - Date.now()
    if (wait > 0) await sleep(wait, signal)
    lastCall.set(channelId, Date.now())
  }

  async function saveOne(message: GraphChatMessage, channelId: string, rootId: string | null, { count = true } = {}) {
    const row = toTeamsMessage(message, channelId, rootId)
    if (!row) return
    await store.saveMessage(row)
    if (!count) return
    if (row.deletedAt) counts.deleted++
    else counts.messages++
  }

  /** A thread's replies after the first page: Graph's next link (from $expand), or the replies list */
  async function saveReplies(channelId: string, rootId: string, first: string) {
    for (let link: string | null = first; link; ) {
      if (!timeLeft()) return false
      await pace(channelId)
      const page: GraphPage<GraphChatMessage> = await graph.page<GraphChatMessage>(link, { signal })
      for (const reply of page.value) await saveOne(reply, channelId, rootId)
      link = page.nextLink
    }
    return true
  }

  async function saveThread(root: GraphChatMessage, channelId: string) {
    counts.threads++
    await saveOne(root, channelId, null)
    for (const reply of root.replies ?? []) await saveOne(reply, channelId, root.id)
    const next = root["replies@odata.nextLink"]
    return next ? saveReplies(channelId, root.id, next) : true
  }

  /** Follows a channel's delta; the new delta link, or null when time ran out (the old link stays) */
  async function runDelta(channelId: string, from: string | null, { replies }: { replies: boolean }): Promise<string | null> {
    const changed: string[] = []
    let deltaLink: string | null = null
    for (let link: string | null = from ?? `${messagesPath(teamId, channelId)}/delta?$top=${PAGE}`; link; ) {
      if (!timeLeft()) return null
      await pace(channelId)
      const page: GraphPage<GraphChatMessage> = await graph.page<GraphChatMessage>(link, { signal })
      for (const root of page.value) {
        // After a first listing, the delta only re-reads what was just saved: not counted twice
        await saveOne(root, channelId, null, { count: replies })
        if (replies && !root.deletedDateTime && !root["@removed"]) changed.push(root.id)
      }
      deltaLink = page.deltaLink
      link = page.nextLink
    }
    for (const rootId of changed) {
      counts.threads++
      if (!(await saveReplies(channelId, rootId, `${messagesPath(teamId, channelId)}/${encodeURIComponent(rootId)}/replies?$top=${PAGE}`))) return null
    }
    return deltaLink
  }

  async function channelName(channelId: string): Promise<string> {
    try {
      await pace(channelId)
      const channel = await graph.get<{ displayName?: string }>(`/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}?$select=id,displayName`, { signal })
      if (channel?.displayName) return channel.displayName.slice(0, 200)
    } catch (error) {
      // Reading a channel's name needs ChannelSettings.Read.Group, which the app may not have: keep what we know
      if (!(error instanceof GraphApiError) || (error.status !== 403 && error.status !== 404)) throw error
    }
    return (await store.channel(channelId))?.name ?? channelId
  }

  for (const channelId of channelIds) {
    if (!timeLeft()) {
      more = true
      break
    }
    await store.saveChannel({ id: channelId, teamId, name: await channelName(channelId) }, now())
    counts.channels++
    const existing = await store.channel(channelId)
    if (!existing?.deltaLink) {
      // The first sync: every thread with its replies, then a delta link
      let link: string | null = cursor.backfill[channelId] ?? `${messagesPath(teamId, channelId)}?$top=${PAGE}&$expand=replies`
      let finished = true
      while (link && link !== "done") {
        if (!timeLeft()) {
          finished = false
          break
        }
        await pace(channelId)
        const page: GraphPage<GraphChatMessage> = await graph.page<GraphChatMessage>(link, { signal })
        for (const root of page.value) {
          if (!(await saveThread(root, channelId))) {
            finished = false
            break
          }
        }
        if (!finished) break
        link = page.nextLink ?? "done"
        cursor.backfill[channelId] = link
        await save()
      }
      if (!finished) {
        more = true
        continue
      }
      // Threads are saved already; this only takes the delta link
      const deltaLink = await runDelta(channelId, null, { replies: false })
      if (!deltaLink) {
        more = true
        continue
      }
      await store.setDeltaLink(channelId, deltaLink, now())
      delete cursor.backfill[channelId]
      await save()
      log(`Synced #${existing?.name ?? channelId} for the first time.`)
      continue
    }
    const deltaLink = await runDelta(channelId, existing.deltaLink, { replies: true })
    if (deltaLink) await store.setDeltaLink(channelId, deltaLink, now())
    else more = true
  }

  for (const id of Object.keys(cursor.backfill)) if (!channelIds.includes(id)) delete cursor.backfill[id]
  const dropped = await store.dropOtherChannels(channelIds)
  counts.droppedChannels = dropped.channels
  counts.droppedMessages = dropped.messages
  if (dropped.channels) log(`Stopped syncing ${dropped.channels} ${dropped.channels === 1 ? "channel" : "channels"} no longer in MS_CHANNEL_IDS, and deleted their ${dropped.messages} messages.`)
  await save()
  return { cursor, counts, more }
}
