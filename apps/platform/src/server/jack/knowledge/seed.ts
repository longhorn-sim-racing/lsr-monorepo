import type { TeamId } from "@/app/about/roster"
import { KNOWLEDGE_LIMITS, normalizeTags } from "@/lib/jack/knowledge"
import { findSecret } from "@/lib/redact"
import { DEPARTMENTS } from "@/schemas/officer-profile.schema"
import { isCalendarDate } from "../tools/time"

/**
 * The knowledge seed files (#188, design §9): one entry per Markdown file with front matter, kept
 * OUTSIDE the repo (it's public). scripts/jack-knowledge-seed.ts lints them with these and loads them
 * once Gray has signed them off. The format is in docs/jack-2/knowledge-seed/README.md:
 *
 *   ---
 *   title: LSC entry fee for Season 3
 *   tags: [lsc, fees, decision]
 *   sourceNote: Competition team post in Teams, Sep 28
 *   sourceDate: 2026-09-28
 *   owner: Competition
 *   ---
 *   The entry fee is $10, or $5 for returning drivers. ...
 */

/**
 * Who keeps an entry current: an officer by handle, or a department ("Media"), which the loader
 * gives to the department's lead when exactly one officer of it holds a board seat
 */
export type SeedOwner = { kind: "handle"; handle: string } | { kind: "department"; id: TeamId }

export type SeedEntry = {
  /** The file it came from, relative to the seed folder */
  file: string
  title: string
  body: string
  tags: string[]
  sourceNote: string
  /** YYYY-MM-DD, Central */
  sourceDate: string
  owner: SeedOwner | null
}

/** Files the loader skips: README.md, and notes or indexes whose name starts with "_" (like _index.md) */
export function isSeedFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith(".md") && lower !== "readme.md" && !lower.startsWith("_")
}

/** "Media", "media" → the department; "@gray-marshall" or "gray-marshall" → the handle; null when it's neither */
export function parseSeedOwner(value: string): SeedOwner | null {
  const clean = value.trim()
  if (!clean.startsWith("@")) {
    const department = DEPARTMENTS.find((d) => d.id === clean.toLowerCase() || d.name.toLowerCase() === clean.toLowerCase())
    if (department) return { kind: "department", id: department.id }
  }
  const handle = clean.replace(/^@/, "").toLowerCase()
  return HANDLE.test(handle) ? { kind: "handle", handle } : null
}

export type SeedParse = { ok: true; entry: SeedEntry } | { ok: false; file: string; errors: string[] }

const KEYS = ["title", "tags", "sourceNote", "sourceDate", "owner"] as const
type Key = (typeof KEYS)[number]

const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** An email address anywhere in the text: seeds name roles and pages, never someone's address */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/

const unquote = (value: string) => {
  const v = value.trim()
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v
}

/** "[a, b]", "a, b" or a YAML list's items */
const listOf = (value: string) =>
  value
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(unquote)
    .filter(Boolean)

/**
 * The front matter as plain `key: value` lines (a small YAML subset: quoted or bare values, tags as
 * `[a, b]`, `a, b` or a `- item` list), and the body after it
 */
export function splitFrontMatter(text: string): { fields: Map<string, string | string[]>; body: string } | { error: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return { error: "It has to start with front matter: a line of ---, the fields, then another ---." }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---")
  if (end === -1) return { error: "The front matter never ends: add a line of --- after the fields." }

  const fields = new Map<string, string | string[]>()
  let listKey: string | null = null
  for (const [i, raw] of lines.slice(1, end).entries()) {
    const line = raw.trimEnd()
    if (!line.trim() || line.trim().startsWith("#")) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && listKey) {
      const list = fields.get(listKey)
      fields.set(listKey, [...(Array.isArray(list) ? list : []), unquote(item[1])])
      continue
    }
    const pair = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line)
    if (!pair) return { error: `Front matter line ${i + 2} isn't "key: value": ${line.trim().slice(0, 60)}` }
    const [, key, value] = pair
    if (fields.has(key)) return { error: `${key} is in the front matter twice.` }
    listKey = value.trim() ? null : key
    fields.set(key, key === "tags" ? listOf(value) : unquote(value))
  }
  return { fields, body: lines.slice(end + 1).join("\n").trim() }
}

