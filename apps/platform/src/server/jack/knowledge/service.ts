import { Prisma, type KnowledgeEntry, type KnowledgeSource } from "@prisma/client"
import { z } from "zod"
import { DELETED_KNOWLEDGE_NOTE, KNOWLEDGE_LIMITS, knowledgeNoteIds, normalizeTags, scrubDeletedKnowledge, type KnowledgeProvenance } from "@/lib/jack/knowledge"
import { partLink } from "@/lib/jack/links"
import { findSecret } from "@/lib/redact"
import { createAuditLog } from "@/server/audit/log"
import { prisma } from "@/server/db"
import { duplicateMatch, type LexemeCounts } from "./similarity"

/**
 * The knowledge base (#188, design §9): every create, edit, review, archive and delete goes through
 * here, from the Knowledge page, Jack's knowledge tool and the seed loader alike.
 *
 * - Every content change (title, body or tags) writes a KnowledgeEntryVersion. An update can name the
 *   version it was based on (`baseVersionId`); if the entry has moved on since, it's refused with the
 *   current text instead of overwriting someone else's change. Jack's updates must name one.
 * - Nothing that looks like a secret is saved (findSecret, the same check as redactSecrets).
 * - A new entry is checked against the existing ones (title and full-text similarity) and refused
 *   with the close ones, unless the caller names them in `notDuplicateOf`.
 * - Jack's saves and changes (to the text or the details) leave the entry "not reviewed" (reviewedAt
 *   cleared) until an officer marks it reviewed, and each writes a version, so they show in History.
 * - Archive hides an entry. Delete removes it and its versions for good, and clears the copies Jack
 *   left in rooms: his notes with its text, and its text in his tool calls.
 * - Each change writes an audit entry with titles and tags, never bodies, so a hard delete really
 *   removes the text. Callers revalidate pages (scripts have no Next.js cache to revalidate).
 */

export type KnowledgeVia = "admin" | "jack" | "seed"

/** Who's changing an entry, and from where */
export type KnowledgeWriter = {
  /** The officer (null for a script without an account) */
  userId: string | null
  via: KnowledgeVia
  /** Jack's changes: the room and reply they came from */
  roomId?: string | null
  messageId?: string | null
}

export type KnowledgeFields = {
  title: string
  /** Markdown */
  body: string
  tags?: string[]
  sourceUrl?: string | null
  sourceNote?: string | null
  sourceDate?: Date | null
  ownerId?: string | null
}

/** An existing entry that looks like the one being saved */
export type KnowledgeDuplicate = { id: string; title: string; updatedAt: Date; score: number; reason: "title" | "text" }

/** The entry as it is now, for a caller whose base version is out of date */
export type KnowledgeCurrent = { versionId: string | null; title: string; body: string; tags: string[]; updatedAt: Date; updatedById: string | null }

export type KnowledgeWriteResult =
  /** `before`: an update's entry as it was */
  | { ok: true; entry: KnowledgeEntry; versionId: string | null; changed: boolean; before?: KnowledgeEntry }
  | { ok: false; reason: "invalid" | "secret" | "not_found" | "archived" | "missing_base"; error: string }
  | { ok: false; reason: "duplicate"; error: string; duplicates: KnowledgeDuplicate[] }
  | { ok: false; reason: "conflict"; error: string; current: KnowledgeCurrent }

export type KnowledgeChangeResult = { ok: true; entry: KnowledgeEntry; changed: boolean } | { ok: false; reason: "not_found" | "conflict"; error: string }

const NOT_FOUND = { ok: false, reason: "not_found", error: "That knowledge entry doesn't exist (it may have been deleted)." } as const

const blankToNull = (value: unknown) => (typeof value === "string" && !value.trim() ? null : value)

const sourceUrl = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .max(KNOWLEDGE_LIMITS.sourceUrlMax)
    .refine((url) => partLink(url) !== null, "The source link must be a site path (/…) or an http(s) link.")
    .nullable(),
)

