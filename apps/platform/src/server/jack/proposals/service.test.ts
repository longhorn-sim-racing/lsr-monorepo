import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import { z } from "zod"
import type { JackRoomEvent } from "@/lib/jack/types"

/*
 * An in-memory stand-in for the Prisma calls the proposal service makes. An updateMany only touches the
 * rows its `where` matches at that moment, and every call yields first, so two applies started together
 * really interleave (the claim race).
 */
type Row = Record<string, unknown>
type Where = Record<string, unknown>

const store = vi.hoisted(() => ({
  proposals: new Map<string, Record<string, unknown>>(),
  messages: [] as Record<string, unknown>[],
  rooms: new Set<string>(),
  roles: new Map<string, string[]>(),
  users: new Map<string, string>(),
  files: new Map<string, { sha256: string | null; status: string }>(),
  clock: 0,
  writes: 0,
}))

function same(a: unknown, b: unknown) {
  return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b
}
function matchValue(value: unknown, condition: unknown): boolean {
  if (condition && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition)) {
    const c = condition as Record<string, unknown>
    if ("not" in c) return !same(value, c.not)
    if ("in" in c) return (c.in as unknown[]).some((v) => same(value, v))
    if (value === null || value === undefined) return false
    const v = value as number | Date
    if ("gt" in c) return v > (c.gt as number | Date)
    if ("gte" in c) return v >= (c.gte as number | Date)
    if ("lt" in c) return v < (c.lt as number | Date)
    if ("lte" in c) return v <= (c.lte as number | Date)
  }
  return same(value, condition)
}
function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Where[]).every((w) => matches(row, w))
    if (key === "OR") return (condition as Where[]).some((w) => matches(row, w))
    if (key === "NOT") return !matches(row, condition as Where)
    return matchValue(row[key], condition)
  })
}
const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const stamp = () => new Date(store.clock + ++store.writes)
const clean = (data: Row) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === Prisma.DbNull ? null : v]))

const db = vi.hoisted(() => ({}) as Record<string, unknown>)
Object.assign(db, {
  jackProposal: {
    async create({ data }: { data: Row }) {
      await yieldNow()
      const row: Row = { claimedAt: null, decidedById: null, decidedAt: null, result: null, supersededById: null, createdAt: stamp(), ...clean(data) }
      row.updatedAt = row.createdAt
      store.proposals.set(row.id as string, row)
      return { ...row }
    },
    async findUnique({ where }: { where: { id: string } }) {
      await yieldNow()
      const row = store.proposals.get(where.id)
      return row ? { ...row } : null
    },
    async findUniqueOrThrow({ where }: { where: { id: string } }) {
      await yieldNow()
      const row = store.proposals.get(where.id)
      if (!row) throw new Error("not found")
      return { ...row }
    },
    async findMany({ where, take }: { where?: Where; take?: number }) {
      await yieldNow()
      return [...store.proposals.values()].filter((row) => matches(row, where)).slice(0, take ?? Infinity).map((row) => ({ ...row }))
    },
    async updateMany({ where, data }: { where: Where; data: Row }) {
      await yieldNow()
      let count = 0
      for (const row of store.proposals.values()) {
        if (!matches(row, where)) continue
        Object.assign(row, clean(data), { updatedAt: stamp() })
        count++
      }
      return { count }
    },
    async update({ where, data }: { where: { id: string }; data: Row }) {
      await yieldNow()
      const row = store.proposals.get(where.id)
      if (!row) throw new Error("not found")
      Object.assign(row, clean(data), { updatedAt: stamp() })
      return { ...row }
    },
  },
  jackRoom: {
    async findUnique({ where }: { where: { id: string } }) {
      return store.rooms.has(where.id) ? { id: where.id } : null
    },
  },
  jackMessage: {
    async create({ data }: { data: Row }) {
      const row = { id: `msg-${store.messages.length + 1}`, persona: null, toolCalls: null, status: "done", streamSeq: 0, answeredById: null, continues: false, model: null, createdAt: stamp(), author: null, ...data }
      store.messages.push(row)
      return row
    },
  },
  userRole: {
    async findMany({ where }: { where: { userId: string } }) {
      return (store.roles.get(where.userId) ?? []).map((key) => ({ role: { key } }))
    },
  },
  user: {
    async findMany({ where }: { where: { id: { in: string[] } } }) {
      return where.id.in.filter((id) => store.users.has(id)).map((id) => ({ id, displayName: store.users.get(id) }))
    },
  },
  jackFile: {
    async findUnique({ where }: { where: { id: string } }) {
      return store.files.get(where.id) ?? null
    },
  },
  async $transaction(fn: (tx: unknown) => Promise<unknown>) {
    return fn(db)
  },
})

