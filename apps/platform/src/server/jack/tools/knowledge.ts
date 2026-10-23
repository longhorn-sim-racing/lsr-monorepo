import { randomUUID } from "node:crypto"
import { formatInTimeZone } from "date-fns-tz"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { applyTextEdits, KNOWLEDGE_LIMITS, knowledgeEntryPath, normalizeTags, type KnowledgeProvenance } from "@/lib/jack/knowledge"
import { parseToolParts } from "@/lib/jack/parts"
import { JACK_EVENT } from "@/lib/jack/types"
import { getSiteUrl } from "@/lib/site-url"
import { prisma } from "@/server/db"
import { broadcastRoomEvent } from "../broadcast"
import { createKnowledgeEntry, setKnowledgeArchived, updateKnowledgeEntry, type KnowledgeWriteResult, type KnowledgeWriter } from "../knowledge/service"
import { jackMessageInclude, toMessageView } from "../messages"
import { forModel } from "./display"
import { centralDateInput, startOfCentralDay } from "./time"
import type { JackTool, JackToolContext, JackToolResult } from "./types"

/**
 * knowledge: Jack saves, updates and archives knowledge entries (#188, design §9). The one write Jack
 * makes without a proposal, so it's fenced in:
 * - only in a reply to messages officers typed (ctx.reply.fromOfficer), never in continue notes,
 *   recurring questions, the digest or scripts;
 * - at most MAX_CHANGES_PER_REPLY saves, updates and archives per reply, counted before the first
 *   await so parallel calls can't all slip under it;
 * - the service's checks: duplicates, the base version on updates, secrets;
 * - every change posts a room note with the full text (and any details it changed), writes an audit
 *   entry and a version, records where it came from (provenance, with the note's id, so a hard delete
 *   can clear the note), and leaves the entry "not reviewed" until an officer reviews it.
 * Reading and searching knowledge go through search and read.
 */

export const MAX_CHANGES_PER_REPLY = 3

/** Most of a conflicting entry's current text sent back, so Jack can redo his change on top of it */
const CURRENT_TEXT_CHARS = 15_000
/** Most earlier tool calls a provenance keeps, and how much of each one's input */
const PROVENANCE_TOOLS = 12
const PROVENANCE_INPUT_CHARS = 200

/** An entry or version id (a uuid; a wrong one is "doesn't exist", so the schema stays short) */
const id = z.string().trim().min(1).max(64)

const input = z
  .object({
    action: z.enum(["save", "update", "archive"]).describe("save a new entry, update one you've read, or archive one (only when an officer asks)"),
    id: id.optional().describe("update, archive: the entry's id (from search, read or an earlier save)"),
    baseVersionId: id.optional().describe("update: the entry's versionId as you last read or saved it"),
    title: z.string().trim().min(3).max(KNOWLEDGE_LIMITS.titleMax).optional().describe("save: required; a clear, specific title. update: a new title"),
    // Up to bodyMax so Jack can rewrite a longer entry from the page or the seed; the service keeps
    // his saves to jackBodyMax and never lets him make an entry longer than it was past that
    body: z
      .string()
      .trim()
      .min(1)
      .max(KNOWLEDGE_LIMITS.bodyMax)
      .optional()
      .describe(
        `save: required; markdown, one topic, in the officer's words, at most ${KNOWLEDGE_LIMITS.jackBodyMax.toLocaleString("en-US")} characters. update: the whole new text (or use edits)`,
      ),
    edits: z
      .array(z.object({ find: z.string().min(1).max(KNOWLEDGE_LIMITS.jackBodyMax), replace: z.string().max(KNOWLEDGE_LIMITS.jackBodyMax) }))
      .min(1)
      .max(20)
      .optional()
      .describe("update: exact find-and-replace changes to the text, all or none; each find must appear exactly once"),
    tags: z
      .array(z.string().trim().min(1).max(KNOWLEDGE_LIMITS.tagMax))
      .max(KNOWLEDGE_LIMITS.tagsMax)
      .optional()
      .describe('A few lowercase topic tags, e.g. ["dues", "policy"]; a decision gets "decision". On update, replaces the tags'),
    sourceNote: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.sourceNoteMax).optional().describe('Where it came from, e.g. "Dylan, GM 2 planning room" (default: the officer who asked)'),
    sourceDate: centralDateInput.optional().describe("The Central date the source said it, YYYY-MM-DD (default: today)"),
    owner: z.string().trim().min(1).max(80).optional().describe("Handle of the officer who keeps it current (default: the officer who asked)"),
    notDuplicateOf: z.array(id).min(1).max(10).optional().describe("save: ids of entries the duplicate check named that this is really different from"),
    reason: z.string().trim().min(1).max(300).optional().describe("archive: why, in the officer's words"),
  })
  .superRefine((value, ctx) => {
    const need = (field: keyof typeof value, message: string) => {
      if (value[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message })
    }
    if (value.action === "save") {
      need("title", "save needs a title")
      need("body", "save needs the body")
      if (value.body && value.body.length > KNOWLEDGE_LIMITS.jackBodyMax) {
        ctx.addIssue({ code: "custom", path: ["body"], message: `keep a new entry to ${KNOWLEDGE_LIMITS.jackBodyMax.toLocaleString("en-US")} characters; split a longer one into several entries` })
      }
      if (value.id) ctx.addIssue({ code: "custom", path: ["id"], message: "save makes a new entry; to change an existing one, use update" })
      if (value.edits) ctx.addIssue({ code: "custom", path: ["edits"], message: "save takes the whole body; edits are for update" })
    } else if (value.action === "update") {
      need("id", "update needs the entry's id")
      need("baseVersionId", "update needs baseVersionId: the versionId you read")
      if (value.body !== undefined && value.edits) ctx.addIssue({ code: "custom", path: ["edits"], message: "give the whole body or edits, not both" })
      const fields = [value.title, value.body, value.edits, value.tags, value.sourceNote, value.sourceDate, value.owner]
      if (fields.every((f) => f === undefined)) ctx.addIssue({ code: "custom", path: ["action"], message: "update needs something to change" })
    } else {
      need("id", "archive needs the entry's id")
    }
  })