/** Parses and lints one seed file: required fields, sizes, dates, and no emails, keys or tokens anywhere */
export function parseSeedFile(file: string, text: string): SeedParse {
  const split = splitFrontMatter(text)
  if ("error" in split) return { ok: false, file, errors: [split.error] }
  const { fields, body } = split
  const errors: string[] = []
  const text_ = (key: Key) => {
    const value = fields.get(key)
    return Array.isArray(value) ? value.join(", ") : (value ?? "").trim()
  }

  for (const key of fields.keys()) {
    if (!KEYS.includes(key as Key)) errors.push(`Unknown field "${key}" (the fields are ${KEYS.join(", ")}).`)
  }
  const title = text_("title")
  const sourceNote = text_("sourceNote")
  const sourceDate = text_("sourceDate")
  const ownerText = text_("owner")
  const owner = ownerText ? parseSeedOwner(ownerText) : null
  const rawTags = fields.get("tags")
  const listed = normalizeTags(Array.isArray(rawTags) ? rawTags : rawTags ? listOf(rawTags) : [])
  // A department that owns an entry is one of its tags too, whoever the loader gives it to
  const tags = normalizeTags([...listed, ...(owner?.kind === "department" ? [owner.id] : [])])

  if (!title) errors.push("title is missing.")
  else if (title.length < 3 || title.length > KNOWLEDGE_LIMITS.titleMax) errors.push(`title has to be 3 to ${KNOWLEDGE_LIMITS.titleMax} characters.`)
  if (!listed.length) errors.push("tags is missing: give at least one, e.g. tags: [policy].")
  if (!sourceNote) errors.push("sourceNote is missing: say where it came from, e.g. \"Teams General, Dylan, Sep 28\".")
  else if (sourceNote.length > KNOWLEDGE_LIMITS.sourceNoteMax) errors.push(`sourceNote has to be ${KNOWLEDGE_LIMITS.sourceNoteMax} characters or fewer.`)
  if (!sourceDate) errors.push("sourceDate is missing: the date the source said it, YYYY-MM-DD.")
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate) || !isCalendarDate(sourceDate)) errors.push(`sourceDate "${sourceDate}" isn't a date like 2026-09-28.`)
  if (ownerText && !owner) errors.push(`owner "${ownerText}" isn't a department (${DEPARTMENTS.map((d) => d.name).join(", ")}) or an officer's handle.`)
  if (!body) errors.push("The entry has no text after the front matter.")
  else if (body.length > KNOWLEDGE_LIMITS.bodyMax) errors.push(`The text is over ${KNOWLEDGE_LIMITS.bodyMax.toLocaleString("en-US")} characters; split it into several entries.`)

  const all = [title, sourceNote, tags.join(" "), body].join("\n")
  if (EMAIL.test(all)) errors.push("It has an email address in it. Name the role or the page instead (\"the Business lead\", \"the Contact page\").")
  const secret = findSecret(all)
  if (secret) errors.push(`It seems to hold ${secret}. Seeds never hold passwords, keys or tokens; say where one is kept instead.`)

  if (errors.length) return { ok: false, file, errors }
  return { ok: true, entry: { file, title, body, tags, sourceNote, sourceDate, owner } }
}

/** Two seed files with the same title would load as one entry: both are errors */
export function duplicateSeedTitles(entries: SeedEntry[]): { title: string; files: string[] }[] {
  const byTitle = new Map<string, string[]>()
  for (const entry of entries) {
    const key = entry.title.toLowerCase()
    byTitle.set(key, [...(byTitle.get(key) ?? []), entry.file])
  }
  return [...byTitle.entries()].filter(([, files]) => files.length > 1).map(([, files]) => ({ title: entries.find((e) => e.file === files[0])!.title, files }))
}