const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("./registry", () => ({ findProposalKind: () => undefined, PROPOSAL_KINDS: [] }))

import { buildHistory, type HistoryRow } from "../history"
import { ProposalInputError, StaleProposalError } from "./errors"
import { APPLYING_TIMEOUT_MS, applyProposal, createProposal, discardProposal, getProposalDetail, PROPOSAL_TTL_MS, roomProposalStates, sweepProposals, type ProposalDeps } from "./service"
import type { AnyProposalKind, ProposalApplyContext } from "./types"

/* Fake club data the test kinds change: things by id */
const things = new Map<string, string>()
const applied: ProposalApplyContext[] = []
let applyImpl: (ctx: ProposalApplyContext) => Promise<void> = async () => {}

const thingSchema = z.object({ thingId: z.string(), value: z.string() })
type Thing = z.infer<typeof thingSchema>

function thingKind(kind: string, extra: Partial<AnyProposalKind> = {}): AnyProposalKind {
  return {
    kind,
    tool: "propose_change",
    description: `Changes a thing (${kind}), for tests`,
    schema: thingSchema,
    targetType: "THING",
    permission: "officer",
    async prepare(p: Thing) {
      if (p.value === "bad") throw new ProposalInputError("That value can't be used.")
      if (!things.has(p.thingId)) throw new ProposalInputError("No such thing.")
      const before = things.get(p.thingId)!
      return {
        before: { value: before },
        targetId: p.thingId,
        view: {
          title: `Change ${p.thingId}`,
          summary: `Sets ${p.thingId} to ${p.value}.`,
          diff: [
            { field: "value", label: "Value", before, after: p.value, format: "text" as const },
            { field: "notes", label: "Notes", before: "line 1\nline 2\nline 3", after: "line 1\nline two\nline 3", format: "markdown" as const },
          ],
          links: [{ title: "Edit thing", url: `/admin/things/${p.thingId}` }],
        },
      }
    },
    async checkStale(p: Thing, before: unknown) {
      return things.get(p.thingId) === (before as { value: string }).value ? null : `${p.thingId} changed since this was proposed.`
    },
    async apply(p: Thing, ctx: ProposalApplyContext) {
      applied.push(ctx)
      await applyImpl(ctx)
      await yieldNow()
      things.set(p.thingId, p.value)
      return { summary: `Set ${p.thingId} to ${p.value}.`, links: [{ title: "Edit thing", url: `/admin/things/${p.thingId}` }] }
    },
    ...extra,
  }
}

const listSchema = z.object({ names: z.array(z.string()) })
const listKind: AnyProposalKind = {
  ...thingKind("test.list"),
  schema: listSchema,
  list: { rows: (p: { names: string[] }) => p.names.map((name, i) => ({ id: `r${i}`, label: name })) },
  async prepare(p: { names: string[] }) {
    return { before: null, view: { title: "Check in people", summary: "Checks them in.", diff: [], rows: p.names.map((name, i) => ({ id: `r${i}`, label: name, status: "matched" as const })) } }
  },
  async checkStale() {
    return null
  },
  async apply(_p: unknown, ctx: ProposalApplyContext) {
    applied.push(ctx)
    return { summary: `Checked in ${ctx.selectedRows?.length ?? "everyone"}.` }
  },
}

/* Rows built on the server when proposing (like notification.send's audience): only the saved view has them */
const members = new Map<string, string[]>()
const audienceSchema = z.object({ group: z.string() })
const audienceKind: AnyProposalKind = {
  ...thingKind("test.audience"),
  schema: audienceSchema,
  async prepare(p: { group: string }) {
    const people = members.get(p.group) ?? []
    return { before: null, view: { title: `Message ${p.group}`, summary: "Sends them a message.", diff: [], rows: people.map((name) => ({ id: `m-${name}`, label: name, status: "matched" as const })) } }
  },
  async checkStale() {
    return null
  },
  async apply(_p: unknown, ctx: ProposalApplyContext) {
    applied.push(ctx)
    return { summary: `Sent to ${ctx.selectedRows?.length ?? "everyone"}.` }
  },
}

/* Officers can apply it, except for payloads that need an admin */
const gatedKind = thingKind("test.gated", {
  permissionFor: (p: Thing) => {
    if (p.value === "boom") throw new Error("no such target")
    return p.value === "secret" ? "admin" : "officer"
  },
})

