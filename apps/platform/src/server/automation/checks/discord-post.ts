import { prisma } from "@/server/db"
import type { DigestCheck, DigestItem } from "../types"

/**
 * Digest and Overview "needs attention" checks from the discord-post track (design §11.2): Discord posts
 * that failed (a send Discord refused, or one that couldn't be confirmed) in the last week. Items name
 * the channel and where the post came from, never its text or the error (which can quote Discord).
 */

const WEEK_MS = 7 * 24 * 60 * 60_000
const SOURCE: Record<string, string> = { rule: "a standing rule", proposal: "an applied proposal", admin: "an officer", digest: "the weekly digest" }

export const discordPostsFailed: DigestCheck = {
  id: "discord.posts-failed",
  label: "Discord posts that failed",
  href: "/admin/announcements?view=problems",
  order: 45,
  async run({ now }) {
    const where = { status: "FAILED" as const, createdAt: { gte: new Date(now.getTime() - WEEK_MS) } }
    const [count, posts] = await Promise.all([prisma.discordPost.count({ where }), prisma.discordPost.findMany({ where, orderBy: { createdAt: "desc" }, take: 5, select: { channelId: true, source: true } })])
    if (!count) return { count: 0, severity: "info", items: [] }
    const channels = await prisma.discordChannel.findMany({ where: { id: { in: [...new Set(posts.map((p) => p.channelId))] } }, select: { id: true, name: true } })
    const names = new Map(channels.map((c) => [c.id, c.name]))
    const items: DigestItem[] = posts.map((p) => ({ title: `A post in #${names.get(p.channelId) ?? "a channel"} from ${SOURCE[p.source] ?? "the site"} failed`, href: "/admin/announcements?view=problems", detail: "Check the channel, then retry or cancel it" }))
    return { count, severity: "warning", items }
  },
}

export const CHECKS: DigestCheck[] = [discordPostsFailed]