/** A seed entry already in the knowledge base, as the loader reads it to plan a reload */
export type LoadedSeed = {
  title: string
  body: string
  tags: string[]
  sourceNote: string | null
  sourceDate: Date | null
  ownerId: string | null
  reviewedAt: Date | null
  /** Its versions, newest first */
  versions: { id: string; title: string; via: string; createdAt: Date }[]
  /** Its create and update audit entries: when, and from where ("seed", "admin" for the page, "jack") */
  changes: { at: Date; actionType: string; via: string | null }[]
}

/** What a seed file says, as the loader writes it */
export type SeedFields = { title: string; body: string; tags: string[]; sourceNote: string; sourceDate: Date; ownerId: string | null }

export type SeedReload =
  | { action: "same" }
  /** Changed on the site since the last load: left alone unless the loader runs with --overwrite */
  | { action: "skip"; reason: string }
  /**
   * `changed`: what differs from the file. Without `overwriting` the entry matches the last load, so
   * it's the file that moved; with it, the site changed it too and the file replaces that
   */
  | { action: "update"; baseVersionId: string | null; reviewedAt: Date | null; changed: string[]; overwriting: boolean }

const CHANGED_BY: Record<string, string> = { admin: "an officer on the Knowledge page", jack: "Jack", seed: "the seed" }

/**
 * Whether reloading a seed file changes the entry an earlier load made, and how. The seed's own newest
 * version is what it last loaded. A newer version from anyone else, or an update to the details in the
 * audit log since the last load, means officers (or Jack) changed it on the site: then it's skipped,
 * unless `overwrite`, rather than quietly put back. An update names the newest version as its base, so
 * an edit landing while the loader runs is refused, not overwritten. A new sign-off re-dates the
 * review, but never moves an officer's later review back.
 */
export function planSeedReload(loaded: LoadedSeed, file: SeedFields, { approvedAt, overwrite = false }: { approvedAt: Date | null; overwrite?: boolean }): SeedReload {
  const latest = loaded.versions[0] ?? null
  const lastSeed = loaded.versions.find((v) => v.via === "seed") ?? null
  const lastLoad = Math.max(lastSeed?.createdAt.getTime() ?? 0, ...loaded.changes.filter((c) => c.via === "seed").map((c) => c.at.getTime()))

  const changed = [
    loaded.title !== file.title && "title",
    loaded.body !== file.body && "text",
    loaded.tags.join(",") !== file.tags.join(",") && "tags",
    (loaded.sourceNote !== file.sourceNote || loaded.sourceDate?.getTime() !== file.sourceDate.getTime()) && "source",
    loaded.ownerId !== file.ownerId && "owner",
  ].filter((what): what is string => !!what)
  const contentChanged = changed.some((what) => what === "title" || what === "text" || what === "tags")
  const reviewDue = !!approvedAt && (contentChanged || !loaded.reviewedAt || loaded.reviewedAt.getTime() < approvedAt.getTime())
  if (!changed.length && !reviewDue) return { action: "same" }

  const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(date)
  const by = (via: string | null) => CHANGED_BY[via ?? ""] ?? "someone else"
  const newerVersion = latest && latest.id !== lastSeed?.id ? latest : null
  const newerDetails = loaded.changes.find((c) => c.via !== "seed" && c.actionType === "UPDATE" && c.at.getTime() > lastLoad)
  if (!overwrite) {
    if (newerVersion) return { action: "skip", reason: `edited on the site since the last load (by ${by(newerVersion.via)}, ${day(newerVersion.createdAt)})` }
    if (newerDetails) return { action: "skip", reason: `its details were changed on the site since the last load (by ${by(newerDetails.via)}, ${day(newerDetails.at)})` }
  }
  return {
    action: "update",
    baseVersionId: latest?.id ?? null,
    reviewedAt: reviewDue ? approvedAt : null,
    changed: changed.length ? changed : ["review date"],
    overwriting: !!(newerVersion || newerDetails),
  }
}
