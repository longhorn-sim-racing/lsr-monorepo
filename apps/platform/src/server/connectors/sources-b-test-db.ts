/**
 * TESTS ONLY: the Twitch and Instagram insights tables in memory, answering the Prisma calls the
 * sources-b code makes (the stream lifecycle, the jobs, the webhook), so their tests check what ends up
 * stored rather than which calls were made. Only the where-clause shapes that code uses are understood.
 */

type Row = Record<string, unknown>
type Where = Record<string, unknown>

function compare(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime()
  if (typeof condition !== "object") return value === condition
  const c = condition as Record<string, unknown>
  const v = value as number | Date
  if ("in" in c && !(c.in as unknown[]).some((x) => (x instanceof Date && value instanceof Date ? x.getTime() === value.getTime() : x === value))) return false
  if ("not" in c && compare(value, c.not)) return false
  if ("lt" in c && !(v !== null && v < (c.lt as number | Date))) return false
  if ("lte" in c && !(v !== null && v <= (c.lte as number | Date))) return false
  if ("gt" in c && !(v !== null && v > (c.gt as number | Date))) return false
  if ("gte" in c && !(v !== null && v >= (c.gte as number | Date))) return false
  return true
}

export function matches(row: Row, where: Where | undefined): boolean {
  for (const [key, condition] of Object.entries(where ?? {})) {
    if (key === "NOT") {
      if (matches(row, condition as Where)) return false
    } else if (key === "AND") {
      if (!(condition as Where[]).every((w) => matches(row, w))) return false
    } else if (key === "OR") {
      if (!(condition as Where[]).some((w) => matches(row, w))) return false
    } else if (!compare(row[key], condition)) return false
  }
  return true
}

function pick<T extends Row>(row: T, select?: Record<string, boolean>): Row {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]))
}

function order(rows: Row[], orderBy?: Record<string, "asc" | "desc">): Row[] {
  if (!orderBy) return rows
  const [[key, direction]] = Object.entries(orderBy)
  return [...rows].sort((a, b) => {
    const x = a[key] as number | Date
    const y = b[key] as number | Date
    return (x < y ? -1 : x > y ? 1 : 0) * (direction === "desc" ? -1 : 1)
  })
}

/** One table: rows keyed by `keyOf` */
function table(keyOf: (row: Row) => string, defaults: Row = {}) {
  const rows = new Map<string, Row>()
  return {
    rows,
    all: () => [...rows.values()],
    async createMany({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) {
      let count = 0
      for (const raw of data) {
        const row = { ...defaults, ...raw }
        const key = keyOf(row)
        if (rows.has(key)) {
          if (skipDuplicates) continue
          throw new Error(`Unique constraint failed on ${key}`)
        }
        rows.set(key, row)
        count++
      }
      return { count }
    },
    async findMany({ where, select, orderBy, take }: { where?: Where; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc">; take?: number } = {}) {
      return order(this.all().filter((r) => matches(r, where)), orderBy)
        .slice(0, take ?? Infinity)
        .map((r) => pick(r, select))
    },
    async findFirst(args: { where?: Where; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> } = {}) {
      return (await this.findMany({ ...args, take: 1 }))[0] ?? null
    },
    async findUnique({ where, select }: { where: Where; select?: Record<string, boolean> }) {
      return (await this.findMany({ where, select, take: 1 }))[0] ?? null
    },
    async updateMany({ where, data }: { where?: Where; data: Row }) {
      let count = 0
      for (const row of this.all()) {
        if (!matches(row, where)) continue
        Object.assign(row, data)
        count++
      }
      return { count }
    },
    async update({ where, data }: { where: Where; data: Row }) {
      const row = this.all().find((r) => matches(r, where))
      if (!row) throw new Error("Record to update not found")
      Object.assign(row, data)
      return { ...row }
    },
    async upsert({ where, update, create }: { where: Where; update: Row; create: Row }) {
      const row = this.all().find((r) => matches(r, where))
      if (row) return Object.assign(row, update)
      const created = { ...defaults, ...create }
      rows.set(keyOf(created), created)
      return created
    },
    async deleteMany({ where }: { where?: Where } = {}) {
      let count = 0
      for (const [key, row] of rows) {
        if (!matches(row, where)) continue
        rows.delete(key)
        count++
      }
      return { count }
    },
    async aggregate({ where, _avg, _max }: { where?: Where; _avg?: Record<string, boolean>; _max?: Record<string, boolean> }) {
      const found = this.all().filter((r) => matches(r, where))
      const stat = (fields: Record<string, boolean> | undefined, f: (values: number[]) => number | null) =>
        Object.fromEntries(Object.keys(fields ?? {}).map((k) => [k, found.length ? f(found.map((r) => r[k] as number)) : null]))
      return {
        _avg: stat(_avg, (v) => v.reduce((s, n) => s + n, 0) / v.length),
        _max: stat(_max, (v) => Math.max(...v)),
      }
    },
  }
}

export function fakeSourcesBDb() {
  return {
    twitchStream: table((r) => String(r.id), { endedAt: null, gameName: null, peakViewers: 0, avgViewers: null, vodId: null, vodViews: null, vodViewsAt: null }),
    twitchViewerSample: table((r) => `${r.streamId}@${(r.at as Date).toISOString()}`),
    twitchChannelDaily: table((r) => (r.date as Date).toISOString()),
    twitchEventSubMessage: table((r) => String(r.id), { receivedAt: new Date() }),
    instagramAccountDaily: table((r) => (r.date as Date).toISOString(), { reach: null, views: null, accountsEngaged: null, totalInteractions: null, follows: null, unfollows: null }),
    instagramPost: table((r) => String(r.id), { reach: null, likes: null, comments: null, saved: null, shares: null, views: null, insightsAt: null, hidden: false }),
  }
}

export type FakeSourcesBDb = ReturnType<typeof fakeSourcesBDb>