const fileSchema = z.object({ fileId: z.string() })
const fileKind: AnyProposalKind = {
  ...thingKind("test.file"),
  schema: fileSchema,
  async prepare(p: { fileId: string }) {
    return { before: null, fileSha256: "sha-1", view: { title: `Import ${p.fileId}`, summary: "Imports the file.", diff: [] } }
  },
  async checkStale() {
    return null
  },
  async apply() {
    return { summary: "Imported." }
  },
}

/* A rendered preview on the card (news posts) */
const previewKind: AnyProposalKind = {
  ...fileKind,
  kind: "test.preview",
  schema: z.object({ text: z.string() }),
  async prepare(p: { text: string }) {
    return { before: null, view: { title: "Post it", summary: "Posts it.", diff: [], preview: { label: "How it reads", title: "Post", blocks: [{ t: "p" as const, c: [{ t: "text" as const, v: p.text }] }] } } }
  },
}

/* Pictures on the card (an Instagram post's slides, a gallery add's images): only this site's officer image routes load */
const SLIDE_THUMB = "/api/admin/jack/decks/11111111-1111-4111-8111-111111111111/slides/slide-a?v=3&kind=thumb"
const picturesKind: AnyProposalKind = {
  ...fileKind,
  kind: "test.pictures",
  schema: z.object({}),
  async prepare() {
    return {
      before: null,
      view: {
        title: "Post it",
        summary: "Posts it.",
        diff: [],
        images: [{ url: SLIDE_THUMB, alt: "Slide 1", label: "Slide 1" }, { url: "https://evil.example/pixel.gif", alt: "x" }],
        rows: [
          { id: "a", label: "Slide 1", thumbUrl: SLIDE_THUMB },
          { id: "b", label: "Photo", thumbUrl: "//evil.example/x.jpg" },
        ],
      },
    }
  },
}

const KINDS: Record<string, AnyProposalKind> = {
  "test.change": thingKind("test.change"),
  "test.preview": previewKind,
  "test.pictures": picturesKind,
  "test.admin": thingKind("test.admin", { permission: "admin" }),
  "test.list": listKind,
  "test.file": fileKind,
  "test.audience": audienceKind,
  "test.gated": gatedKind,
}

const events: { roomId: string; event: JackRoomEvent }[] = []
const deps: ProposalDeps = {
  broadcast: async (roomId, event) => {
    events.push({ roomId, event })
  },
  findKind: (kind) => KINDS[kind],
  now: () => new Date(store.clock),
}

const ROOM = "room-1"
const asker = { userId: "u-asker", displayName: "Ana" }
const gray = { id: "u-gray", displayName: "Gray" }
const dylan = { id: "u-dylan", displayName: "Dylan" }
const admin = { id: "u-admin", displayName: "Alex" }

async function propose(kind = "test.change", payload: unknown = { thingId: "t1", value: "new" }, roomId = ROOM) {
  const outcome = await createProposal({ kind, payload, roomId, messageId: "reply-1", proposedFor: asker }, deps)
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome
}
const notes = () => store.messages.map((m) => m.content as string)
const proposalEvents = () => events.flatMap(({ event }) => (event.type === "proposal.updated" ? [event.proposal] : []))
const row = (id: string) => store.proposals.get(id)!

beforeEach(() => {
  store.proposals.clear()
  store.messages.length = 0
  store.rooms.clear()
  store.rooms.add(ROOM)
  store.rooms.add("room-2")
  store.roles.clear()
  store.roles.set(gray.id, ["officer"])
  store.roles.set(dylan.id, ["officer"])
  store.roles.set(admin.id, ["admin"])
  store.users.clear()
  store.users.set(asker.userId, "Ana")
  store.users.set(gray.id, "Gray")
  store.files.clear()
  store.clock = new Date("2026-10-22T15:00:00Z").getTime()
  store.writes = 0
  things.clear()
  things.set("t1", "old")
  things.set("t2", "old")
  members.clear()
  members.set("drivers", ["Ada", "Ben", "Cy"])
  applied.length = 0
  applyImpl = async () => {}
  events.length = 0
})

