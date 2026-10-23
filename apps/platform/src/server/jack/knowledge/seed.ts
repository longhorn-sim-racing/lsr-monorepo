import { KNOWLEDGE_LIMITS, normalizeTags } from "@/lib/jack/knowledge"
import { findSecret } from "@/lib/redact"
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
 *   owner: armando-martinez
 *   ---
 *   The entry fee is $10, or $5 for returning drivers. ...
 */

export type SeedEntry = {
  /** The file it came from, relative to the seed folder */
  file: string
  title: string
  body: string
  tags: string[]
  sourceNote: string
  /** YYYY-MM-DD, Central */
  sourceDate: string
  /** The handle of the officer who keeps it current */
  owner: string | null
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
  const owner = text_("owner").replace(/^@/, "").toLowerCase()
  const rawTags = fields.get("tags")
  const tags = normalizeTags(Array.isArray(rawTags) ? rawTags : rawTags ? listOf(rawTags) : [])

  if (!title) errors.push("title is missing.")
  else if (title.length < 3 || title.length > KNOWLEDGE_LIMITS.titleMax) errors.push(`title has to be 3 to ${KNOWLEDGE_LIMITS.titleMax} characters.`)
  if (!tags.length) errors.push("tags is missing: give at least one, e.g. tags: [policy].")
  if (!sourceNote) errors.push("sourceNote is missing: say where it came from, e.g. \"Teams General, Dylan, Sep 28\".")
  else if (sourceNote.length > KNOWLEDGE_LIMITS.sourceNoteMax) errors.push(`sourceNote has to be ${KNOWLEDGE_LIMITS.sourceNoteMax} characters or fewer.`)
  if (!sourceDate) errors.push("sourceDate is missing: the date the source said it, YYYY-MM-DD.")
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate) || !isCalendarDate(sourceDate)) errors.push(`sourceDate "${sourceDate}" isn't a date like 2026-09-28.`)
  if (owner && !HANDLE.test(owner)) errors.push(`owner "${owner}" isn't a handle (lowercase letters, numbers and dashes).`)
  if (!body) errors.push("The entry has no text after the front matter.")
  else if (body.length > KNOWLEDGE_LIMITS.bodyMax) errors.push(`The text is over ${KNOWLEDGE_LIMITS.bodyMax.toLocaleString("en-US")} characters; split it into several entries.`)

  const all = [title, sourceNote, tags.join(" "), body].join("\n")
  if (EMAIL.test(all)) errors.push("It has an email address in it. Name the role or the page instead (\"the Business lead\", \"the Contact page\").")
  const secret = findSecret(all)
  if (secret) errors.push(`It seems to hold ${secret}. Seeds never hold passwords, keys or tokens; say where one is kept instead.`)

  if (errors.length) return { ok: false, file, errors }
  return { ok: true, entry: { file, title, body, tags, sourceNote, sourceDate, owner: owner || null } }
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