function fieldsSchema(bodyMax: number) {
  return z.object({
    title: z
      .string()
      .trim()
      .min(3, "Give the entry a title (3 characters or more).")
      .max(KNOWLEDGE_LIMITS.titleMax, `Keep the title to ${KNOWLEDGE_LIMITS.titleMax} characters.`),
    body: z
      .string()
      .trim()
      .min(1, "The entry has no text.")
      .max(bodyMax, `Keep the entry to ${bodyMax.toLocaleString("en-US")} characters; split a longer one into several entries.`),
    tags: z.array(z.string().max(200)).max(50).default([]).transform(normalizeTags),
    sourceUrl: sourceUrl.default(null),
    sourceNote: z.preprocess(blankToNull, z.string().trim().max(KNOWLEDGE_LIMITS.sourceNoteMax, `Keep the source note to ${KNOWLEDGE_LIMITS.sourceNoteMax} characters.`).nullable()).default(null),
    sourceDate: z.date().nullable().default(null),
    ownerId: z.string().min(1).nullable().default(null),
  })
}

type CleanFields = z.output<ReturnType<typeof fieldsSchema>>

/**
 * The longest body a writer may leave. Jack writes short notes (jackBodyMax), but he can still change a
 * longer entry from the page or the seed, as long as he doesn't make it longer than it was
 */
function bodyLimit(via: KnowledgeVia, before?: { body: string }): number {
  if (via !== "jack") return KNOWLEDGE_LIMITS.bodyMax
  return Math.min(KNOWLEDGE_LIMITS.bodyMax, Math.max(KNOWLEDGE_LIMITS.jackBodyMax, before?.body.length ?? 0))
}

function validate(fields: KnowledgeFields, bodyMax: number): { ok: true; data: CleanFields } | { ok: false; reason: "invalid"; error: string } {
  const parsed = fieldsSchema(bodyMax).safeParse(fields)
  if (!parsed.success) return { ok: false, reason: "invalid", error: parsed.error.issues[0]?.message ?? "Check the entry." }
  return { ok: true, data: parsed.data }
}

/** What kind of secret an entry seems to hold ("a Stripe key"), or null. Every text field counts */
export function knowledgeSecret(fields: Pick<KnowledgeFields, "title" | "body"> & Partial<KnowledgeFields>): string | null {
  return findSecret([fields.title, fields.body, (fields.tags ?? []).join(" "), fields.sourceNote ?? "", fields.sourceUrl ?? ""].join("\n"))
}

function secretRefusal(kind: string) {
  return {
    ok: false,
    reason: "secret",
    error: `This looks like it holds ${kind}. Knowledge entries can't hold passwords, keys or tokens; say where the secret is kept instead (for example "in Vercel's env settings").`,
  } as const
}

/** The fields a version keeps, compared to see whether a change is a new version */
const sameContent = (a: { title: string; body: string; tags: string[] }, b: { title: string; body: string; tags: string[] }) =>
  a.title === b.title && a.body === b.body && a.tags.length === b.tags.length && a.tags.every((tag, i) => tag === b.tags[i])

const sameDate = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null)

/** What an audit entry keeps of an entry: never its body, so a hard delete leaves no copy of the text */
const auditView = (entry: Pick<KnowledgeEntry, "title" | "tags" | "sourceType" | "sourceNote" | "ownerId" | "archivedAt" | "reviewedAt">) => ({
  title: entry.title,
  tags: entry.tags,
  sourceType: entry.sourceType,
  sourceNote: entry.sourceNote,
  ownerId: entry.ownerId,
  archivedAt: entry.archivedAt,
  reviewedAt: entry.reviewedAt,
})

const auditMetadata = (writer: KnowledgeWriter, extra: Record<string, unknown> = {}) => ({
  via: writer.via,
  ...(writer.roomId ? { roomId: writer.roomId } : {}),
  ...(writer.messageId ? { messageId: writer.messageId } : {}),
  ...extra,
})

