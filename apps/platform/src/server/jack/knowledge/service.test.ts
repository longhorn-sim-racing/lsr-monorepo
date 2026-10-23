import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The knowledge service against an in-memory stand-in for its Prisma calls. The SQL (the duplicate
 * query's lexeme counts, the row lock) runs for real in scripts/check-jack-knowledge.ts.
 */

type Entry = Record<string, unknown> & { id: string; title: string; body: string; tags: string[]; archivedAt: Date | null; reviewedAt: Date | null; updatedAt: Date }
type Version = { id: string; entryId: string; title: string; body: string; tags: string[]; via: string; roomId: string | null; editedById: string | null; createdAt: Date }
type Message = { id: string; kind: string; content: string; toolCalls: unknown }

const store = vi.hoisted(() => ({ entries: new Map<string, Entry>(), versions: [] as Version[], messages: new Map<string, Message>(), ids: 0 }))
/** Raw SQL: the row lock returns nothing; the delete's search for replies matches toolCalls as text, as LIKE does */
const queryRaw = vi.hoisted(() => async (sql: unknown, ...values: unknown[]): Promise<unknown[]> => {
  if (!(sql as string[]).join("?").includes('"toolCalls"::text LIKE')) return []
  const needle = String(values[0]).slice(1, -1)
  return [...store.messages.values()].filter((m) => m.toolCalls && JSON.stringify(m.toolCalls).includes(needle)).map((m) => ({ id: m.id, toolCalls: m.toolCalls }))
})
const db = vi.hoisted(() => {
  const byNewest = (a: Version, b: Version) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)
  const db = {
    $queryRaw: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(queryRaw),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    knowledgeEntry: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date()
        const entry = { id: `entry-${++store.ids}`, archivedAt: null, createdAt: now, updatedAt: now, ...data } as unknown as Entry
        store.entries.set(entry.id, entry)
        return { ...entry }
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const entry = store.entries.get(where.id)
        return entry ? { ...entry } : null
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const entry = { ...store.entries.get(where.id)!, ...data, updatedAt: new Date() } as Entry
        store.entries.set(entry.id, entry)
        return { ...entry }
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; archivedAt: null | { not: null } }; data: Record<string, unknown> }) => {
        const entry = store.entries.get(where.id)
        const matches = entry && (where.archivedAt === null ? entry.archivedAt === null : entry.archivedAt !== null)
        if (!matches) return { count: 0 }
        store.entries.set(entry.id, { ...entry, ...data, updatedAt: new Date() } as Entry)
        return { count: 1 }
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const entry = store.entries.get(where.id)
        if (!entry) throw new Prisma.PrismaClientKnownRequestError("No record", { code: "P2025", clientVersion: "test" })
        store.entries.delete(where.id)
        store.versions = store.versions.filter((v) => v.entryId !== where.id)
        return entry
      }),
    },
    knowledgeEntryVersion: {
      create: vi.fn(async ({ data }: { data: Omit<Version, "id" | "createdAt"> & { createdAt?: Date } }) => {
        const version = { id: `version-${++store.ids}`, createdAt: new Date(), ...data } as Version
        store.versions.push(version)
        return { id: version.id }
      }),
      findFirst: vi.fn(async ({ where }: { where: { entryId: string } }) => {
        const [latest] = store.versions.filter((v) => v.entryId === where.entryId).sort(byNewest)
        return latest ? { id: latest.id, createdAt: latest.createdAt } : null
      }),
      findMany: vi.fn(async ({ where }: { where: { entryId: string } }) => store.versions.filter((v) => v.entryId === where.entryId)),
    },
    jackMessage: {
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] }; kind: string }; data: Partial<Message> }) => {
        const hits = where.id.in.map((id) => store.messages.get(id)).filter((m): m is Message => !!m && m.kind === where.kind)
        for (const m of hits) store.messages.set(m.id, { ...m, ...data })
        return { count: hits.length }
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Message> }) => {
        const m = { ...store.messages.get(where.id)!, ...data }
        store.messages.set(m.id, m)
        return m
      }),
    },
  }
  return db
})
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)

import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  findKnowledgeDuplicates,
  knowledgeSecret,
  latestKnowledgeVersionId,
  markKnowledgeReviewed,
  scoreDuplicates,
  setKnowledgeArchived,
  updateKnowledgeEntry,
  type KnowledgeWriter,
} from "./service"

