"use server"

import { revalidatePath } from "next/cache"
import type { User } from "@prisma/client"
import { knowledgeEntryPath } from "@/lib/jack/knowledge"
import type { ActionResult } from "@/lib/action-result"
import { requireOfficer, requireRole } from "@/server/auth/guards"
import { prisma } from "@/server/db"
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  markKnowledgeReviewed,
  setKnowledgeArchived,
  updateKnowledgeEntry,
  type KnowledgeWriter,
} from "@/server/jack/knowledge/service"
import { isCalendarDate, startOfCentralDay } from "@/server/jack/tools/time"

/**
 * The Knowledge page's actions (#188, design §9). Any officer writes, edits, reviews and archives
 * entries; only admins delete one for good. Each checks its own access and goes through the knowledge
 * service, which validates, versions and audits.
 */

/** The entry form as the page sends it: text fields as typed */
export type KnowledgeFormInput = {
  title: string
  body: string
  /** Comma-separated */
  tags: string
  sourceNote: string
  sourceUrl: string
  /** YYYY-MM-DD (Central), or "" */
  sourceDate: string
  /** An officer's user id, or "" for none */
  ownerId: string
}

export type SaveKnowledgeOptions = {
  /** Edits: the version the form was opened at */
  baseVersionId?: string | null
  /** New entries: duplicates the officer has seen and saved anyway */
  notDuplicateOf?: string[]
  markReviewed?: boolean
}

export type SaveKnowledgeResult =
  | { ok: true; id: string }
  | { ok: false; error: string; duplicates?: { id: string; title: string }[]; conflict?: true }

const SIGNED_OUT = "You're signed out or no longer an officer. Copy your text, sign in again, and retry."

async function officer(): Promise<User | null> {
  try {
    return await requireOfficer()
  } catch {
    return null
  }
}

function revalidate(id?: string) {
  revalidatePath("/admin/knowledge")
  if (id) revalidatePath(knowledgeEntryPath(id))
}

/** The owner must be an officer or admin (they keep the entry current) */
async function checkOwner(ownerId: string): Promise<string | null> {
  if (!ownerId) return null
  const count = await prisma.user.count({ where: { id: ownerId, status: { not: "deleted" }, roles: { some: { role: { key: { in: ["officer", "admin"] } } } } } })
  return count ? null : "The owner has to be an officer."
}

export async function saveKnowledgeEntry(id: string | null, input: KnowledgeFormInput, options: SaveKnowledgeOptions = {}): Promise<SaveKnowledgeResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }

  const sourceDate = input.sourceDate.trim()
  if (sourceDate && !isCalendarDate(sourceDate)) return { ok: false, error: "The source date isn't a date on the calendar." }
  const ownerError = await checkOwner(input.ownerId)
  if (ownerError) return { ok: false, error: ownerError }

  const fields = {
    title: input.title,
    body: input.body,
    tags: input.tags.split(","),
    sourceNote: input.sourceNote,
    sourceUrl: input.sourceUrl,
    sourceDate: sourceDate ? startOfCentralDay(sourceDate) : null,
    ownerId: input.ownerId || null,
  }
  const writer: KnowledgeWriter = { userId: user.id, via: "admin" }

  try {
    const result = id
      ? await updateKnowledgeEntry(id, fields, writer, { baseVersionId: options.baseVersionId, markReviewed: options.markReviewed, allowArchived: true })
      : await createKnowledgeEntry(fields, writer, { notDuplicateOf: options.notDuplicateOf, reviewedAt: options.markReviewed ? new Date() : null })
    if (!result.ok) {
      if (result.reason === "duplicate") return { ok: false, error: result.error, duplicates: result.duplicates.map((d) => ({ id: d.id, title: d.title })) }
      if (result.reason === "conflict") {
        return { ok: false, conflict: true, error: "Someone changed this entry since you opened it. Copy your changes, reload, and make them again on the latest version." }
      }
      return { ok: false, error: result.error }
    }
    revalidate(result.entry.id)
    return { ok: true, id: result.entry.id }
  } catch (error) {
    console.error("[knowledge] Couldn't save an entry:", error)
    return { ok: false, error: "Couldn't save the entry. Your text is still here; try again." }
  }
}

export async function markKnowledgeEntryReviewed(id: string): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const result = await markKnowledgeReviewed(id, { userId: user.id, via: "admin" })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate(id)
  return { ok: true }
}

export async function setKnowledgeEntryArchived(id: string, archived: boolean): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const result = await setKnowledgeArchived(id, archived, { userId: user.id, via: "admin" })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate(id)
  return { ok: true }
}

/** Deletes an entry and its whole history for good. Admins only */
export async function deleteKnowledgeEntryForGood(id: string): Promise<ActionResult> {
  let user: User
  try {
    user = await requireRole("admin")
  } catch {
    return { ok: false, error: "Only admins can delete a knowledge entry. Archive it instead, or ask an admin." }
  }
  const result = await deleteKnowledgeEntry(id, { userId: user.id, via: "admin" })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate(id)
  return { ok: true }
}

/** Makes an earlier version the newest again (a new version with its title, text and tags) */
export async function restoreKnowledgeVersion(entryId: string, versionId: string, baseVersionId: string | null): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const version = await prisma.knowledgeEntryVersion.findFirst({ where: { id: versionId, entryId }, select: { title: true, body: true, tags: true } })
  if (!version) return { ok: false, error: "That version doesn't exist any more." }
  const result = await updateKnowledgeEntry(entryId, version, { userId: user.id, via: "admin" }, { baseVersionId, allowArchived: true })
  if (!result.ok) {
    return { ok: false, error: result.reason === "conflict" ? "The entry changed since you opened it. Reload and try again." : result.error }
  }
  revalidate(entryId)
  return { ok: true }
}
