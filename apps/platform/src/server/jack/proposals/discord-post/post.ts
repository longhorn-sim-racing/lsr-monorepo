import { z } from "zod"
import type { JackProposalPreview, MdPreviewBlock, MdPreviewInline } from "@/lib/jack/markdown-preview"
import { cleanPostText, linkHost, linksIn, siteHostsOf } from "@/lib/discord/text"
import { CANONICAL_SITE_URL, getSiteUrl } from "@/lib/site-url"
import { createAuditLog } from "@/server/audit/log"
import { prisma } from "@/server/db"
import { messageProblems, type DiscordMessageBody } from "@/server/connectors/discord/write"
import { channelList, findPostingChannel, postingChannelIds, postingChannels } from "@/server/discord-post/channels"
import { officerAskedPing, pollInput, postBody, resolvePing, sendTime, type PollInput } from "@/server/discord-post/compose"
import { discordPosting, discordPostingForPage, NOT_CONNECTED } from "@/server/discord-post/connection"
import { postUrl, queueDiscordPost, readBody, sendPostNow } from "@/server/discord-post/outbox"
import { readRoles } from "@/server/discord-post/role-sync"
import { pingLabel, type PingTarget } from "@/server/discord-post/templates"
import { LOCAL_TIME, when } from "@/server/discord-post/time"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalDiffRow, ProposalKind, ProposalLink } from "../types"
import { ANNOUNCEMENTS_PAGE, listed, officerTexts, plural, refreshAnnouncements } from "./shared"

/**
 * discord.post (design §4.3, §12.1): an announcement or a poll in one of the club server's posting
 * channels, now or at a set time, with an optional ping shown on the card. Template-checked: the text's
 * mentions and outside links come out unless an officer's own message in the room has them (links to
 * the club's site stay), and a ping needs an officer to have asked for it in the room. The card shows
 * the message exactly as it will be posted; Apply posts that (saved as `before`), not a fresh copy.
 * Sent through the outbox: one DiscordPost keyed "proposal:<id>", with its nonce, so a retried Apply
 * never posts twice. Any officer can apply it; it can't be unposted from the site.
 */

export const discordPostSchema = z
  .object({
    channel: z.string().trim().min(1).max(100).describe('The posting channel by name ("announcements") or id. Only channels an admin allowed for posting; the error lists them'),
    text: z.string().trim().max(2000).optional().describe("The message, in Discord Markdown (at most 2,000 characters). Optional with a poll"),
    poll: pollInput.optional().describe("A poll: a question and 2 to 10 answers. Polls can't be edited once posted"),
    ping: z.string().trim().min(1).max(100).optional().describe('A role to ping by name, or "everyone" or "here". Only when an officer asked for that ping in this room'),
    sendAt: z.string().trim().regex(LOCAL_TIME, "Use Central local time like 2026-10-26T18:00").optional().describe("Central local time to post it; leave out to post when applied"),
  })
  .refine((p) => Boolean(p.text?.trim()) || Boolean(p.poll), { message: "Give the text, a poll, or both." })

export type DiscordPostProposal = z.infer<typeof discordPostSchema>

/** What the card showed, and so exactly what Apply posts */
const savedPost = z.object({
  channelId: z.string(),
  channelName: z.string(),
  body: z.record(z.string(), z.unknown()),
  sendAt: z.string().nullable(),
  ping: z.string().nullable(),
})
type SavedPost = z.infer<typeof savedPost>