const officer: KnowledgeWriter = { userId: "officer-1", via: "admin" }
const jack: KnowledgeWriter = { userId: "officer-2", via: "jack", roomId: "room-1", messageId: "reply-1" }
// Built from pieces, so nothing scanning the repo mistakes it for a real key
const FAKE_STRIPE_KEY = "sk_" + "live_" + "a1b2c3d4".repeat(4)

const versionsOf = (entryId: string) => store.versions.filter((v) => v.entryId === entryId)
const auditCall = (i = 0) => audit.createAuditLog.mock.calls[i][0]

/** A duplicate query row, as Postgres returns it (counts as bigint) */
const countRow = (id: string, title: string, shared: { title?: number; text?: number }) => ({
  id,
  title,
  updatedAt: new Date("2026-10-01T12:00:00Z"),
  newTitle: BigInt(3),
  newText: BigInt(20),
  oldTitle: BigInt(3),
  oldText: BigInt(20),
  sharedTitle: BigInt(shared.title ?? 0),
  sharedText: BigInt(shared.text ?? 0),
})

async function seedEntry(fields: Partial<{ title: string; body: string; tags: string[] }> = {}, writer = officer) {
  const result = await createKnowledgeEntry({ title: "LSC entry fee", body: "$10, or $5 for returning drivers.", tags: ["lsc"], ...fields }, writer)
  if (!result.ok) throw new Error(result.error)
  // Only what the test itself does counts
  vi.clearAllMocks()
  return result
}

beforeEach(() => {
  store.entries.clear()
  store.versions = []
  store.messages.clear()
  store.ids = 0
  vi.clearAllMocks()
  db.$queryRaw.mockReset().mockImplementation(queryRaw)
})

