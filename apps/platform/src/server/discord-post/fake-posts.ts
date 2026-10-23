import { Prisma, type DiscordPost } from "@prisma/client"

/**
 * Tests only: an in-memory `prisma.discordPost` with the parts of Prisma's API the outbox and the rules
 * use (create with the unique dedupeKey, find, count, conditional updateMany), so the claim, dedupe and
 * cancel logic runs for real without a database. scripts/check-discord-post.ts checks the same against
 * Postgres.
 */

type Where = Record<string, unknown>

function matchValue(value: unknown, filter: unknown): boolean {
  if (filter === undefined) return true
  if (filter === null || typeof filter !== "object" || filter instanceof Date) {
    if (filter instanceof Date) return value instanceof Date && value.getTime() === filter.getTime()
    return value === filter
  }
  const f = filter as Record<string, unknown>
  if ("in" in f && !(f.in as unknown[]).includes(value)) return false
  if ("not" in f && (f.not === null ? value === null : value === f.not)) return false
  if ("startsWith" in f && !(typeof value === "string" && value.startsWith(f.startsWith as string))) return false
  const time = (v: unknown) => (v instanceof Date ? v.getTime() : NaN)
  if ("lte" in f && !(value instanceof Date && time(value) <= time(f.lte))) return false
  if ("lt" in f && !(value instanceof Date && time(value) < time(f.lt))) return false
  if ("gte" in f && !(value instanceof Date && time(value) >= time(f.gte))) return false
  if ("gt" in f && !(value instanceof Date && time(value) > time(f.gt))) return false
  return true
}

export function matches(row: DiscordPost, where: Where = {}): boolean {
  for (const [key, filter] of Object.entries(where)) {
    if (key === "AND") {
      if (!(filter as Where[]).every((w) => matches(row, w))) return false
      continue
    }
    if (key === "OR") {
      if (!(filter as Where[]).some((w) => matches(row, w))) return false
      continue
    }
    if (!matchValue((row as Record<string, unknown>)[key], filter)) return false
  }
  return true
}

function order(rows: DiscordPost[], orderBy: unknown): DiscordPost[] {
  const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
  return [...rows].sort((a, b) => {
    for (const o of list as Record<string, "asc" | "desc">[]) {
      const [key, dir] = Object.entries(o)[0]
      const x = (a as Record<string, unknown>)[key] as Date | null
      const y = (b as Record<string, unknown>)[key] as Date | null
      const d = (x?.getTime() ?? 0) - (y?.getTime() ?? 0)
      if (d) return dir === "asc" ? d : -d
    }
    return 0
  })
}

export function fakePostTable(seed: DiscordPost[] = []) {
  const rows: DiscordPost[] = seed.map((r) => ({ ...r }))
  const copy = (row: DiscordPost | undefined) => (row ? { ...row } : null)
  const table = {
    rows,
    async create({ data }: { data: Partial<DiscordPost> & { id: string } }) {
      if (data.dedupeKey && rows.some((r) => r.dedupeKey === data.dedupeKey)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`dedupeKey`)", { code: "P2002", clientVersion: "test" })
      }
      const row: DiscordPost = {
        source: "rule",
        ruleId: null,
        proposalId: null,
        channelId: "",
        content: {},
        dedupeKey: null,
        nonce: null,
        status: "SCHEDULED",
        scheduledFor: new Date(),
        claimedAt: null,
        sentAt: null,
        discordMessageId: null,
        error: null,
        createdById: null,
        approvedById: null,
        createdAt: new Date(),
        ...data,
      } as DiscordPost
      rows.push(row)
      return { ...row }
    },
    async findUnique({ where }: { where: { id?: string; dedupeKey?: string } }) {
      return copy(rows.find((r) => (where.id ? r.id === where.id : r.dedupeKey === where.dedupeKey)))
    },
    async findUniqueOrThrow(args: { where: { id?: string; dedupeKey?: string } }) {
      const row = await table.findUnique(args)
      if (!row) throw new Error("No DiscordPost found")
      return row
    },
    async findFirst({ where, orderBy }: { where?: Where; orderBy?: unknown } = {}) {
      return copy(order(rows.filter((r) => matches(r, where)), orderBy)[0])
    },
    async findMany({ where, orderBy, take }: { where?: Where; orderBy?: unknown; take?: number } = {}) {
      return order(rows.filter((r) => matches(r, where)), orderBy)
        .slice(0, take ?? Infinity)
        .map((r) => ({ ...r }))
    },
    async count({ where }: { where?: Where } = {}) {
      return rows.filter((r) => matches(r, where)).length
    },
    async updateMany({ where, data }: { where: Where; data: Partial<DiscordPost> }) {
      const hit = rows.filter((r) => matches(r, where))
      for (const row of hit) Object.assign(row, data)
      return { count: hit.length }
    },
  }
  return table
}

export type FakePostTable = ReturnType<typeof fakePostTable>

/** A post row with sensible defaults */
export function postRow(over: Partial<DiscordPost> = {}): DiscordPost {
  return {
    id: over.id ?? `post-${Math.random().toString(36).slice(2, 10)}`,
    source: "rule",
    ruleId: null,
    proposalId: null,
    channelId: "1100000000000000001",
    content: { content: "Hello", allowed_mentions: { parse: [] } },
    dedupeKey: null,
    nonce: "nonce-1",
    status: "SCHEDULED",
    scheduledFor: new Date("2026-10-23T12:00:00Z"),
    claimedAt: null,
    sentAt: null,
    discordMessageId: null,
    error: null,
    createdById: null,
    approvedById: null,
    createdAt: new Date("2026-10-23T11:00:00Z"),
    ...over,
  }
}