const SOURCE_FOR: Record<KnowledgeVia, KnowledgeSource> = { admin: "MANUAL", jack: "JACK", seed: "SEED" }

/**
 * The provenance to keep: the reply's (when there's a new one), with the ids of every room note Jack
 * has posted about the entry, carried from one change to the next, so a hard delete can clear them all
 */
function provenanceToStore(provenance: KnowledgeProvenance | undefined, previous: unknown, noteId: string | undefined): Prisma.InputJsonValue | undefined {
  if (!provenance && !noteId) return undefined
  const base = provenance ?? (previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {})
  return { ...base, noteIds: [...knowledgeNoteIds(previous), ...(noteId ? [noteId] : [])] } as Prisma.InputJsonValue
}

/** Locks an entry's row for the rest of the transaction: one change at a time per entry */
const lockEntry = (tx: Prisma.TransactionClient, id: string) => tx.$queryRaw`SELECT id FROM "KnowledgeEntry" WHERE id = ${id} FOR UPDATE`

const latestVersion = (tx: Prisma.TransactionClient, entryId: string) =>
  tx.knowledgeEntryVersion.findFirst({ where: { entryId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, createdAt: true } })

export type CreateKnowledgeOptions = {
  /** Defaults from the writer: MANUAL for the page, JACK for Jack, SEED for the seed loader */
  sourceType?: KnowledgeSource
  /** Seeds: the sign-off date. Jack's saves are never reviewed */
  reviewedAt?: Date | null
  /** Jack's saves: the room, reply and tools behind it */
  provenance?: KnowledgeProvenance
  /** Jack's saves: the id of the room note he posts with the text (kept, so a hard delete clears it) */
  noteId?: string
  /** Entries the caller has seen and says this isn't a duplicate of */
  notDuplicateOf?: string[]
  /** The seed loader reports duplicates itself */
  skipDuplicateCheck?: boolean
}

/** Saves a new entry and its first version */
export async function createKnowledgeEntry(fields: KnowledgeFields, writer: KnowledgeWriter, options: CreateKnowledgeOptions = {}): Promise<KnowledgeWriteResult> {
  const valid = validate(fields, bodyLimit(writer.via))
  if (!valid.ok) return valid
  const data = valid.data
  const secret = knowledgeSecret(data)
  if (secret) return secretRefusal(secret)

  if (!options.skipDuplicateCheck) {
    const duplicates = await findKnowledgeDuplicates(data, { exclude: options.notDuplicateOf })
    if (duplicates.length) {
      return {
        ok: false,
        reason: "duplicate",
        error: `There's already ${duplicates.length === 1 ? "an entry" : "entries"} like this: ${duplicates.map((d) => `“${d.title}”`).join(", ")}. Update ${duplicates.length === 1 ? "it" : "one of them"} instead, or save again saying it isn't a duplicate.`,
        duplicates,
      }
    }
  }

  const reviewedAt = writer.via === "jack" ? null : (options.reviewedAt ?? null)
  const { entry, versionId } = await prisma.$transaction(async (tx) => {
    const entry = await tx.knowledgeEntry.create({
      data: {
        ...data,
        sourceType: options.sourceType ?? SOURCE_FOR[writer.via],
        reviewedAt,
        reviewedById: reviewedAt ? writer.userId : null,
        provenance: provenanceToStore(options.provenance, null, options.noteId) ?? Prisma.DbNull,
        createdById: writer.userId,
        updatedById: writer.userId,
      },
    })
    const version = await tx.knowledgeEntryVersion.create({
      data: { entryId: entry.id, title: entry.title, body: entry.body, tags: entry.tags, editedById: writer.userId, via: writer.via, roomId: writer.roomId ?? null },
      select: { id: true },
    })
    return { entry, versionId: version.id }
  })

  await createAuditLog({
    actorUserId: writer.userId,
    actionType: "CREATE",
    entityType: "KNOWLEDGE_ENTRY",
    entityId: entry.id,
    summary: `${writer.via === "jack" ? "Jack saved" : writer.via === "seed" ? "Loaded from the seed" : "Created"} knowledge entry: ${entry.title}`,
    after: auditView(entry),
    metadata: auditMetadata(writer, { versionId, ...(options.notDuplicateOf?.length ? { notDuplicateOf: options.notDuplicateOf } : {}) }),
  })
  return { ok: true, entry, versionId, changed: true }
}