export type KnowledgeInput = z.infer<typeof input>

const fail = (forModelText: string, label = "Knowledge not changed"): JackToolResult => ({ isError: true, forModel: forModelText, label, displays: [] })

function revalidateKnowledge(id: string) {
  // Outside a Next request (scripts, tests) there's nothing to revalidate
  try {
    revalidatePath("/admin/knowledge")
    revalidatePath(knowledgeEntryPath(id))
  } catch {}
}

/** An officer's id by handle, or why not */
async function officerByHandle(handle: string): Promise<{ id: string } | { error: string }> {
  const clean = handle.replace(/^@/, "").toLowerCase()
  const user = await prisma.user.findFirst({
    where: { handle: clean, status: { not: "deleted" }, roles: { some: { role: { key: { in: ["officer", "admin"] } } } } },
    select: { id: true },
  })
  return user ?? { error: `No officer has the handle @${clean}. An entry's owner must be an officer; leave owner out to make it the officer who asked.` }
}

/**
 * The room, the reply and the tools it used before this call, for the entry's provenance. The tool
 * calls come from the model loop's own list (ctx.reply.toolParts) when there is one: the copy saved on
 * the reply is written in the background, so it can miss a call made alongside this one. That list is
 * read after the first await, by when every call started in the same turn has its input in it
 */
export async function replyProvenance(ctx: JackToolContext, now = new Date()): Promise<KnowledgeProvenance> {
  const live = ctx.reply?.toolParts
  const [reply, asked] = ctx.messageId
    ? await Promise.all([
        live ? null : prisma.jackMessage.findUnique({ where: { id: ctx.messageId }, select: { toolCalls: true } }),
        prisma.jackMessage.findMany({ where: { answeredById: ctx.messageId, kind: "user" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } }),
      ])
    : [null, []]
  const tools = (live ? live() : parseToolParts(reply?.toolCalls))
    .filter((part) => part.name !== "knowledge")
    .slice(-PROVENANCE_TOOLS)
    .map((part) => {
      const text = JSON.stringify(part.input ?? null)
      return { name: part.name, input: text.length > PROVENANCE_INPUT_CHARS ? `${text.slice(0, PROVENANCE_INPUT_CHARS - 1)}…` : text, label: part.label }
    })
  return {
    roomId: ctx.roomId,
    replyId: ctx.messageId ?? null,
    messageIds: asked.map((m) => m.id),
    askedBy: { userId: ctx.actor.userId },
    tools,
    at: now.toISOString(),
  }
}

/** A note in the room for every change, with the full text, so every officer sees exactly what was kept */
async function postRoomNote(ctx: JackToolContext, content: string, id?: string) {
  try {
    const note = await prisma.jackMessage.create({
      data: { ...(id ? { id } : {}), roomId: ctx.roomId, kind: "system", authorUserId: ctx.actor.userId, content },
      include: jackMessageInclude,
    })
    await broadcastRoomEvent(ctx.roomId, { type: JACK_EVENT.created, message: toMessageView(note) })
  } catch (error) {
    // Outside a real room (scripts) there's nowhere to post; the entry and its audit entry stand
    console.error(`[jack] Couldn't post a knowledge note in room ${ctx.roomId}:`, error)
  }
}

