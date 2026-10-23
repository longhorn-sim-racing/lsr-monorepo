import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { JackRoomEvent } from "@/lib/jack/types"
import type { JackToolContext } from "./types"

// The knowledge service is tested on its own (knowledge/service.test.ts); here it's a stand-in, so
// these tests are about the tool's own rules: where saves are allowed, the cap, notes and provenance
const service = vi.hoisted(() => ({
  createKnowledgeEntry: vi.fn(),
  updateKnowledgeEntry: vi.fn(),
  setKnowledgeArchived: vi.fn(),
}))
const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
  knowledgeEntry: { findUnique: vi.fn() },
  jackMessage: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
}))
const broadcast = vi.hoisted(() => ({ broadcastRoomEvent: vi.fn(async (_roomId: string, _event: JackRoomEvent) => {}) }))
vi.mock("../knowledge/service", () => service)
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("../broadcast", () => broadcast)
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { knowledgeTool, MAX_CHANGES_PER_REPLY, replyProvenance, type KnowledgeInput } from "./knowledge"

const NOW = new Date("2026-10-22T17:00:00Z")

function context(overrides: Partial<JackToolContext> = {}): JackToolContext {
  return {
    roomId: "room-1",
    messageId: "reply-1",
    actor: { userId: "officer-dylan", displayName: "Dylan" },
    reply: { fromOfficer: true, knowledgeChanges: 0 },
    ...overrides,
  }
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Dues this semester",
  body: "No dues this semester; only activity fees like the LSC entry.",
  tags: ["dues", "policy"],
  archivedAt: null,
  ...overrides,
})

const ID = entry().id
const VERSION = "22222222-2222-4222-8222-222222222222"

const save = (overrides: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
  action: "save",
  title: "Dues this semester",
  body: "No dues this semester; only activity fees like the LSC entry.",
  tags: ["Dues", "policy"],
  ...overrides,
})

/** The tool's input as the model loop checks it, then run */
async function call(input: unknown, ctx = context()) {
  const parsed = knowledgeTool.input.safeParse(input)
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
  return knowledgeTool.run(parsed.data, ctx)
}