export type UpdateKnowledgeOptions = {
  /** The version the change was made from; a change based on an older one is refused with the current text. Jack's updates need one */
  baseVersionId?: string | null
  /** Jack's changes: the room, reply and tools behind it (replaces the entry's provenance) */
  provenance?: KnowledgeProvenance
  /** Jack's changes: the id of the room note he posts with the text (added to the ones kept) */
  noteId?: string
  /** An officer saving from the page can mark it reviewed as of now in the same step */
  markReviewed?: boolean
  /** The seed loader: reviewed as of the sign-off date */
  reviewedAt?: Date
  /** Officers can edit an archived entry on the page; Jack can't */
  allowArchived?: boolean
}

/**
 * Changes an entry. Fields left out stay as they are. A change to the title, body or tags writes a new
 * version; one to the source or owner only updates the entry, unless it's Jack's: every change of his
 * writes a version (so it shows in History and the base check sees it) and clears the review.
 */
export async function updateKnowledgeEntry(
  id: string,
  changes: Partial<KnowledgeFields>,
  writer: KnowledgeWriter,
  options: UpdateKnowledgeOptions = {},
): Promise<KnowledgeWriteResult> {
  if (writer.via === "jack" && !options.baseVersionId) {
    return { ok: false, reason: "missing_base", error: "Read the entry first and pass the versionId you read as baseVersionId." }
  }

  const outcome: KnowledgeWriteResult = await prisma.$transaction(async (tx) => {
    // One change at a time per entry: the base check and the new version can't interleave with another
    await lockEntry(tx, id)
    const before = await tx.knowledgeEntry.findUnique({ where: { id } })
    if (!before) return NOT_FOUND
    if (before.archivedAt && !options.allowArchived) {
      return { ok: false, reason: "archived", error: `“${before.title}” is archived. An officer can unarchive it on the Knowledge page first.` }
    }

    const latest = await latestVersion(tx, id)
    if (options.baseVersionId && options.baseVersionId !== latest?.id) {
      return {
        ok: false,
        reason: "conflict",
        error: `“${before.title}” changed since that version was read. Here's the current text; make the change on top of it, with this versionId as baseVersionId.`,
        current: { versionId: latest?.id ?? null, title: before.title, body: before.body, tags: before.tags, updatedAt: before.updatedAt, updatedById: before.updatedById },
      }
    }

    const valid = validate(
      {
        title: changes.title ?? before.title,
        body: changes.body ?? before.body,
        tags: changes.tags ?? before.tags,
        sourceUrl: changes.sourceUrl !== undefined ? changes.sourceUrl : before.sourceUrl,
        sourceNote: changes.sourceNote !== undefined ? changes.sourceNote : before.sourceNote,
        sourceDate: changes.sourceDate !== undefined ? changes.sourceDate : before.sourceDate,
        ownerId: changes.ownerId !== undefined ? changes.ownerId : before.ownerId,
      },
      bodyLimit(writer.via, before),
    )
    if (!valid.ok) return valid
    const data = valid.data
    const secret = knowledgeSecret(data)
    if (secret) return secretRefusal(secret)

    const contentChanged = !sameContent(data, before)
    const otherChanged =
      data.sourceUrl !== before.sourceUrl || data.sourceNote !== before.sourceNote || !sameDate(data.sourceDate, before.sourceDate) || data.ownerId !== before.ownerId
    const reviewChanged = !!options.reviewedAt && options.reviewedAt.getTime() !== before.reviewedAt?.getTime()
    if (!contentChanged && !otherChanged && !options.markReviewed && !reviewChanged) return { ok: true, entry: before, versionId: latest?.id ?? null, changed: false }

    const now = new Date()
    // Any change of Jack's, details included: a new source date would otherwise make his entry look fresh
    const byJack = writer.via === "jack" && (contentChanged || otherChanged)
    const provenance = provenanceToStore(options.provenance, before.provenance, options.noteId)
    const review = byJack
      ? { reviewedAt: null, reviewedById: null }
      : options.reviewedAt
        ? { reviewedAt: options.reviewedAt, reviewedById: writer.userId }
        : options.markReviewed
          ? { reviewedAt: now, reviewedById: writer.userId }
          : {}
    const entry = await tx.knowledgeEntry.update({
      where: { id },
      data: {
        ...data,
        ...review,
        ...(provenance !== undefined ? { provenance } : {}),
        updatedById: writer.userId,
      },
    })
    let versionId = latest?.id ?? null
    if (contentChanged || byJack) {
      // Versions are ordered by createdAt; keep each one after the last even if clocks disagree
      const createdAt = new Date(Math.max(now.getTime(), (latest?.createdAt.getTime() ?? 0) + 1))
      const version = await tx.knowledgeEntryVersion.create({
        data: { entryId: id, title: entry.title, body: entry.body, tags: entry.tags, editedById: writer.userId, via: writer.via, roomId: writer.roomId ?? null, createdAt },
        select: { id: true },
      })
      versionId = version.id
    }
    return { ok: true, entry, versionId, changed: true, before }
  })

  // Nothing to audit unless something changed (only a change carries `before`)
  if (!outcome.ok || !outcome.before) return outcome
  const { entry, versionId, before } = outcome
  const bodyChanged = entry.body !== before.body
  await createAuditLog({
    actorUserId: writer.userId,
    actionType: "UPDATE",
    entityType: "KNOWLEDGE_ENTRY",
    entityId: entry.id,
    summary: `${writer.via === "jack" ? "Jack updated" : writer.via === "seed" ? "Updated from the seed" : "Updated"} knowledge entry: ${entry.title}${bodyChanged ? "" : " (details only)"}`,
    before: auditView(before),
    after: auditView(entry),
    metadata: auditMetadata(writer, { versionId, bodyChanged, ...(options.markReviewed ? { markedReviewed: true } : {}) }),
  })
  return { ok: true, entry, versionId, changed: true, before }
}