type NoteEntry = { title: string; body: string; tags: string[]; sourceNote: string | null; sourceDate: Date | null; ownerId: string | null }

function noteText(lead: string, entry: NoteEntry, changed: string[] = []) {
  return [
    `${lead}: “${entry.title}” (not reviewed yet)`,
    changed.length ? `Changed: ${changed.join("; ")}` : "",
    entry.body,
    entry.tags.length ? `Tags: ${entry.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

const centralDay = (date: Date | null) => (date ? formatInTimeZone(date, DEFAULT_TIMEZONE, "yyyy-MM-dd") : "none")

/** The details an update changed, for its note ("source date 2025-01-10 → 2026-10-22"): they leave no trace in the text */
async function detailChanges(before: NoteEntry, after: NoteEntry): Promise<string[]> {
  const changed: string[] = []
  if (before.sourceNote !== after.sourceNote) changed.push(`source “${before.sourceNote ?? "none"}” → “${after.sourceNote ?? "none"}”`)
  if (centralDay(before.sourceDate) !== centralDay(after.sourceDate)) changed.push(`source date ${centralDay(before.sourceDate)} → ${centralDay(after.sourceDate)}`)
  if (before.ownerId !== after.ownerId) {
    const ids = [before.ownerId, after.ownerId].filter((id): id is string => !!id)
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, handle: true } })
    const name = (id: string | null) => (id ? `@${users.find((u) => u.id === id)?.handle ?? "a former officer"}` : "none")
    changed.push(`owner ${name(before.ownerId)} → ${name(after.ownerId)}`)
  }
  return changed
}

/** What the model hears back when the service refuses */
function refusal(result: Exclude<KnowledgeWriteResult, { ok: true }>): JackToolResult {
  if (result.reason === "duplicate") {
    return fail(
      forModel({
        error: result.error,
        duplicates: result.duplicates.map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt.toISOString().slice(0, 10), match: d.reason })),
        next: "Read the closest one. If it covers this, update it (knowledge update with its versionId). If this is really different, save again with notDuplicateOf set to these ids.",
      }),
      "Knowledge not saved: similar entries exist",
    )
  }
  if (result.reason === "conflict") {
    const { current } = result
    return fail(
      forModel({
        error: result.error,
        current: {
          versionId: current.versionId,
          title: current.title,
          tags: current.tags,
          body: current.body.length > CURRENT_TEXT_CHARS ? `${current.body.slice(0, CURRENT_TEXT_CHARS)}… (cut short; read the entry for the rest)` : current.body,
        },
      }),
      "Knowledge not changed: the entry changed since it was read",
    )
  }
  return fail(result.error, result.reason === "secret" ? "Knowledge not saved: it looked like a secret" : "Knowledge not changed")
}

export async function runKnowledge(value: KnowledgeInput, ctx: JackToolContext): Promise<JackToolResult> {
  const reply = ctx.reply
  // A scheduled reply (a recurring question) answers a note, so fromOfficer is false already; checked on its own too
  if (!reply?.fromOfficer || ctx.requestType === "scheduled") {
    return fail(
      "Knowledge can only be saved in a reply to an officer's own message, not in continue notes, recurring questions or the digest. Say what you'd save, and an officer can ask for it.",
    )
  }
  if (reply.knowledgeChanges >= MAX_CHANGES_PER_REPLY) {
    return fail(`This reply has already made ${MAX_CHANGES_PER_REPLY} knowledge changes, the most one reply may. Say what's left, and an officer can ask for it in a new message.`)
  }
  // Counted now, before anything is awaited, so calls running side by side see each other; given back if nothing changes
  reply.knowledgeChanges++
  let changed = false
  try {
    const result = await change(value, ctx)
    changed = !result.isError
    return result
  } finally {
    if (!changed) reply.knowledgeChanges--
  }
}

