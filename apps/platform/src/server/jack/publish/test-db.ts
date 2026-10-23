import { Prisma } from "@prisma/client"
import { matches } from "@/server/connectors/sources-b-test-db"

/**
 * TESTS ONLY: InstagramPublish in memory, answering the Prisma calls the publish flow makes (claims,
 * conditional updates, the proposal's unique row, the deck page's lock and repeat check in a
 * transaction), plus the few rows it reads around it (the proposal's and the deck's room, the outcome
 * notes), so the tests check what ends up stored.
 */

type Row = Record<string, unknown>
type Where = Record<string, unknown>

export function fakePublishDb(now: () => Date = () => new Date()) {
  const rows = new Map<string, Row>()
  const notes: Row[] = []
  let ids = 0
  const pick = (row: Row, select?: Record<string, boolean>) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row })
  const sorted = (list: Row[], orderBy?: Record<string, "asc" | "desc">) => {
    if (!orderBy) return list
    const [[key, direction]] = Object.entries(orderBy)
    return [...list].sort((a, b) => ((a[key] as number) < (b[key] as number) ? -1 : (a[key] as number) > (b[key] as number) ? 1 : 0) * (direction === "desc" ? -1 : 1))
  }

  const instagramPublish = {
    rows,
    async create({ data }: { data: Row }) {
      if (data.proposalId && [...rows.values()].some((r) => r.proposalId === data.proposalId)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`proposalId`)", { code: "P2002", clientVersion: "test" })
      }
      const at = now()
      const row: Row = { id: `pub-${++ids}`, deckId: null, version: null, slideIds: [], mediaType: "IMAGE", caption: "", imageUrls: [], containerIds: null, status: "queued", claimedAt: null, igMediaId: null, permalink: null, error: null, proposalId: null, createdById: null, approvedById: null, createdAt: at, updatedAt: at, ...data }
      rows.set(row.id as string, row)
      return { ...row }
    },
    async findMany({ where, orderBy, take, select }: { where?: Where; orderBy?: Record<string, "asc" | "desc">; take?: number; select?: Record<string, boolean> } = {}) {
      return sorted([...rows.values()].filter((r) => matches(r, where)), orderBy)
        .slice(0, take ?? Infinity)
        .map((r) => pick(r, select))
    },
    async findUnique({ where, select }: { where: Where; select?: Record<string, boolean> }) {
      return (await this.findMany({ where, select, take: 1 }))[0] ?? null
    },
    async findUniqueOrThrow(args: { where: Where; select?: Record<string, boolean> }) {
      const row = await this.findUnique(args)
      if (!row) throw new Error("No InstagramPublish found")
      return row
    },
    async update({ where, data }: { where: Where; data: Row }) {
      const row = [...rows.values()].find((r) => matches(r, where))
      if (!row) throw new Error("Record to update not found")
      Object.assign(row, data, { updatedAt: now() })
      return { ...row }
    },
    async updateMany({ where, data }: { where?: Where; data: Row }) {
      let count = 0
      for (const row of rows.values()) {
        if (!matches(row, where)) continue
        Object.assign(row, data, { updatedAt: now() })
        count++
      }
      return { count }
    },
    async count({ where }: { where?: Where } = {}) {
      return [...rows.values()].filter((r) => matches(r, where)).length
    },
  }

  const proposals = new Map<string, { roomId: string }>()
  const decks = new Map<string, { roomId: string | null; title: string }>()
  /** The advisory lock keys taken (the deck page's repeat check) */
  const locks: string[] = []
  const db = {
    instagramPublish,
    notes,
    proposals,
    decks,
    locks,
    async $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      return work(db)
    },
    async $executeRaw(_sql: TemplateStringsArray, ...values: unknown[]) {
      locks.push(String(values[0]))
      return 1
    },
    jackProposal: { findUnique: async ({ where }: { where: { id: string } }) => proposals.get(where.id) ?? null },
    jackDeck: { findUnique: async ({ where }: { where: { id: string } }) => decks.get(where.id) ?? null },
    jackMessage: {
      async create({ data }: { data: Row }) {
        const note = { id: `note-${notes.length + 1}`, ...data }
        notes.push(note)
        return note
      },
    },
  }
  return db
}

export type FakePublishDb = ReturnType<typeof fakePublishDb>