/**
 * Marks an entry reviewed as of now: an officer checked it still holds. Restarts its age. With
 * `baseVersionId` (the version the officer was looking at), it's refused if the entry has a newer one:
 * text nobody has seen can't be marked reviewed
 */
export async function markKnowledgeReviewed(id: string, writer: KnowledgeWriter, options: { baseVersionId?: string | null } = {}): Promise<KnowledgeChangeResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    await lockEntry(tx, id)
    const before = await tx.knowledgeEntry.findUnique({ where: { id } })
    if (!before) return NOT_FOUND
    if (options.baseVersionId !== undefined && options.baseVersionId !== ((await latestVersion(tx, id))?.id ?? null)) {
      return { ok: false, reason: "conflict", error: `“${before.title}” changed since you opened it. Reload, check the new version, then mark it reviewed.` } as const
    }
    const entry = await tx.knowledgeEntry.update({ where: { id }, data: { reviewedAt: new Date(), reviewedById: writer.userId } })
    return { ok: true, entry, before } as const
  })
  if (!outcome.ok) return outcome
  const { entry, before } = outcome
  await createAuditLog({
    actorUserId: writer.userId,
    actionType: "REVIEW",
    entityType: "KNOWLEDGE_ENTRY",
    entityId: id,
    summary: `Marked knowledge entry reviewed: ${entry.title}`,
    before: { reviewedAt: before.reviewedAt },
    after: { reviewedAt: entry.reviewedAt },
    metadata: auditMetadata(writer),
  })
  return { ok: true, entry, changed: true }
}