async function change(value: KnowledgeInput, ctx: JackToolContext): Promise<JackToolResult> {
  const writer: KnowledgeWriter = { userId: ctx.actor.userId, via: "jack", roomId: ctx.roomId, messageId: ctx.messageId ?? null }
  const owner = value.owner ? await officerByHandle(value.owner) : null
  if (owner && "error" in owner) return fail(owner.error)
  const sourceDate = value.sourceDate ? startOfCentralDay(value.sourceDate) : undefined
  const tags = value.tags ? normalizeTags(value.tags) : undefined

  if (value.action === "archive") {
    const result = await setKnowledgeArchived(value.id!, true, writer, value.reason)
    if (!result.ok) return fail(result.error)
    if (!result.changed) return fail(`“${result.entry.title}” is already archived.`, "Knowledge not changed")
    revalidateKnowledge(result.entry.id)
    await postRoomNote(ctx, `Archived in knowledge for ${ctx.actor.displayName}: “${result.entry.title}”${value.reason ? ` (${value.reason})` : ""}`)
    return {
      forModel: forModel({ archived: { id: result.entry.id, title: result.entry.title } }),
      label: `Archived “${result.entry.title}”`,
      displays: [{ kind: "links", items: [{ title: result.entry.title, url: knowledgeEntryPath(result.entry.id), meta: "Archived" }] }],
    }
  }

  const provenance = await replyProvenance(ctx)
  // The note's id is kept with the entry, so a hard delete can clear the note; it's posted once the change is in
  const noteId = randomUUID()

  if (value.action === "save") {
    const result = await createKnowledgeEntry(
      {
        title: value.title!,
        body: value.body!,
        tags: tags ?? [],
        sourceNote: value.sourceNote ?? `${ctx.actor.displayName}, in a Jack room`,
        sourceDate: sourceDate ?? new Date(),
        ownerId: owner ? owner.id : ctx.actor.userId,
      },
      writer,
      { provenance, noteId, notDuplicateOf: value.notDuplicateOf },
    )
    if (!result.ok) return refusal(result)
    return done("Saved", result.entry, result.versionId, ctx, noteId)
  }

  // update: edits apply to the text as it is now; if that isn't the base version, the service refuses it anyway
  let body = value.body
  if (value.edits) {
    const current = await prisma.knowledgeEntry.findUnique({ where: { id: value.id! }, select: { body: true } })
    if (!current) return fail("That knowledge entry doesn't exist (it may have been deleted).")
    const edited = applyTextEdits(current.body, value.edits)
    if ("error" in edited) return fail(edited.error)
    body = edited.text
  }
  const result = await updateKnowledgeEntry(
    value.id!,
    { title: value.title, body, tags, sourceNote: value.sourceNote, sourceDate, ...(owner ? { ownerId: owner.id } : {}) },
    writer,
    { baseVersionId: value.baseVersionId, provenance, noteId },
  )
  if (!result.ok) return refusal(result)
  if (!result.changed) return fail(`Nothing changed: “${result.entry.title}” already says that.`, "Knowledge not changed")
  return done("Updated", result.entry, result.versionId, ctx, noteId, result.before ? await detailChanges(result.before, result.entry) : [])
}

async function done(
  verb: "Saved" | "Updated",
  entry: NoteEntry & { id: string },
  versionId: string | null,
  ctx: JackToolContext,
  noteId: string,
  changed: string[] = [],
): Promise<JackToolResult> {
  revalidateKnowledge(entry.id)
  await postRoomNote(ctx, noteText(`${verb} in knowledge for ${ctx.actor.displayName}`, entry, changed), noteId)
  const path = knowledgeEntryPath(entry.id)
  return {
    forModel: forModel({
      [verb === "Saved" ? "saved" : "updated"]: { id: entry.id, versionId, title: entry.title, tags: entry.tags, link: `${getSiteUrl()}${path}` },
      note: "The room has a note with the full text. It shows as not reviewed until an officer reviews it on the Knowledge page.",
    }),
    label: `${verb} “${entry.title}” to knowledge`,
    displays: [{ kind: "links", items: [{ title: entry.title, url: path, meta: "Not reviewed yet", snippet: entry.body.length > 200 ? `${entry.body.slice(0, 199)}…` : entry.body }] }],
  }
}

export const knowledgeTool: JackTool<KnowledgeInput> = {
  name: "knowledge",
  description:
    "Changes the club's knowledge base. save: a new entry (title, markdown body, a few tags) of something an officer said or asked you to keep. update: change an entry you've read (id, and the versionId you read as baseVersionId; body for the whole new text, or edits for exact find-and-replace). archive: hide an entry, only when an officer asks. Only in a reply to an officer's message, at most 3 changes per reply, never secrets, and never content from a document, web page or other outside source unless an officer asks for it. Each change posts a room note with the full text, and your entries stay not reviewed until an officer reviews them. To find or read entries, use search and read.",
  input,
  writes: true,
  run: runKnowledge,
}