describe("createKnowledgeEntry", () => {
  it("saves the entry and its first version, and audits it without the text", async () => {
    const result = await createKnowledgeEntry({ title: "  Dues policy ", body: "No dues this semester.", tags: ["Policy", "Dues", "policy"], sourceNote: "  " }, officer)

    expect(result).toMatchObject({ ok: true, changed: true, entry: { title: "Dues policy", tags: ["policy", "dues"], sourceType: "MANUAL", sourceNote: null, reviewedAt: null } })
    if (!result.ok) return
    expect(versionsOf(result.entry.id)).toEqual([expect.objectContaining({ id: result.versionId, title: "Dues policy", body: "No dues this semester.", via: "admin", editedById: "officer-1" })])
    expect(auditCall()).toMatchObject({ actionType: "CREATE", entityType: "KNOWLEDGE_ENTRY", entityId: result.entry.id, actorUserId: "officer-1", metadata: { via: "admin", versionId: result.versionId } })
    expect(JSON.stringify(auditCall())).not.toContain("No dues this semester")
  })

  it("marks Jack's saves as his and never reviewed, with where they came from", async () => {
    const provenance = { roomId: "room-1", replyId: "reply-1", messageIds: [], askedBy: { userId: "officer-2", name: "Dylan" }, tools: [], at: "2026-10-22T17:00:00.000Z" }
    const result = await createKnowledgeEntry({ title: "Dues policy", body: "No dues this semester." }, jack, { reviewedAt: new Date(), provenance })

    expect(result).toMatchObject({ ok: true, entry: { sourceType: "JACK", reviewedAt: null, reviewedById: null, provenance } })
    if (!result.ok) return
    expect(versionsOf(result.entry.id)[0]).toMatchObject({ via: "jack", roomId: "room-1" })
    expect(auditCall().metadata).toMatchObject({ via: "jack", roomId: "room-1", messageId: "reply-1" })
  })

  it("loads seeds as reviewed on the sign-off date", async () => {
    const signedOff = new Date("2026-10-25T05:00:00Z")
    const result = await createKnowledgeEntry({ title: "Club colors", body: "Burnt orange and charcoal." }, { userId: "gray", via: "seed" }, { reviewedAt: signedOff, skipDuplicateCheck: true })
    expect(result).toMatchObject({ ok: true, entry: { sourceType: "SEED", reviewedAt: signedOff, reviewedById: "gray" } })
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it("keeps the ids of Jack's room notes with the entry, from one change to the next", async () => {
    const provenance = (replyId: string) => ({ roomId: "room-1", replyId, messageIds: [], askedBy: { userId: "officer-2", name: "Dylan" }, tools: [], at: "2026-10-22T17:00:00.000Z" })
    const saved = await createKnowledgeEntry({ title: "Dues policy", body: "No dues this semester." }, jack, { provenance: provenance("reply-1"), noteId: "note-1" })
    if (!saved.ok) throw new Error(saved.error)
    expect(saved.entry.provenance).toMatchObject({ replyId: "reply-1", noteIds: ["note-1"] })

    await updateKnowledgeEntry(saved.entry.id, { body: "No dues this year." }, jack, { baseVersionId: saved.versionId, provenance: provenance("reply-2"), noteId: "note-2" })
    // An officer's edit on the page leaves them as they are
    await updateKnowledgeEntry(saved.entry.id, { title: "Dues policy 2026" }, officer)
    expect(store.entries.get(saved.entry.id)!.provenance).toMatchObject({ replyId: "reply-2", noteIds: ["note-1", "note-2"] })
  })

  it("refuses what doesn't validate, with the reason", async () => {
    expect(await createKnowledgeEntry({ title: "Hi", body: "Text" }, officer)).toMatchObject({ ok: false, reason: "invalid", error: expect.stringMatching(/title/) })
    expect(await createKnowledgeEntry({ title: "Long one", body: "x".repeat(8_001) }, jack)).toMatchObject({ ok: false, reason: "invalid", error: expect.stringMatching(/8,000 characters/) })
    expect(await createKnowledgeEntry({ title: "Long one", body: "x".repeat(8_001) }, officer)).toMatchObject({ ok: true })
    expect(await createKnowledgeEntry({ title: "Bad link", body: "Text", sourceUrl: "javascript:alert(1)" }, officer)).toMatchObject({ ok: false, reason: "invalid", error: expect.stringMatching(/source link/) })
  })

  it("refuses anything that looks like a secret, in any field, before touching the database", async () => {
    for (const fields of [
      { title: "Stripe", body: `The key is ${FAKE_STRIPE_KEY}` },
      { title: "Stripe", body: "Ask Gray.", sourceNote: `from ${FAKE_STRIPE_KEY}` },
      { title: "Discord", body: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" },
    ]) {
      expect(await createKnowledgeEntry(fields, jack)).toMatchObject({ ok: false, reason: "secret", error: expect.stringMatching(/can't hold passwords, keys or tokens/) })
    }
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled()
    expect(knowledgeSecret({ title: "Where the Stripe key lives", body: "In Vercel's env settings; Gray has access." })).toBeNull()
  })

  it("refuses a duplicate with the close entries, unless the caller names them", async () => {
    db.$queryRaw.mockResolvedValueOnce([countRow("entry-9", "Dues policy", { title: 3 }), countRow("entry-8", "Other", { title: 1, text: 2 })])
    const refused = await createKnowledgeEntry({ title: "Dues policy", body: "No dues." }, jack)
    expect(refused).toMatchObject({ ok: false, reason: "duplicate", duplicates: [{ id: "entry-9", title: "Dues policy", reason: "title", score: 1 }] })
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled()

    await createKnowledgeEntry({ title: "Dues policy", body: "No dues." }, jack, { notDuplicateOf: ["entry-9"] })
    // The named entries are left out of the query
    expect(db.$queryRaw.mock.calls[1]).toContainEqual(["entry-9"])
    expect(db.knowledgeEntry.create).toHaveBeenCalledTimes(1)
  })
})

describe("updateKnowledgeEntry", () => {
  it("writes a new version on top of the one it was based on", async () => {
    const { entry, versionId } = await seedEntry()
    const result = await updateKnowledgeEntry(entry.id, { body: "$12, or $6 for returning drivers." }, officer, { baseVersionId: versionId })

    expect(result).toMatchObject({ ok: true, changed: true, entry: { body: "$12, or $6 for returning drivers.", title: "LSC entry fee" } })
    expect(versionsOf(entry.id)).toHaveLength(2)
    expect(result.ok && result.versionId).not.toBe(versionId)
    expect(await latestKnowledgeVersionId(entry.id)).toBe(result.ok ? result.versionId : null)
    // The row lock comes first, inside the transaction
    expect((db.$queryRaw.mock.calls[0][0] as string[]).join("?")).toContain("FOR UPDATE")
    expect(auditCall()).toMatchObject({ actionType: "UPDATE", metadata: { bodyChanged: true }, before: { title: "LSC entry fee" } })
    expect(JSON.stringify(auditCall())).not.toContain("$12")
  })

  it("refuses a change based on an older version, with the current text", async () => {
    const { entry, versionId: first } = await seedEntry()
    const second = await updateKnowledgeEntry(entry.id, { body: "Changed by Dylan." }, officer, { baseVersionId: first })
    const stale = await updateKnowledgeEntry(entry.id, { body: "Changed by Jack." }, jack, { baseVersionId: first })

    expect(stale).toMatchObject({ ok: false, reason: "conflict", current: { versionId: second.ok ? second.versionId : "", body: "Changed by Dylan.", title: "LSC entry fee" } })
    expect(versionsOf(entry.id)).toHaveLength(2)
  })

  it("needs a base version from Jack", async () => {
    const { entry } = await seedEntry()
    expect(await updateKnowledgeEntry(entry.id, { body: "New" }, jack)).toMatchObject({ ok: false, reason: "missing_base" })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("keeps the review for an officer's details-only change, without a version", async () => {
    const { entry, versionId } = await seedEntry()
    const reviewed = await updateKnowledgeEntry(entry.id, {}, officer, { baseVersionId: versionId, markReviewed: true })
    expect(reviewed).toMatchObject({ ok: true, entry: { reviewedById: "officer-1" } })
    expect(reviewed.ok && reviewed.entry.reviewedAt).toBeInstanceOf(Date)

    const details = await updateKnowledgeEntry(entry.id, { sourceNote: "Test Officer, Discord" }, officer, { baseVersionId: versionId })
    expect(details).toMatchObject({ ok: true, changed: true, versionId, entry: { sourceNote: "Test Officer, Discord" }, before: { sourceNote: null } })
    expect(details.ok && details.entry.reviewedAt).toBeInstanceOf(Date)
    expect(versionsOf(entry.id)).toHaveLength(1)
  })

  it("clears the review on any change of Jack's, details included, and versions each one", async () => {
    const { entry, versionId } = await seedEntry()
    await updateKnowledgeEntry(entry.id, {}, officer, { baseVersionId: versionId, markReviewed: true })

    // A new source date alone would make a stale entry look fresh: it's his change, so it's not reviewed
    const details = await updateKnowledgeEntry(entry.id, { sourceDate: new Date("2026-10-22T05:00:00Z") }, jack, { baseVersionId: versionId })
    expect(details).toMatchObject({ ok: true, changed: true, entry: { reviewedAt: null, reviewedById: null } })
    expect(details.ok && details.versionId).not.toBe(versionId)
    expect(versionsOf(entry.id).at(-1)).toMatchObject({ via: "jack", body: entry.body })

    const text = await updateKnowledgeEntry(entry.id, { body: "$12 now." }, jack, { baseVersionId: details.ok ? details.versionId : null })
    expect(text).toMatchObject({ ok: true, entry: { reviewedAt: null, reviewedById: null } })
    expect(versionsOf(entry.id).at(-1)).toMatchObject({ via: "jack", roomId: "room-1", body: "$12 now." })
    expect(versionsOf(entry.id)).toHaveLength(3)
  })

  it("lets Jack change a long entry from the page, as long as he doesn't make it longer", async () => {
    const long = "Long text. ".repeat(1_100).trim()
    const { entry, versionId } = await seedEntry({ body: long })
    expect(entry.body.length).toBeGreaterThan(8_000)

    const retagged = await updateKnowledgeEntry(entry.id, { tags: ["lsc", "fees"] }, jack, { baseVersionId: versionId })
    expect(retagged).toMatchObject({ ok: true, changed: true })
    const base = retagged.ok ? retagged.versionId : null
    expect(await updateKnowledgeEntry(entry.id, { body: long.replace("Long text.", "Short.") }, jack, { baseVersionId: base })).toMatchObject({ ok: true, changed: true })
    const grown = await updateKnowledgeEntry(entry.id, { body: `${long} More.` }, jack, { baseVersionId: await latestKnowledgeVersionId(entry.id) })
    // Past what it is now (his shorter text), it's refused
    expect(grown).toMatchObject({ ok: false, reason: "invalid", error: expect.stringMatching(/Keep the entry to 12,095 characters/) })
  })

  it("re-dates a seed's review on a new sign-off, with a new version only for new text", async () => {
    const seed: KnowledgeWriter = { userId: "gray", via: "seed" }
    const { entry, versionId } = await seedEntry({}, seed)
    const signedOff = new Date("2026-11-01T05:00:00Z")
    expect(await updateKnowledgeEntry(entry.id, { body: entry.body }, seed, { reviewedAt: signedOff })).toMatchObject({ ok: true, changed: true, versionId, entry: { reviewedAt: signedOff, reviewedById: "gray" } })
    expect(versionsOf(entry.id)).toHaveLength(1)
    // The same sign-off again changes nothing
    expect(await updateKnowledgeEntry(entry.id, { body: entry.body }, seed, { reviewedAt: signedOff })).toMatchObject({ ok: true, changed: false })
  })

  it("does nothing when nothing changes", async () => {
    const { entry, versionId } = await seedEntry()
    expect(await updateKnowledgeEntry(entry.id, { title: "LSC entry fee", tags: ["LSC"] }, officer, { baseVersionId: versionId })).toMatchObject({ ok: true, changed: false, versionId })
    expect(db.knowledgeEntry.update).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("keeps versions in order even when this server's clock is behind the last one", async () => {
    const { entry, versionId } = await seedEntry()
    const ahead = new Date(Date.now() + 60_000)
    store.versions[0].createdAt = ahead
    await updateKnowledgeEntry(entry.id, { body: "Later" }, officer, { baseVersionId: versionId })
    expect(versionsOf(entry.id)[1].createdAt.getTime()).toBe(ahead.getTime() + 1)
  })

  it("leaves archived entries to officers, and refuses secrets and missing entries", async () => {
    const { entry, versionId } = await seedEntry()
    await setKnowledgeArchived(entry.id, true, officer)
    expect(await updateKnowledgeEntry(entry.id, { body: "x" }, jack, { baseVersionId: versionId })).toMatchObject({ ok: false, reason: "archived" })
    expect(await updateKnowledgeEntry(entry.id, { body: "Fixed" }, officer, { baseVersionId: versionId, allowArchived: true })).toMatchObject({ ok: true, changed: true })
    expect(await updateKnowledgeEntry(entry.id, { body: `key ${FAKE_STRIPE_KEY}` }, officer, { allowArchived: true })).toMatchObject({ ok: false, reason: "secret" })
    expect(await updateKnowledgeEntry("missing", { body: "x" }, officer)).toMatchObject({ ok: false, reason: "not_found" })
  })
})

describe("review, archive and delete", () => {
  it("marks an entry reviewed now, by the officer", async () => {
    const { entry, versionId } = await seedEntry()
    const result = await markKnowledgeReviewed(entry.id, officer, { baseVersionId: versionId })
    expect(result).toMatchObject({ ok: true, entry: { reviewedById: "officer-1" } })
    expect((db.$queryRaw.mock.calls[0][0] as string[]).join("?")).toContain("FOR UPDATE")
    expect(auditCall()).toMatchObject({ actionType: "REVIEW" })
    expect(await markKnowledgeReviewed("missing", officer)).toMatchObject({ ok: false, reason: "not_found" })
  })

  it("won't mark reviewed a version the officer hasn't seen", async () => {
    const { entry, versionId } = await seedEntry()
    // Jack changed it in a room while the officer had the page open
    await updateKnowledgeEntry(entry.id, { body: "Jack's newer text." }, jack, { baseVersionId: versionId })
    vi.clearAllMocks()

    expect(await markKnowledgeReviewed(entry.id, officer, { baseVersionId: versionId })).toMatchObject({ ok: false, reason: "conflict", error: expect.stringMatching(/changed since you opened it/) })
    expect(store.entries.get(entry.id)!.reviewedAt).toBeNull()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("archives and unarchives once each, auditing only real changes", async () => {
    const { entry } = await seedEntry()
    expect(await setKnowledgeArchived(entry.id, true, jack, "Replaced by the S3 entry")).toMatchObject({ ok: true, changed: true })
    expect(store.entries.get(entry.id)!.archivedAt).toBeInstanceOf(Date)
    expect(auditCall()).toMatchObject({ actionType: "ARCHIVE", summary: "Jack archived knowledge entry: LSC entry fee", metadata: { reason: "Replaced by the S3 entry" } })
    expect(await setKnowledgeArchived(entry.id, true, officer)).toMatchObject({ ok: true, changed: false })
    expect(await setKnowledgeArchived(entry.id, false, officer)).toMatchObject({ ok: true, changed: true })
    expect(audit.createAuditLog).toHaveBeenCalledTimes(2)
    expect(await setKnowledgeArchived("missing", true, officer)).toMatchObject({ ok: false, reason: "not_found" })
  })

  it("deletes an entry with its versions, keeping only its title in the audit log", async () => {
    const { entry } = await seedEntry({ body: "Private details nobody should keep." })
    expect(await deleteKnowledgeEntry(entry.id, officer)).toEqual({ ok: true, title: "LSC entry fee", cleared: { notes: 0, replies: 0 } })
    expect(store.entries.has(entry.id)).toBe(false)
    expect(versionsOf(entry.id)).toEqual([])
    expect(auditCall()).toMatchObject({ actionType: "DELETE", before: { title: "LSC entry fee" } })
    expect(JSON.stringify(auditCall())).not.toContain("Private details")
    expect(await deleteKnowledgeEntry(entry.id, officer)).toMatchObject({ ok: false, reason: "not_found" })
  })

  it("clears Jack's room notes and tool calls that held the text, and nothing else", async () => {
    const provenance = { roomId: "room-1", replyId: "reply-1", messageIds: [], askedBy: { userId: "officer-2", name: "Dylan" }, tools: [], at: "2026-10-22T17:00:00.000Z" }
    const { entry } = await seedEntry({ body: "Private details nobody should keep." }, jack)
    await updateKnowledgeEntry(entry.id, { body: "Private details, changed." }, jack, { baseVersionId: await latestKnowledgeVersionId(entry.id), provenance, noteId: "note-1" })
    const savePart = { id: "t1", name: "knowledge", label: "Saved “LSC entry fee” to knowledge", status: "done", at: 0, input: { action: "save", title: "LSC entry fee", body: "Private details nobody should keep." }, displays: [{ kind: "links", items: [{ title: "LSC entry fee", url: `/admin/knowledge/${entry.id}`, snippet: "Private details" }] }] }
    const sqlPart = { id: "t2", name: "run_sql", label: "Ran a query (1 row)", status: "done", at: 0, input: { sql: "select 1" }, displays: [] }
    store.messages.set("note-1", { id: "note-1", kind: "system", content: "Updated in knowledge for Dylan: “LSC entry fee”\n\nPrivate details, changed.", toolCalls: null })
    store.messages.set("reply-1", { id: "reply-1", kind: "assistant", content: "Saved it.", toolCalls: [savePart, sqlPart] })
    store.messages.set("reply-9", { id: "reply-9", kind: "assistant", content: "Unrelated.", toolCalls: [sqlPart] })
    vi.clearAllMocks()

    expect(await deleteKnowledgeEntry(entry.id, officer)).toEqual({ ok: true, title: "LSC entry fee", cleared: { notes: 1, replies: 1 } })
    expect(store.messages.get("note-1")!.content).toBe("A knowledge entry saved here was deleted.")
    expect(store.messages.get("reply-1")!.toolCalls).toEqual([{ ...savePart, input: { action: "save" }, label: "A knowledge entry, deleted since", displays: [] }, sqlPart])
    expect(JSON.stringify([...store.messages.values()])).not.toContain("Private details")
    expect(db.jackMessage.update).toHaveBeenCalledTimes(1)
    // All in one transaction, after the row lock
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect((db.$queryRaw.mock.calls[0][0] as string[]).join("?")).toContain("FOR UPDATE")
    expect(auditCall().metadata).toMatchObject({ cleared: { notes: 1, replies: 1 } })
  })
})

describe("duplicates", () => {
  it("scores the query's rows: closest first, at most five, misses dropped", async () => {
    const rows = [
      // 13 of 20 shared each way: Jaccard 13/27
      countRow("a", "Somewhat", { text: 13 }),
      countRow("b", "Same title", { title: 3 }),
      countRow("c", "Unrelated", { text: 1 }),
      // 2 of 3 title words each: Jaccard 0.5, under the bar
      countRow("d", "Close title", { title: 2 }),
    ]
    expect(scoreDuplicates(rows).map((d) => [d.id, d.reason, d.score])).toEqual([
      ["b", "title", 1],
      ["a", "text", 0.48],
    ])
    expect(scoreDuplicates(["p", "q", "r", "s", "t", "u"].map((id) => countRow(id, id, { title: 3 })))).toHaveLength(5)
  })

  it("passes the new entry's title and text to the query", async () => {
    await findKnowledgeDuplicates({ title: "Dues", body: "No dues.", tags: ["policy"] }, { exclude: ["x"] })
    const values = db.$queryRaw.mock.calls[0].slice(1)
    expect(values).toEqual(expect.arrayContaining(["Dues", "Dues\npolicy\nNo dues.", ["x"]]))
  })
})