describe("createProposal", () => {
  it("saves a pending proposal described by its kind, and returns the room's small display", async () => {
    const { proposal, superseded } = await propose()
    expect(superseded).toEqual([])
    const saved = row(proposal.proposalId)
    expect(saved).toMatchObject({
      roomId: ROOM,
      messageId: "reply-1",
      kind: "test.change",
      title: "Change t1",
      summary: "Sets t1 to new.",
      payload: { thingId: "t1", value: "new" },
      before: { value: "old" },
      targetType: "THING",
      targetId: "t1",
      status: "PENDING",
      proposedForId: "u-asker",
    })
    expect((saved.expiresAt as Date).getTime() - store.clock).toBe(PROPOSAL_TTL_MS)
    expect(saved.view).toMatchObject({ title: "Change t1", diff: [{ field: "value" }, { field: "notes" }], links: [{ url: "/admin/things/t1" }] })
    // Short rows as before and after; long text as a count of changed lines
    expect(proposal).toEqual({
      kind: "proposal",
      proposalId: proposal.proposalId,
      proposalKind: "test.change",
      title: "Change t1",
      summary: "Sets t1 to new.",
      preview: [
        { label: "Value", before: "old", after: "new", format: "text" },
        { label: "Notes", before: null, after: "1 line changed", format: "markdown" },
      ],
    })
  })

  it("hands bad input back for the model to fix, saving nothing", async () => {
    expect(await createProposal({ kind: "test.change", payload: { thingId: "t1" }, roomId: ROOM, proposedFor: asker }, deps)).toEqual({ ok: false, error: expect.stringMatching(/^The test.change proposal isn't valid: value:/) })
    expect(await createProposal({ kind: "test.change", payload: { thingId: "t1", value: "bad" }, roomId: ROOM, proposedFor: asker }, deps)).toEqual({ ok: false, error: "That value can't be used." })
    expect(await createProposal({ kind: "nope", payload: {}, roomId: ROOM, proposedFor: asker }, deps)).toEqual({ ok: false, error: 'There\'s no proposal kind "nope".' })
    expect(await createProposal({ kind: "test.change", payload: { thingId: "t1", value: "x" }, roomId: "gone", proposedFor: asker }, deps)).toEqual({ ok: false, error: "This room doesn't exist anymore." })
    expect(store.proposals.size).toBe(0)
  })

  it("supersedes older pending proposals for the same kind and target in the room, with a note", async () => {
    const first = await propose("test.change", { thingId: "t1", value: "a" })
    const otherTarget = await propose("test.change", { thingId: "t2", value: "a" })
    const otherRoom = await propose("test.change", { thingId: "t1", value: "a" }, "room-2")
    const otherKind = await propose("test.admin", { thingId: "t1", value: "a" })
    events.length = 0

    const second = await propose("test.change", { thingId: "t1", value: "b" })
    expect(second.superseded).toEqual([first.proposal.proposalId])
    expect(row(first.proposal.proposalId)).toMatchObject({ status: "SUPERSEDED", supersededById: second.proposal.proposalId, result: { summary: "Replaced by a newer proposal." } })
    for (const untouched of [otherTarget, otherRoom, otherKind]) expect(row(untouched.proposal.proposalId).status).toBe("PENDING")
    expect(notes().at(-1)).toBe("Superseded: Change t1. Jack proposed a newer version.")
    expect(proposalEvents()).toEqual([expect.objectContaining({ id: first.proposal.proposalId, status: "SUPERSEDED" })])
  })

  it("never supersedes one an officer is applying", async () => {
    const first = await propose()
    row(first.proposal.proposalId).status = "APPLYING"
    expect((await propose()).superseded).toEqual([])
    expect(row(first.proposal.proposalId).status).toBe("APPLYING")
  })
})

describe("applyProposal", () => {
  it("claims, applies, records the outcome, audits it and posts a note with a link", async () => {
    const { proposal } = await propose()
    events.length = 0
    const decision = await applyProposal(proposal.proposalId, gray, {}, deps)

    expect(decision).toMatchObject({ ok: true, proposal: { id: proposal.proposalId, status: "APPLIED", result: { summary: "Set t1 to new." } } })
    expect(things.get("t1")).toBe("new")
    expect(row(proposal.proposalId)).toMatchObject({ status: "APPLIED", decidedById: gray.id, claimedAt: expect.any(Date), decidedAt: expect.any(Date) })
    // The kind gets the applier, the snapshot, an idempotency key and the audit tag
    expect(applied[0]).toEqual({
      officer: { userId: gray.id, displayName: "Gray" },
      proposalId: proposal.proposalId,
      roomId: ROOM,
      selectedRows: undefined,
      idempotencyKey: `proposal:${proposal.proposalId}`,
      before: { value: "old" },
      auditMetadata: { via: "jack", proposalId: proposal.proposalId, roomId: ROOM, proposedFor: "u-asker" },
    })
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: gray.id,
        actionType: "APPLY",
        entityType: "JACK_PROPOSAL",
        entityId: proposal.proposalId,
        summary: "Applied Jack's proposal: Change t1",
        metadata: { via: "jack", proposalId: proposal.proposalId, roomId: ROOM, proposedFor: "u-asker", kind: "test.change" },
      }),
    )
    expect(notes()).toEqual(["Gray applied: Change t1 → /admin/things/t1"])
    expect(decision.ok && decision.note?.content).toBe("Gray applied: Change t1 → /admin/things/t1")
    expect(proposalEvents().map((p) => p.status)).toEqual(["APPLYING", "APPLIED"])
    expect(events.find(({ event }) => event.type === "message.created")?.event).toMatchObject({ message: { author: { kind: "system" }, content: "Gray applied: Change t1 → /admin/things/t1" } })
  })

  it("lets only one of two officers clicking at once apply it", async () => {
    const { proposal } = await propose()
    const [first, second] = await Promise.all([applyProposal(proposal.proposalId, gray, {}, deps), applyProposal(proposal.proposalId, dylan, {}, deps)])
    expect(applied).toHaveLength(1)
    expect([first.ok, second.ok].sort()).toEqual([false, true])
    const loser = first.ok ? second : first
    expect(loser).toMatchObject({ ok: false, error: expect.stringMatching(/An officer is applying it right now|It was already applied/) })
    expect(notes()).toHaveLength(1)
    expect(audit.createAuditLog).toHaveBeenCalledTimes(1)
  })

  it("goes stale instead of applying when the target changed since", async () => {
    const { proposal } = await propose()
    things.set("t1", "someone else's edit")
    const decision = await applyProposal(proposal.proposalId, gray, {}, deps)
    expect(decision).toMatchObject({ ok: false, error: "t1 changed since this was proposed.", proposal: { status: "STALE" } })
    expect(applied).toHaveLength(0)
    expect(things.get("t1")).toBe("someone else's edit")
    expect(notes()).toEqual(["Stale: Change t1. t1 changed since this was proposed."])
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("goes stale when the kind's own conditional write misses", async () => {
    const { proposal } = await propose()
    applyImpl = async () => {
      throw new StaleProposalError("Someone changed t1 a moment ago.")
    }
    expect(await applyProposal(proposal.proposalId, gray, {}, deps)).toMatchObject({ ok: false, proposal: { status: "STALE", result: { summary: "Someone changed t1 a moment ago." } } })
  })

  it("records a failure with its error redacted, and a note", async () => {
    const { proposal } = await propose()
    const key = "sk_" + "live_" + "51Hx" + "Q2bL7aZp".repeat(3)
    applyImpl = async () => {
      throw new Error(`Stripe said no to ${key}`)
    }
    vi.spyOn(console, "error").mockImplementation(() => {})
    const decision = await applyProposal(proposal.proposalId, gray, {}, deps)
    expect(decision.ok).toBe(false)
    const summary = (row(proposal.proposalId).result as { summary: string }).summary
    expect(row(proposal.proposalId).status).toBe("FAILED")
    expect(summary).not.toContain(key)
    expect(notes()[0]).toMatch(/^Couldn't apply: Change t1\. Stripe said no to /)
    expect(notes()[0]).not.toContain(key)
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "APPLY_FAILED", actorUserId: gray.id }))
  })

  it("checks the kind's permission against the applying officer, whoever it was proposed for", async () => {
    const { proposal } = await propose("test.admin")
    expect(await applyProposal(proposal.proposalId, gray, {}, deps)).toEqual({ ok: false, error: "Only admins can apply this kind of change." })
    expect(row(proposal.proposalId).status).toBe("PENDING")
    expect(notes()).toEqual([])

    store.roles.set("u-nobody", [])
    expect(await applyProposal(proposal.proposalId, { id: "u-nobody", displayName: "Nobody" }, {}, deps)).toMatchObject({ ok: false, error: "Only admins can apply this kind of change." })

    const { proposal: officerKind } = await propose("test.change", { thingId: "t2", value: "x" })
    expect(await applyProposal(officerKind.proposalId, { id: "u-nobody", displayName: "Nobody" }, {}, deps)).toEqual({ ok: false, error: "Only officers can apply proposals." })

    expect(await applyProposal(proposal.proposalId, admin, {}, deps)).toMatchObject({ ok: true })
  })

  it("treats a proposal past its expiry as stale, once", async () => {
    const { proposal } = await propose()
    store.clock += PROPOSAL_TTL_MS + 1
    expect(await applyProposal(proposal.proposalId, gray, {}, deps)).toMatchObject({ ok: false, error: "It expired: nobody applied it within 14 days.", proposal: { status: "STALE" } })
    expect(applied).toHaveLength(0)
    expect(notes()).toEqual(["Stale: Change t1. Nobody applied it within 14 days."])
    expect(await applyProposal(proposal.proposalId, gray, {}, deps)).toMatchObject({ ok: false, error: "It's stale: nobody applied it within 14 days." })
    expect(notes()).toHaveLength(1)
  })

  it("won't apply one that's already decided", async () => {
    const { proposal } = await propose()
    await discardProposal(proposal.proposalId, dylan, deps)
    expect(await applyProposal(proposal.proposalId, gray, {}, deps)).toMatchObject({ ok: false, error: "It was already discarded.", proposal: { status: "DISCARDED" } })
    expect(await applyProposal("missing", gray, {}, deps)).toEqual({ ok: false, error: "That proposal doesn't exist anymore." })
  })

  it("fails one whose payload no longer passes its kind's checks", async () => {
    const { proposal } = await propose()
    row(proposal.proposalId).payload = { thingId: "t1" }
    expect(await applyProposal(proposal.proposalId, gray, {}, deps)).toMatchObject({ ok: false, proposal: { status: "FAILED" } })
    expect(applied).toHaveLength(0)
  })

  it("applies the rows an officer picked, for list kinds", async () => {
    const { proposal } = await propose("test.list", { names: ["Ada", "Ben", "Cy"] })
    expect(await applyProposal(proposal.proposalId, gray, { selectedRows: [] }, deps)).toEqual({ ok: false, error: "Pick at least one row to apply." })
    expect(await applyProposal(proposal.proposalId, gray, { selectedRows: ["r0", "r9"] }, deps)).toMatchObject({ ok: false, error: expect.stringMatching(/aren't in this proposal/) })
    expect(row(proposal.proposalId).status).toBe("PENDING")

    const decision = await applyProposal(proposal.proposalId, gray, { selectedRows: ["r0", "r2", "r2"] }, deps)
    expect(decision).toMatchObject({ ok: true, proposal: { result: { summary: "Checked in 2.", appliedRows: ["r0", "r2"] } } })
    expect(applied[0].selectedRows).toEqual(["r0", "r2"])
  })

  it("applies the picked rows of a kind whose rows were built on the server (view.rows, no list)", async () => {
    const { proposal } = await propose("test.audience", { group: "drivers" })
    // The rows exist only in the saved view: the group changing since doesn't change what can be picked
    members.set("drivers", ["Dee"])
    expect(await applyProposal(proposal.proposalId, gray, { selectedRows: ["m-Dee"] }, deps)).toMatchObject({ ok: false, error: expect.stringMatching(/aren't in this proposal/) })
    expect(row(proposal.proposalId).status).toBe("PENDING")

    const decision = await applyProposal(proposal.proposalId, gray, { selectedRows: ["m-Ada", "m-Cy"] }, deps)
    expect(decision).toMatchObject({ ok: true, proposal: { result: { summary: "Sent to 2.", appliedRows: ["m-Ada", "m-Cy"] } } })
    expect(applied[0].selectedRows).toEqual(["m-Ada", "m-Cy"])
  })

  it("refuses picked rows for a proposal without rows", async () => {
    const { proposal } = await propose()
    expect(await applyProposal(proposal.proposalId, gray, { selectedRows: ["r0"] }, deps)).toEqual({ ok: false, error: "This proposal has no rows to pick from. Reload the room and try again." })
    expect(row(proposal.proposalId).status).toBe("PENDING")
    expect(applied).toHaveLength(0)
  })

  it("checks a stricter permission for some payloads before claiming, so an admin can still apply it", async () => {
    const { proposal } = await propose("test.gated", { thingId: "t1", value: "secret" })
    expect(await applyProposal(proposal.proposalId, gray, {}, deps)).toEqual({ ok: false, error: "Only admins can apply this kind of change." })
    expect(row(proposal.proposalId).status).toBe("PENDING")
    expect(applied).toHaveLength(0)
    expect(await applyProposal(proposal.proposalId, admin, {}, deps)).toMatchObject({ ok: true })

    const { proposal: plain } = await propose("test.gated", { thingId: "t2", value: "open" })
    expect(await applyProposal(plain.proposalId, gray, {}, deps)).toMatchObject({ ok: true })

    // A permissionFor that throws means admin
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { proposal: broken } = await propose("test.gated", { thingId: "t1", value: "boom" })
    expect(await applyProposal(broken.proposalId, gray, {}, deps)).toEqual({ ok: false, error: "Only admins can apply this kind of change." })
  })

  it("goes stale when the file it was built from changed", async () => {
    store.files.set("f1", { sha256: "sha-1", status: "READY" })
    const kept = await propose("test.file", { fileId: "f1" })
    expect(await applyProposal(kept.proposal.proposalId, gray, {}, deps)).toMatchObject({ ok: true })

    const changed = await propose("test.file", { fileId: "f1" })
    store.files.set("f1", { sha256: "sha-2", status: "READY" })
    expect(await applyProposal(changed.proposal.proposalId, gray, {}, deps)).toMatchObject({ ok: false, error: "The file it was built from changed since this was proposed." })

    const gone = await propose("test.file", { fileId: "f2" })
    expect(await applyProposal(gone.proposal.proposalId, gray, {}, deps)).toMatchObject({ ok: false, error: "The file it was built from was deleted." })
  })
})

describe("discardProposal", () => {
  it("discards a pending proposal with a note and an audit entry, once", async () => {
    const { proposal } = await propose("test.admin")
    // Any officer can discard, even a kind only admins can apply
    expect(await discardProposal(proposal.proposalId, dylan, deps)).toMatchObject({ ok: true, proposal: { status: "DISCARDED", result: { summary: "Discarded by Dylan." } } })
    expect(notes()).toEqual(["Discarded by Dylan: Change t1"])
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: dylan.id, actionType: "DISCARD", entityType: "JACK_PROPOSAL", summary: "Discarded Jack's proposal: Change t1" }))
    expect(await discardProposal(proposal.proposalId, gray, deps)).toMatchObject({ ok: false, error: "It was already discarded." })
    expect(notes()).toHaveLength(1)
  })
})

describe("reading proposals", () => {
  it("gives the card the full view, long text as a line diff, with names and whether the viewer may apply", async () => {
    const { proposal } = await propose("test.admin")
    const forGray = await getProposalDetail(proposal.proposalId, gray.id, deps)
    expect(forGray).toMatchObject({
      id: proposal.proposalId,
      status: "PENDING",
      proposedFor: "Ana",
      decidedBy: null,
      permission: "admin",
      canApply: false,
      known: true,
      destructive: false,
      links: [{ title: "Edit thing", url: "/admin/things/t1" }],
      rows: null,
    })
    expect(forGray!.diff[0]).toEqual({ field: "value", label: "Value", before: "old", after: "new", format: "text" })
    expect(forGray!.diff[1]).toEqual({
      field: "notes",
      label: "Notes",
      format: "markdown",
      before: null,
      after: null,
      stats: { added: 1, removed: 1 },
      lines: [
        { op: "same", text: "line 1" },
        { op: "del", text: "line 2" },
        { op: "add", text: "line two" },
        { op: "same", text: "line 3" },
      ],
    })
    expect((await getProposalDetail(proposal.proposalId, admin.id, deps))?.canApply).toBe(true)
    expect(await getProposalDetail("missing", gray.id, deps)).toBeNull()
    expect(forGray!.preview).toBeNull()
  })

  it("gives the card the preview the kind built when proposing", async () => {
    const { proposal } = await propose("test.preview", { text: "Hello" })
    expect((await getProposalDetail(proposal.proposalId, gray.id, deps))?.preview).toEqual({ label: "How it reads", title: "Post", blocks: [{ t: "p", c: [{ t: "text", v: "Hello" }] }] })
    expect((await getProposalDetail(proposal.proposalId, gray.id, deps))?.images).toEqual([])
  })

  it("gives the card pictures and row thumbnails from this site's officer image routes only", async () => {
    const { proposal } = await propose("test.pictures", {})
    const detail = await getProposalDetail(proposal.proposalId, gray.id, deps)
    expect(detail?.images).toEqual([{ url: SLIDE_THUMB, alt: "Slide 1", label: "Slide 1" }])
    expect(detail?.rows).toEqual([
      { id: "a", label: "Slide 1", thumbUrl: SLIDE_THUMB },
      { id: "b", label: "Photo" },
    ])
  })

  it("gives the card the rows Apply honours: saved ones, list.rows() ones, or none", async () => {
    const audience = await propose("test.audience", { group: "drivers" })
    members.set("drivers", [])
    expect((await getProposalDetail(audience.proposal.proposalId, gray.id, deps))?.rows).toEqual([
      { id: "m-Ada", label: "Ada", status: "matched" },
      { id: "m-Ben", label: "Ben", status: "matched" },
      { id: "m-Cy", label: "Cy", status: "matched" },
    ])

    // A list kind whose saved view has no rows (an older proposal) falls back to list.rows()
    const list = await propose("test.list", { names: ["Ada"] })
    delete (row(list.proposal.proposalId).view as { rows?: unknown }).rows
    expect((await getProposalDetail(list.proposal.proposalId, gray.id, deps))?.rows).toEqual([{ id: "r0", label: "Ada" }])
  })

  it("says who may apply a payload that needs an admin", async () => {
    const { proposal } = await propose("test.gated", { thingId: "t1", value: "secret" })
    expect(await getProposalDetail(proposal.proposalId, gray.id, deps)).toMatchObject({ permission: "admin", canApply: false })
    expect(await getProposalDetail(proposal.proposalId, admin.id, deps)).toMatchObject({ permission: "admin", canApply: true })
    const { proposal: open } = await propose("test.gated", { thingId: "t2", value: "open" })
    expect(await getProposalDetail(open.proposalId, gray.id, deps)).toMatchObject({ permission: "officer", canApply: true })
  })

  it("reads an expired pending proposal as stale everywhere without writing (the sweep or an apply does)", async () => {
    const { proposal } = await propose()
    store.clock += PROPOSAL_TTL_MS
    events.length = 0
    expect(await roomProposalStates(ROOM, deps)).toEqual({ [proposal.proposalId]: expect.objectContaining({ status: "STALE", result: { summary: "Nobody applied it within 14 days." } }) })
    expect(await getProposalDetail(proposal.proposalId, gray.id, deps)).toMatchObject({ status: "STALE", result: { summary: "Nobody applied it within 14 days." }, canApply: false })
    expect(row(proposal.proposalId).status).toBe("PENDING")
    expect(notes()).toEqual([])
    expect(events).toEqual([])

    expect(await sweepProposals({}, deps)).toEqual({ failed: 0, expired: 1 })
    expect(row(proposal.proposalId).status).toBe("STALE")
    expect(notes()).toEqual(["Stale: Change t1. Nobody applied it within 14 days."])
  })
})

describe("sweepProposals", () => {
  it("fails applies that stopped partway and expires old pending ones, each with a note", async () => {
    const stuck = await propose("test.change", { thingId: "t1", value: "a" })
    const running = await propose("test.change", { thingId: "t2", value: "a" })
    const old = await propose("test.admin", { thingId: "t2", value: "b" })
    Object.assign(row(stuck.proposal.proposalId), { status: "APPLYING", claimedAt: new Date(store.clock - APPLYING_TIMEOUT_MS - 1), decidedById: gray.id })
    Object.assign(row(running.proposal.proposalId), { status: "APPLYING", claimedAt: new Date(store.clock - 60_000) })
    row(old.proposal.proposalId).expiresAt = new Date(store.clock - 1)

    expect(await sweepProposals({}, deps)).toEqual({ failed: 1, expired: 1 })
    expect(row(stuck.proposal.proposalId)).toMatchObject({ status: "FAILED", result: { summary: expect.stringMatching(/^The apply stopped before it finished/) } })
    expect(row(running.proposal.proposalId).status).toBe("APPLYING")
    expect(row(old.proposal.proposalId).status).toBe("STALE")
    expect(notes()).toEqual([
      expect.stringMatching(/^Couldn't apply: Change t1\. The apply stopped before it finished, .* → \/admin\/things\/t1$/),
      "Stale: Change t2. Nobody applied it within 14 days.",
    ])
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, actionType: "APPLY_FAILED", metadata: expect.objectContaining({ appliedBy: gray.id }) }))
    expect(await sweepProposals({}, deps)).toEqual({ failed: 0, expired: 0 })
  })
})

describe("room notes", () => {
  it("reach Jack's history, so he learns what came of his proposals", async () => {
    const { proposal } = await propose()
    await applyProposal(proposal.proposalId, gray, {}, deps)
    const history = buildHistory(
      [
        { id: "q1", kind: "user", persona: null, content: "Change t1 please", toolCalls: null, status: "done", answeredById: "reply-1", model: null, createdAt: new Date(store.clock - 60_000), author: { displayName: "Ana" } },
        { id: "reply-1", kind: "assistant", persona: "jack", content: "I proposed it.", toolCalls: null, status: "done", answeredById: null, model: "claude-sonnet-5-5", createdAt: new Date(store.clock - 50_000), author: null },
        ...store.messages.map((m) => ({ ...(m as unknown as HistoryRow), author: null })),
        { id: "q2", kind: "user", persona: null, content: "Did it go through?", toolCalls: null, status: "done", answeredById: "reply-2", model: null, createdAt: new Date(store.clock + 60_000), author: { displayName: "Ana" } },
        { id: "reply-2", kind: "assistant", persona: "jack", content: "", toolCalls: null, status: "streaming", answeredById: null, model: null, createdAt: new Date(store.clock + 61_000), author: null },
      ],
      "reply-2",
    )
    expect(history.at(-1)?.content).toContain("(Room note: Gray applied: Change t1 → /admin/things/t1)")
  })
})