/** A line of the message for the card: plain text, with links as links (the card shows their host) and channel and role mentions by name */
function inline(line: string, names: Map<string, string>): MdPreviewInline[] {
  const out: MdPreviewInline[] = []
  const pattern = /<(#|@&)(\d{17,20})>|https?:\/\/[^\s<>]+/g
  let last = 0
  for (const m of line.matchAll(pattern)) {
    if (m.index! > last) out.push({ t: "text", v: line.slice(last, m.index) })
    if (m[1]) out.push({ t: "text", v: `${m[1] === "#" ? "#" : "@"}${names.get(m[2]) ?? m[2]}` })
    else out.push({ t: "link", url: m[0], c: [{ t: "text", v: m[0] }] })
    last = m.index! + m[0].length
  }
  if (last < line.length) out.push({ t: "text", v: line.slice(last) })
  return out
}

/** The message as the card previews it */
export function postPreview(body: DiscordMessageBody, names: Map<string, string>): JackProposalPreview {
  const blocks: MdPreviewBlock[] = (body.content ?? "")
    .split(/\n{2,}/)
    .filter((para) => para.trim())
    .map((para) => ({ t: "p", c: para.split("\n").flatMap((line, i): MdPreviewInline[] => (i ? [{ t: "br" }, ...inline(line, names)] : inline(line, names))) }))
  if (body.poll) {
    const hours = body.poll.duration
    blocks.push({ t: "p", c: [{ t: "strong", c: [{ t: "text", v: `Poll: ${body.poll.question.text}` }] }, { t: "text", v: ` (open ${hours % 24 === 0 ? plural(hours / 24, "day") : plural(hours, "hour")}${body.poll.allow_multiselect ? ", several answers allowed" : ""})` }] })
    blocks.push({ t: "list", ordered: false, items: body.poll.answers.map((a) => ({ c: [{ t: "p", c: [{ t: "text", v: a.poll_media.text }] }] })) })
  }
  return { label: "The message, as it will be posted", blocks }
}

/** Channel and role names for the card's preview */
async function mentionNames(text: string, roles: { id: string; name: string }[]): Promise<Map<string, string>> {
  const ids = [...text.matchAll(/<#(\d{17,20})>/g)].map((m) => m[1])
  const channels = ids.length ? await prisma.discordChannel.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
  return new Map([...channels.map((c) => [c.id, c.name] as const), ...roles.map((r) => [r.id, r.name] as const)])
}

function removedSentence(removed: { mentions: string[]; links: string[] }): string | null {
  const parts = [
    removed.links.length ? `${plural(removed.links.length, "link")} (${[...new Set(removed.links.map((l) => linkHost(l) ?? l))].join(", ")})` : null,
    removed.mentions.length ? plural(removed.mentions.length, "mention") : null,
  ].filter((p): p is string => Boolean(p))
  return parts.length ? `Taken out because no officer's message in this room has them: ${listed(parts)}.` : null
}

/** Cleans a poll's words like the text (a poll can't ping, but its words still shouldn't carry outside links) */
function cleanPoll(poll: PollInput | undefined, clean: (text: string) => string): PollInput | undefined {
  if (!poll) return undefined
  return { ...poll, question: clean(poll.question) || poll.question, answers: poll.answers.map((a) => clean(a) || a) }
}

export const discordPostKind: ProposalKind<DiscordPostProposal> = {
  kind: "discord.post",
  tool: "propose_discord",
  description:
    'discord.post: an announcement or a poll in a club Discord posting channel, now or at a Central time. Write it from what the officer asked; mentions and outside links come out unless an officer\'s own message in this room has them (links to the club site stay). ping only when an officer asked for it here. The card shows exactly what will be posted; it can only be deleted in Discord once posted. A newer post for the same channel replaces one still waiting. For the server privacy note, an admin\'s "Copy for Jack" on Announcements gives the text.',
  schema: discordPostSchema,
  targetType: "DISCORD_POST",
  permission: "officer",
  destructive: true,

  async prepare(p, ctx) {
    const now = new Date()
    const posting = await discordPostingForPage()
    if (!posting) throw new ProposalInputError(NOT_CONNECTED)
    const channels = await postingChannels()
    const channel = findPostingChannel(p.channel, channels)
    if (!channel) throw new ProposalInputError(`#${p.channel.replace(/^#/, "")} isn't a posting channel. Posting channels: ${channelList(channels)}.`)
    const time = sendTime(p.sendAt, now)
    if (!time.ok) throw new ProposalInputError(`sendAt: ${time.error}`)

    const officer = await officerTexts(ctx.roomId)
    const siteHosts = siteHostsOf(CANONICAL_SITE_URL, getSiteUrl())
    const removed = { mentions: [] as string[], links: [] as string[] }
    const clean = (text: string) => {
      const cleaned = cleanPostText(text, { officerTexts: officer, siteHosts })
      removed.mentions.push(...cleaned.removed.mentions)
      removed.links.push(...cleaned.removed.links)
      return cleaned.text
    }
    const text = clean(p.text ?? "")
    const poll = cleanPoll(p.poll, clean)
    if (!text && !poll) throw new ProposalInputError("Nothing would be left to post once the mentions and links no officer gave are taken out.")

    let ping: PingTarget | null = null
    let roles: { id: string; name: string }[] = []
    if (p.ping || /<@&\d+>/.test(text)) {
      let live
      try {
        live = await readRoles(posting.client, posting.writer, ctx.signal)
      } catch {
        throw new ProposalInputError("Couldn't read the server's roles from Discord just now. Try again in a minute, or post without a ping.")
      }
      roles = live.roles
      if (p.ping) {
        const resolved = resolvePing(p.ping, { roles: live.roles, mentionEveryone: live.mentionEveryone })
        if (!resolved.ok) throw new ProposalInputError(resolved.error)
        ping = resolved.ping
        if (ping && !officerAskedPing(ping, officer)) throw new ProposalInputError(`No officer asked for a ping of ${pingLabel(ping)} in this room, so the post can't have one. Leave ping out, or ask the officer first.`)
      }
    }

    const body = postBody({ text, poll, ping })
    const problems = messageProblems(body)
    if (problems.length) throw new ProposalInputError(problems.join(" "))

    const names = await mentionNames(body.content ?? "", roles)
    const outside = [...new Set(linksIn(body.content ?? "").filter((l) => !siteHosts.some((h) => linkHost(l) === h || linkHost(l)?.endsWith(`.${h}`))))]
    const diff: ProposalDiffRow[] = [
      { field: "channel", label: "Channel", before: null, after: `#${channel.name}`, format: "value" },
      { field: "ping", label: "Pings", before: null, after: pingLabel(ping) ?? "Nobody", format: "value" },
      { field: "sendAt", label: "Posts", before: null, after: time.at ? when(time.at) : "When applied", format: "value" },
    ]
    const sentences = [
      `Applying it posts ${poll ? "this poll" : "this message"} in #${channel.name} ${time.at ? `at ${when(time.at)}` : "right away"}.`,
      ping ? `It pings ${pingLabel(ping)}.` : "It pings nobody.",
      removedSentence(removed),
      "Once it's posted, only Discord can delete it.",
    ].filter(Boolean)
    const links: ProposalLink[] = [...outside.map((url) => ({ title: "A link in the post", url })), { title: "Announcements", url: ANNOUNCEMENTS_PAGE }]

    return {
      before: { channelId: channel.id, channelName: channel.name, body, sendAt: time.at?.toISOString() ?? null, ping: pingLabel(ping) } satisfies SavedPost,
      targetId: `channel:${channel.id}`,
      view: {
        title: `${poll ? "Post a poll" : "Post"} in #${channel.name}${ping ? `, pinging ${pingLabel(ping)}` : ""}`,
        summary: sentences.join(" "),
        diff,
        links,
        preview: postPreview(body, names),
      },
    }
  },

  async checkStale(p, before) {
    const saved = savedPost.safeParse(before)
    if (!saved.success) return "The proposal's copy of the message is missing. Ask Jack to propose it again."
    if (!(await postingChannelIds()).includes(saved.data.channelId)) return `#${saved.data.channelName} isn't a posting channel anymore.`
    if (saved.data.sendAt && new Date(saved.data.sendAt).getTime() <= Date.now()) return `Its time (${when(new Date(saved.data.sendAt))}) has passed. Ask Jack to propose it again for now or later.`
    return null
  },

  async apply(p, ctx) {
    const saved = savedPost.safeParse(ctx.before)
    const body = saved.success ? readBody(saved.data.body) : null
    if (!saved.success || !body) throw new StaleProposalError("The proposal's copy of the message is missing. Ask Jack to propose it again.")
    const posting = await discordPosting()
    if (!posting) throw new Error(NOT_CONNECTED)
    const { channelId, channelName } = saved.data
    const sendAt = saved.data.sendAt ? new Date(saved.data.sendAt) : null

    const { post, created } = await queueDiscordPost({
      source: "proposal",
      proposalId: ctx.proposalId,
      channelId,
      body,
      scheduledFor: sendAt ?? new Date(),
      dedupeKey: ctx.idempotencyKey,
      createdById: ctx.auditMetadata.proposedFor,
      approvedById: ctx.officer.userId,
    })
    if (created) {
      await createAuditLog({
        actorUserId: ctx.officer.userId,
        actionType: sendAt ? "SCHEDULE" : "CREATE",
        entityType: "DISCORD_POST",
        entityId: post.id,
        summary: `${sendAt ? `Scheduled a Discord post for ${when(sendAt)}` : "Posted"} in #${channelName}${saved.data.ping ? `, pinging ${saved.data.ping}` : ""}, proposed by Jack`,
        after: { channelId, content: (body.content ?? "").slice(0, 500), poll: body.poll?.question.text ?? null, scheduledFor: post.scheduledFor.toISOString() },
        metadata: { ...ctx.auditMetadata, channelId, postId: post.id },
      })
    }
    refreshAnnouncements()
    const announcements = { title: "Announcements", url: ANNOUNCEMENTS_PAGE }

    if (post.status === "SENT") {
      const url = postUrl(post)
      return { summary: `Already posted in #${channelName}; nothing was posted again.`, links: [announcements, ...(url ? [{ title: "The post in Discord", url }] : [])], created: [{ type: "DISCORD_POST", id: post.id }] }
    }
    if (sendAt && post.status === "SCHEDULED") return { summary: `Scheduled for ${when(sendAt)} in #${channelName}.`, links: [announcements], created: [{ type: "DISCORD_POST", id: post.id }] }

    const outcome = await sendPostNow(post.id, posting.writer)
    refreshAnnouncements()
    if (outcome.status === "SENT") {
      const url = postUrl({ channelId, discordMessageId: outcome.messageId })
      return { summary: `Posted in #${channelName}.`, links: [announcements, ...(url ? [{ title: "The post in Discord", url }] : [])], created: [{ type: "DISCORD_POST", id: post.id }] }
    }
    if (outcome.status === "FAILED") throw new Error(`Couldn't post it: ${outcome.error}`)
    if (outcome.status === "SCHEDULED") return { summary: `Discord is rate-limiting the bot; it goes out in #${channelName} within a few minutes (Announcements shows it).`, links: [announcements], created: [{ type: "DISCORD_POST", id: post.id }] }
    return { summary: `It's on its way to #${channelName} (${outcome.reason.replace(/\.$/, "")}); Announcements shows when it's sent.`, links: [announcements], created: [{ type: "DISCORD_POST", id: post.id }] }
  },
}