const notes = () => db.jackMessage.create.mock.calls.map(([args]) => (args as { data: { content: string } }).data.content)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  db.jackMessage.findUnique.mockResolvedValue({
    toolCalls: [
      { id: "t1", name: "search", label: "Searched knowledge (0 results)", status: "done", at: 0, input: { query: "dues" }, displays: [] },
      { id: "t2", name: "knowledge", label: "Saving", status: "running", at: 0, input: { action: "save" }, displays: [] },
    ],
  })
  db.jackMessage.findMany.mockResolvedValue([{ id: "msg-1" }])
  db.jackMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "note-1",
    streamSeq: 0,
    status: "done",
    toolCalls: null,
    answeredById: null,
    continues: false,
    persona: null,
    createdAt: NOW,
    author: { displayName: "Dylan", avatarUrl: null },
    ...data,
  }))
  service.createKnowledgeEntry.mockImplementation(async (fields: Record<string, unknown>) => ({ ok: true, changed: true, versionId: VERSION, entry: entry({ ...fields, tags: ["dues", "policy"] }) }))
  service.updateKnowledgeEntry.mockImplementation(async (id: string, changes: Record<string, unknown>) => ({
    ok: true,
    changed: true,
    versionId: "33333333-3333-4333-8333-333333333333",
    entry: entry({ id, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) }),
  }))
  service.setKnowledgeArchived.mockResolvedValue({ ok: true, changed: true, entry: entry({ archivedAt: NOW }) })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("where knowledge can be saved", () => {
  it("only in a reply to messages officers typed", async () => {
    for (const ctx of [context({ reply: { fromOfficer: false, knowledgeChanges: 0 } }), context({ reply: undefined })]) {
      const result = await call(save(), ctx)
      expect(result).toMatchObject({ isError: true, forModel: expect.stringMatching(/only be saved in a reply to an officer's own message/) })
    }
    expect(service.createKnowledgeEntry).not.toHaveBeenCalled()
    expect(db.jackMessage.create).not.toHaveBeenCalled()
  })

  it(`allows ${MAX_CHANGES_PER_REPLY} changes per reply, counting saves, updates and archives`, async () => {
    const ctx = context()
    expect((await call(save(), ctx)).isError).toBeUndefined()
    expect((await call({ action: "update", id: ID, baseVersionId: VERSION, body: "New text" }, ctx)).isError).toBeUndefined()
    expect((await call({ action: "archive", id: ID }, ctx)).isError).toBeUndefined()
    const fourth = await call(save({ title: "Another one" }), ctx)
    expect(fourth).toMatchObject({ isError: true, forModel: expect.stringMatching(/already made 3 knowledge changes/) })
    expect(service.createKnowledgeEntry).toHaveBeenCalledTimes(1)
  })

  it("holds the cap for calls running side by side", async () => {
    const ctx = context()
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call(save({ title: `Entry number ${i}` }), ctx)))
    expect(results.filter((r) => !r.isError)).toHaveLength(3)
    expect(service.createKnowledgeEntry).toHaveBeenCalledTimes(3)
    expect(ctx.reply?.knowledgeChanges).toBe(3)
  })

  it("doesn't count a change that didn't happen", async () => {
    const ctx = context()
    service.createKnowledgeEntry.mockResolvedValueOnce({ ok: false, reason: "secret", error: "This looks like it holds a Stripe key." })
    service.createKnowledgeEntry.mockRejectedValueOnce(new Error("database down"))
    expect(await call(save(), ctx)).toMatchObject({ isError: true, label: "Knowledge not saved: it looked like a secret" })
    await expect(call(save(), ctx)).rejects.toThrow("database down")
    expect(ctx.reply?.knowledgeChanges).toBe(0)
  })
})

describe("save", () => {
  it("saves for the officer who asked, with where it came from, and posts the full text to the room", async () => {
    const result = await call(save())

    expect(service.createKnowledgeEntry).toHaveBeenCalledWith(
      {
        title: "Dues this semester",
        body: "No dues this semester; only activity fees like the LSC entry.",
        tags: ["dues", "policy"],
        sourceNote: "Dylan, in a Jack room",
        sourceDate: NOW,
        ownerId: "officer-dylan",
      },
      { userId: "officer-dylan", via: "jack", roomId: "room-1", messageId: "reply-1" },
      {
        notDuplicateOf: undefined,
        provenance: {
          roomId: "room-1",
          replyId: "reply-1",
          messageIds: ["msg-1"],
          askedBy: { userId: "officer-dylan", name: "Dylan" },
          // The knowledge call itself isn't a source
          tools: [{ name: "search", input: '{"query":"dues"}', label: "Searched knowledge (0 results)" }],
          at: NOW.toISOString(),
        },
      },
    )
    expect(notes()).toEqual([
      "Saved in knowledge for Dylan: “Dues this semester” (not reviewed yet)\n\nNo dues this semester; only activity fees like the LSC entry.\n\nTags: dues, policy",
    ])
    expect(db.jackMessage.create.mock.calls[0][0].data).toMatchObject({ roomId: "room-1", kind: "system", authorUserId: "officer-dylan" })
    expect(broadcast.broadcastRoomEvent).toHaveBeenCalledWith("room-1", expect.objectContaining({ type: "message.created" }))

    expect(result.label).toBe("Saved “Dues this semester” to knowledge")
    expect(JSON.parse(result.forModel)).toMatchObject({ saved: { id: ID, versionId: VERSION, link: expect.stringMatching(new RegExp(`/admin/knowledge/${ID}$`)) } })
    expect(result.displays).toEqual([{ kind: "links", items: [expect.objectContaining({ url: `/admin/knowledge/${ID}`, meta: "Not reviewed yet" })] }])
  })

  it("takes an owner by handle, only an officer's", async () => {
    db.user.findFirst.mockResolvedValueOnce({ id: "officer-armando" }).mockResolvedValueOnce(null)
    await call(save({ owner: "@Armando-Martinez", sourceDate: "2026-09-28", sourceNote: "Armando, exec meeting" }))
    expect(db.user.findFirst.mock.calls[0][0].where).toMatchObject({ handle: "armando-martinez", roles: { some: { role: { key: { in: ["officer", "admin"] } } } } })
    expect(service.createKnowledgeEntry.mock.calls[0][0]).toMatchObject({ ownerId: "officer-armando", sourceNote: "Armando, exec meeting", sourceDate: new Date("2026-09-28T05:00:00Z") })

    expect(await call(save({ owner: "someone" }))).toMatchObject({ isError: true, forModel: expect.stringMatching(/No officer has the handle @someone/) })
  })

  it("hands back the close entries when it looks like a duplicate", async () => {
    service.createKnowledgeEntry.mockResolvedValueOnce({
      ok: false,
      reason: "duplicate",
      error: "There's already an entry like this: “Dues policy”.",
      duplicates: [{ id: "dup-1", title: "Dues policy", updatedAt: new Date("2026-10-01T00:00:00Z"), score: 1, reason: "title" }],
    })
    const result = await call(save())
    expect(result).toMatchObject({ isError: true, label: "Knowledge not saved: similar entries exist" })
    expect(JSON.parse(result.forModel)).toMatchObject({ duplicates: [{ id: "dup-1", title: "Dues policy", updatedAt: "2026-10-01", match: "title" }], next: expect.stringMatching(/notDuplicateOf/) })
    expect(db.jackMessage.create).not.toHaveBeenCalled()

    await call(save({ notDuplicateOf: ["33333333-3333-4333-8333-333333333333"] }))
    expect(service.createKnowledgeEntry.mock.calls[1][2]).toMatchObject({ notDuplicateOf: ["33333333-3333-4333-8333-333333333333"] })
  })
})

describe("update", () => {
  it("applies exact edits to the current text, on the version Jack read", async () => {
    db.knowledgeEntry.findUnique.mockResolvedValueOnce({ body: "LSC entry: $10, or $5 for returning drivers." })
    const result = await call({ action: "update", id: ID, baseVersionId: VERSION, edits: [{ find: "$10", replace: "$12" }] })

    expect(service.updateKnowledgeEntry).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ body: "LSC entry: $12, or $5 for returning drivers." }),
      expect.objectContaining({ via: "jack" }),
      expect.objectContaining({ baseVersionId: VERSION }),
    )
    expect(result.label).toBe("Updated “Dues this semester” to knowledge")
    expect(notes()[0]).toMatch(/^Updated in knowledge for Dylan: “Dues this semester” \(not reviewed yet\)\n\nLSC entry: \$12/)
  })

  it("refuses edits that don't match exactly", async () => {
    db.knowledgeEntry.findUnique.mockResolvedValueOnce({ body: "LSC entry: $10." })
    expect(await call({ action: "update", id: ID, baseVersionId: VERSION, edits: [{ find: "$15", replace: "$12" }] })).toMatchObject({ isError: true, forModel: expect.stringMatching(/isn't in the entry/) })
    expect(service.updateKnowledgeEntry).not.toHaveBeenCalled()
  })

  it("gives back the current text when the entry moved on", async () => {
    service.updateKnowledgeEntry.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      error: "“Dues” changed since that version was read.",
      current: { versionId: "v-now", title: "Dues", body: "x".repeat(20_000), tags: [], updatedAt: NOW, updatedById: "officer-gray" },
    })
    const result = await call({ action: "update", id: ID, baseVersionId: VERSION, body: "New" })
    const body = JSON.parse(result.forModel)
    expect(body.current).toMatchObject({ versionId: "v-now", title: "Dues" })
    expect(body.current.body.length).toBeLessThan(15_100)
    expect(db.jackMessage.create).not.toHaveBeenCalled()
  })

  it("says so when nothing changed, without a note", async () => {
    service.updateKnowledgeEntry.mockResolvedValueOnce({ ok: true, changed: false, versionId: VERSION, entry: entry() })
    expect(await call({ action: "update", id: ID, baseVersionId: VERSION, title: "Dues this semester" })).toMatchObject({ isError: true, forModel: expect.stringMatching(/Nothing changed/) })
    expect(db.jackMessage.create).not.toHaveBeenCalled()
  })
})