/** Archives an entry (hidden from search and the default list, kept with its history), or brings it back */
export async function setKnowledgeArchived(id: string, archived: boolean, writer: KnowledgeWriter, reason?: string): Promise<KnowledgeChangeResult> {
  const { count } = await prisma.knowledgeEntry.updateMany({
    where: { id, archivedAt: archived ? null : { not: null } },
    data: { archivedAt: archived ? new Date() : null, updatedById: writer.userId },
  })
  const entry = await prisma.knowledgeEntry.findUnique({ where: { id } })
  if (!entry) return NOT_FOUND
  if (!count) return { ok: true, entry, changed: false }
  await createAuditLog({
    actorUserId: writer.userId,
    actionType: archived ? "ARCHIVE" : "UNARCHIVE",
    entityType: "KNOWLEDGE_ENTRY",
    entityId: id,
    summary: `${archived ? (writer.via === "jack" ? "Jack archived" : "Archived") : "Unarchived"} knowledge entry: ${entry.title}`,
    after: auditView(entry),
    metadata: auditMetadata(writer, reason ? { reason } : {}),
  })
  return { ok: true, entry, changed: true }
}

/** What a hard delete cleared in rooms besides the entry: Jack's notes with its text, and replies whose tool calls held it */
export type KnowledgeDeleteResult = { ok: true; title: string; cleared: { notes: number; replies: number } } | typeof NOT_FOUND

/** A LIKE pattern that matches `text` anywhere, literally */
const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/**
 * Deletes an entry and every version of it for good (the search index row goes with it, by trigger),
 * and in the same transaction clears the copies Jack left in rooms: his notes with its text say it was
 * deleted instead (the trigger re-indexes them), and the tool calls that saved, changed or showed it
 * lose its text (scrubDeletedKnowledge). Officers' own messages and Jack's reply text aren't changed.
 */
export async function deleteKnowledgeEntry(id: string, writer: KnowledgeWriter): Promise<KnowledgeDeleteResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    // Locked, so a change can't land between finding its copies and deleting it
    await lockEntry(tx, id)
    const entry = await tx.knowledgeEntry.findUnique({ where: { id } })
    if (!entry) return null
    const versions = await tx.knowledgeEntryVersion.findMany({ where: { entryId: id }, select: { title: true } })

    const noteIds = knowledgeNoteIds(entry.provenance)
    const notes = noteIds.length ? await tx.jackMessage.updateMany({ where: { id: { in: noteIds }, kind: "system" }, data: { content: DELETED_KNOWLEDGE_NOTE } }) : { count: 0 }

    // Every reply whose tool calls mention the entry: the calls that saved or changed it link to it or name its id
    const replies = await tx.$queryRaw<{ id: string; toolCalls: unknown }[]>`
      SELECT id, "toolCalls" FROM "JackMessage" WHERE "toolCalls" IS NOT NULL AND "toolCalls"::text LIKE ${containsPattern(id)}
    `
    const titles = [...new Set([entry.title, ...versions.map((v) => v.title)])]
    let replyCount = 0
    for (const reply of replies) {
      const scrubbed = scrubDeletedKnowledge(reply.toolCalls, { id, titles })
      if (!scrubbed.changed) continue
      await tx.jackMessage.update({ where: { id: reply.id }, data: { toolCalls: scrubbed.toolCalls as Prisma.InputJsonValue } })
      replyCount++
    }

    await tx.knowledgeEntry.delete({ where: { id } })
    return { entry, cleared: { notes: notes.count, replies: replyCount } }
  })
  if (!outcome) return NOT_FOUND

  const { entry, cleared } = outcome
  await createAuditLog({
    actorUserId: writer.userId,
    actionType: "DELETE",
    entityType: "KNOWLEDGE_ENTRY",
    entityId: id,
    summary: `Deleted knowledge entry and its history: ${entry.title}`,
    before: auditView(entry),
    metadata: auditMetadata(writer, { cleared }),
  })
  return { ok: true, title: entry.title, cleared }
}

