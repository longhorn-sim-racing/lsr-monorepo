/**
 * Test helper: an in-memory stand-in for the Prisma calls Jack's room code makes, with the same
 * conditional-update semantics (an updateMany only touches rows its `where` matches at that moment),
 * so the lock and reply loop tests exercise real races between interleaved async calls. Not used by the app.
 */

type Row = Record<string, unknown>
type Where = Record<string, unknown>

export type FakeRoom = {
  id: string
  title: string | null
  persona: "jack" | "lift" | "stand"
  createdById: string | null
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
  runId: string | null
  runStartedAt: Date | null
}

export type FakeMessage = {
  id: string
  roomId: string
  kind: "user" | "assistant" | "system"
  authorUserId: string | null
  persona: "jack" | "lift" | "stand" | null
  content: string
  toolCalls: unknown
  status: "streaming" | "done" | "error"
  streamSeq: number
  answeredById: string | null
  continues?: boolean
  scheduled?: boolean
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  costUsd: number | null
  createdAt: Date
  updatedAt: Date
}

export type FakeUsage = {
  id: string
  roomId: string | null
  persona: "jack" | "lift" | "stand"
  job: string
  outcome: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
  createdAt: Date
}

type Hook = (op: string, args: { where?: Where; data?: Row }) => Promise<void> | void

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((w) => matches(row, w))
    const value = row[key]
    if (condition === null) return value === null || value === undefined
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime()
    if (typeof condition === "object") {
      const c = condition as { lt?: Date; in?: unknown[]; not?: unknown }
      if (c.lt !== undefined) return value instanceof Date && value < c.lt
      if (c.in !== undefined) return c.in.includes(value)
      // SQL's <> is never true for NULL, so `not` skips null the way Postgres does
      if ("not" in c) return value !== null && value !== undefined && value !== c.not
    }
    return value === condition
  })
}

function sortRows<T extends Row>(rows: T[], orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[]): T[] {
  const keys = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : []
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const [field, direction] = Object.entries(key)[0]
      const x = a[field] as Date | string
      const y = b[field] as Date | string
      if (x < y) return direction === "asc" ? -1 : 1
      if (x > y) return direction === "asc" ? 1 : -1
    }
    return 0
  })
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) return row
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))
}

export function createFakeJackDb() {
  let clock = Date.parse("2026-10-12T20:00:00.000Z")
  let ids = 0
  const tick = () => new Date(++clock)

  const state = {
    rooms: [] as FakeRoom[],
    messages: [] as FakeMessage[],
    usage: [] as FakeUsage[],
    users: new Map<string, string>(), // id -> displayName
    /** Runs before each call (awaited), to step in at an exact moment */
    hook: null as Hook | null,
  }

  const withAuthor = (message: FakeMessage, include?: { author?: unknown }) =>
    include?.author
      ? { ...message, author: message.authorUserId ? { displayName: state.users.get(message.authorUserId) ?? "?" } : null }
      : { ...message }

  async function step(op: string, args: { where?: Where; data?: Row }) {
    await state.hook?.(op, args)
    await Promise.resolve() // every call yields, like a real round trip
  }

  const db = {
    state,
    reset() {
      state.rooms = []
      state.messages = []
      state.usage = []
      state.users = new Map()
      state.hook = null
    },
    addRoom(fields: Partial<FakeRoom> = {}): FakeRoom {
      const now = tick()
      const room: FakeRoom = {
        id: `room-${++ids}`,
        title: null,
        persona: "jack",
        createdById: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        runId: null,
        runStartedAt: null,
        ...fields,
      }
      state.rooms.push(room)
      return room
    },
    addMessage(fields: Partial<FakeMessage> & { roomId: string }): FakeMessage {
      const now = tick()
      const message: FakeMessage = {
        id: `msg-${++ids}`,
        kind: fields.persona ? "assistant" : "user",
        authorUserId: null,
        persona: null,
        content: "",
        toolCalls: null,
        status: "done",
        streamSeq: 0,
        answeredById: null,
        continues: false,
        scheduled: false,
        model: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        costUsd: null,
        createdAt: now,
        updatedAt: now,
        ...fields,
      }
      state.messages.push(message)
      return message
    },
    room(id: string) {
      return state.rooms.find((r) => r.id === id)!
    },

    jackRoom: {
      async updateMany({ where, data }: { where: Where; data: Row }) {
        await step("jackRoom.updateMany", { where, data })
        const hits = state.rooms.filter((room) => matches(room, where))
        for (const room of hits) Object.assign(room, data, { updatedAt: tick() })
        return { count: hits.length }
      },
      async update({ where, data }: { where: Where; data: Row }) {
        await step("jackRoom.update", { where, data })
        const room = state.rooms.find((r) => matches(r, where))
        if (!room) throw new Error("Record to update not found")
        Object.assign(room, data)
        return { ...room }
      },
      async findFirst({ where, select }: { where: Where; select?: Record<string, boolean> }) {
        await step("jackRoom.findFirst", { where })
        const room = state.rooms.find((r) => matches(r, where))
        return room ? pick(room, select) : null
      },
      async findUnique(args: { where: Where; select?: Record<string, boolean> }) {
        return db.jackRoom.findFirst(args)
      },
      async findUniqueOrThrow(args: { where: Where; select?: Record<string, boolean> }) {
        const room = await db.jackRoom.findFirst(args)
        if (!room) throw new Error("No JackRoom found")
        return room
      },
    },

    jackMessage: {
      async create({ data, include }: { data: Partial<FakeMessage> & { roomId: string }; include?: { author?: unknown } }) {
        await step("jackMessage.create", { data })
        return withAuthor(db.addMessage(data), include)
      },
      async findMany({ where, orderBy, include, select, take }: {
        where: Where
        orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[]
        include?: { author?: unknown }
        select?: Record<string, boolean>
        take?: number
      }) {
        await step("jackMessage.findMany", { where })
        const rows = sortRows(state.messages.filter((m) => matches(m, where)), orderBy).slice(0, take)
        return rows.map((m) => (select ? pick(m, select) : withAuthor(m, include)))
      },
      async findFirst({ where, select }: { where: Where; select?: Record<string, boolean> }) {
        await step("jackMessage.findFirst", { where })
        const message = state.messages.find((m) => matches(m, where))
        return message ? pick(message, select) : null
      },
      async update({ where, data, include }: { where: Where; data: Row; include?: { author?: unknown } }) {
        await step("jackMessage.update", { where, data })
        const message = state.messages.find((m) => matches(m, where))
        if (!message) throw new Error("Record to update not found")
        Object.assign(message, data, { updatedAt: tick() })
        return withAuthor(message, include)
      },
      async updateMany({ where, data }: { where: Where; data: Row }) {
        await step("jackMessage.updateMany", { where, data })
        const hits = state.messages.filter((m) => matches(m, where))
        for (const message of hits) Object.assign(message, data, { updatedAt: tick() })
        return { count: hits.length }
      },
    },

    jackUsage: {
      async create({ data }: { data: Omit<FakeUsage, "id" | "createdAt"> }) {
        await step("jackUsage.create", { data })
        const row: FakeUsage = { id: `usage-${++ids}`, createdAt: tick(), ...data }
        state.usage.push(row)
        return { ...row }
      },
    },

    async $transaction(work: ((tx: unknown) => Promise<unknown>) | Promise<unknown>[]) {
      return typeof work === "function" ? work(db) : Promise.all(work)
    },
  }

  return db
}

export type FakeJackDb = ReturnType<typeof createFakeJackDb>