describe("archive", () => {
  it("archives with the officer's reason and a note", async () => {
    const result = await call({ action: "archive", id: ID, reason: "Replaced by the spring policy" })
    expect(service.setKnowledgeArchived).toHaveBeenCalledWith(ID, true, expect.objectContaining({ via: "jack" }), "Replaced by the spring policy")
    expect(result.label).toBe("Archived “Dues this semester”")
    expect(notes()).toEqual(["Archived in knowledge for Dylan: “Dues this semester” (Replaced by the spring policy)"])
  })

  it("doesn't archive twice", async () => {
    service.setKnowledgeArchived.mockResolvedValueOnce({ ok: true, changed: false, entry: entry({ archivedAt: NOW }) })
    expect(await call({ action: "archive", id: ID })).toMatchObject({ isError: true, forModel: expect.stringMatching(/already archived/) })
  })
})

describe("the input", () => {
  it("needs what each action needs", () => {
    const issues = (input: unknown) => {
      const parsed = knowledgeTool.input.safeParse(input)
      return parsed.success ? [] : parsed.error.issues.map((i) => i.message)
    }
    expect(issues({ action: "save", title: "Dues" })).toEqual(["save needs the body"])
    expect(issues({ action: "save", title: "Dues", body: "x", id: ID })).toEqual(["save makes a new entry; to change an existing one, use update"])
    expect(issues({ action: "update", id: ID, body: "x" })).toEqual(["update needs baseVersionId: the versionId you read"])
    expect(issues({ action: "update", id: ID, baseVersionId: VERSION })).toEqual(["update needs something to change"])
    expect(issues({ action: "update", id: ID, baseVersionId: VERSION, body: "x", edits: [{ find: "a", replace: "b" }] })).toEqual(["give the whole body or edits, not both"])
    expect(issues({ action: "archive" })).toEqual(["archive needs the entry's id"])
    expect(issues({ action: "save", title: "Dues", body: "x".repeat(8_001) })).toHaveLength(1)
  })
})

describe("replyProvenance", () => {
  it("works outside a room reply too", async () => {
    expect(await replyProvenance({ roomId: "local", actor: { userId: null, displayName: "Script" } }, NOW)).toEqual({
      roomId: "local",
      replyId: null,
      messageIds: [],
      askedBy: { userId: null, name: "Script" },
      tools: [],
      at: NOW.toISOString(),
    })
    expect(db.jackMessage.findUnique).not.toHaveBeenCalled()
  })
})