/** The id of an entry's newest version: what an update passes as baseVersionId */
export async function latestKnowledgeVersionId(entryId: string): Promise<string | null> {
  return (await latestVersion(prisma, entryId))?.id ?? null
}

/** Most entries the duplicate check scores closely */
const DUPLICATE_CANDIDATES = 25
/** Most duplicates a refusal lists */
const DUPLICATES_SHOWN = 5

const COUNT_KEYS = ["newTitle", "newText", "oldTitle", "oldText", "sharedTitle", "sharedText"] as const

/** A candidate as the duplicate query returns it: counts come back as bigint */
export type DuplicateCountRow = { id: string; title: string; updatedAt: Date } & Record<(typeof COUNT_KEYS)[number], number | bigint>

/**
 * Entries (not archived) that look like this one: the 25 closest by Postgres's english lexemes,
 * scored by duplicateMatch. Uses the search index's vector (title, tags and body) when it has one.
 */
export async function findKnowledgeDuplicates(
  fields: { title: string; body: string; tags?: string[] },
  { exclude = [] }: { exclude?: string[] } = {},
): Promise<KnowledgeDuplicate[]> {
  const text = [fields.title, (fields.tags ?? []).join(" "), fields.body.slice(0, 100_000)].join("\n")
  const rows = await prisma.$queryRaw<DuplicateCountRow[]>`
    WITH probe AS (
      SELECT tsvector_to_array(to_tsvector('english'::regconfig, ${fields.title}::text)) AS title_lex,
             tsvector_to_array(to_tsvector('english'::regconfig, ${text}::text)) AS text_lex
    ),
    candidate AS (
      SELECT e.id, e.title, e."updatedAt",
             tsvector_to_array(to_tsvector('english'::regconfig, e.title)) AS title_lex,
             tsvector_to_array(coalesce(d.search, to_tsvector('english'::regconfig,
               e.title || ' ' || array_to_string(e.tags, ' ') || ' ' || left(e.body, 100000)))) AS text_lex
      FROM "KnowledgeEntry" e
      LEFT JOIN "JackSearchDoc" d ON d.source = 'knowledge' AND d."sourceId" = e.id
      WHERE e."archivedAt" IS NULL AND NOT (e.id = ANY(${exclude}::text[]))
    ),
    counted AS (
      SELECT c.id, c.title, c."updatedAt",
             cardinality(p.title_lex) AS "newTitle",
             cardinality(p.text_lex) AS "newText",
             cardinality(c.title_lex) AS "oldTitle",
             cardinality(c.text_lex) AS "oldText",
             (SELECT count(*) FROM unnest(c.title_lex) AS x WHERE x = ANY(p.title_lex)) AS "sharedTitle",
             (SELECT count(*) FROM unnest(c.text_lex) AS x WHERE x = ANY(p.text_lex)) AS "sharedText"
      FROM candidate c CROSS JOIN probe p
      WHERE c.text_lex && p.text_lex
    )
    SELECT * FROM counted
    ORDER BY "sharedTitle"::float / greatest(1, "oldTitle" + "newTitle" - "sharedTitle") DESC,
             "sharedText"::float / greatest(1, least("oldText", "newText")) DESC
    LIMIT ${DUPLICATE_CANDIDATES}
  `
  return scoreDuplicates(rows)
}

/** The candidates that count as duplicates, closest first */
export function scoreDuplicates(rows: DuplicateCountRow[]): KnowledgeDuplicate[] {
  return rows
    .map((row) => {
      const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, Number(row[key])])) as LexemeCounts
      const match = duplicateMatch(counts)
      return match ? { id: row.id, title: row.title, updatedAt: row.updatedAt, ...match } : null
    })
    .filter((d): d is KnowledgeDuplicate => d !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, DUPLICATES_SHOWN)
}
