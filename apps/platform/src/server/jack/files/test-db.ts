/**
 * Test helper: an in-memory stand-in for the Prisma calls the room-file code makes (JackFile and
 * JackRoom), with conditional updates and deletes that only touch rows their `where` matches at that
 * moment, like the database. Not used by the app.
 */

export type FakeFile = {
  id: string
  roomId: string
  messageId: string | null
  position: number
  uploadedById: string | null
  filename: string
  contentType: string
  sizeBytes: number
  storagePath: string
  sha256: string | null
  kind: "IMAGE" | "PDF" | "SPREADSHEET" | "CSV" | "JSON" | "TEXT" | "DOCUMENT" | "TRANSCRIPT" | "OTHER"
  status: "UPLOADING" | "READY" | "FAILED"
  modelCopyPath: string | null
  anthropicFileId: string | null
  thumbPath: string | null
  pageCount: number | null
  width: number | null
  height: number | null
  text: string | null
  textStatus: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  /** Meetings that use it as their transcript (the meetingsAsTranscript relation) */
  meetingIds: string[]
}

type Row = Record<string, unknown>
type Where = Record<string, unknown>

export function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Where[]).every((w) => matches(row, w))
    if (key === "OR") return (condition as Where[]).some((w) => matches(row, w))
    if (key === "meetingsAsTranscript") return (condition as { none?: object }).none ? !(row.meetingIds as string[]).length : true
    const value = row[key]
    if (condition === null) return value === null || value === undefined
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime()
    if (typeof condition === "object") {
      const c = condition as { lt?: Date; gte?: Date; in?: unknown[]; not?: unknown }
      if (c.lt !== undefined && !(value instanceof Date && value < c.lt)) return false
      if (c.gte !== undefined && !(value instanceof Date && value >= c.gte)) return false
      if (c.in !== undefined && !c.in.includes(value)) return false
      if ("not" in c && (value === null || value === undefined || value === c.not)) return false
      return true
    }
    return value === condition
  })
}

function pick(row: Row, select?: Record<string, unknown>) {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))
}

export function createFakeFileDb() {
  let clock = Date.parse("2026-10-20T12:00:00.000Z")
  const state = {
    files: [] as FakeFile[],
    rooms: [] as { id: string; archivedAt: Date | null }[],
  }

  const db = {
    state,
    now: () => new Date(clock),
    advance(ms: number) {
      clock += ms
    },
    addRoom(id = "11111111-1111-4111-8111-111111111111", archivedAt: Date | null = null) {
      state.rooms.push({ id, archivedAt })
      return id
    },
    addFile(fields: Partial<FakeFile> & { id: string }): FakeFile {
      const file: FakeFile = {
        roomId: state.rooms[0]?.id ?? "room",
        messageId: null,
        position: 0,
        uploadedById: "officer-1",
        filename: "photo.png",
        contentType: "image/png",
        sizeBytes: 10,
        storagePath: `rooms/room/${fields.id}/photo.png`,
        sha256: null,
        kind: "IMAGE",
        status: "UPLOADING",
        modelCopyPath: null,
        anthropicFileId: null,
        thumbPath: null,
        pageCount: null,
        width: null,
        height: null,
        text: null,
        textStatus: null,
        error: null,
        createdAt: new Date(clock),
        updatedAt: new Date(clock),
        meetingIds: [],
        ...fields,
      }
      state.files.push(file)
      return file
    },
    file(id: string) {
      return state.files.find((f) => f.id === id)
    },

    jackRoom: {
      async findFirst({ where, select }: { where: Where; select?: Record<string, unknown> }) {
        const room = state.rooms.find((r) => matches(r, where))
        return room ? pick(room, select) : null
      },
    },

    jackFile: {
      async create({ data }: { data: Partial<FakeFile> & { id: string } }) {
        return { ...db.addFile(data) }
      },
      async findUnique({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) {
        const file = db.file(where.id)
        return file ? pick(file, select) : null
      },
      async findMany({ where, select, take, orderBy }: { where: Where; select?: Record<string, unknown>; take?: number; orderBy?: Record<string, "asc" | "desc"> }) {
        let rows = state.files.filter((f) => matches(f, where))
        if (orderBy?.createdAt) rows = [...rows].sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) * (orderBy.createdAt === "asc" ? 1 : -1))
        return rows.slice(0, take).map((f) => pick(f, select))
      },
      async count({ where }: { where: Where }) {
        return state.files.filter((f) => matches(f, where)).length
      },
      async updateMany({ where, data }: { where: Where; data: Row }) {
        const hits = state.files.filter((f) => matches(f, where))
        for (const file of hits) Object.assign(file, data, { updatedAt: new Date(clock) })
        return { count: hits.length }
      },
      async delete({ where }: { where: { id: string } }) {
        const index = state.files.findIndex((f) => f.id === where.id)
        if (index < 0) throw new Error("Record to delete does not exist")
        return state.files.splice(index, 1)[0]
      },
      async deleteMany({ where }: { where: Where }) {
        const before = state.files.length
        state.files = state.files.filter((f) => !matches(f, where))
        return { count: before - state.files.length }
      },
    },
  }
  return db
}

export type FakeFileDb = ReturnType<typeof createFakeFileDb>
