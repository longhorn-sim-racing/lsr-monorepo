import { randomBytes } from "node:crypto"
import type { JackDeckContent, JackSlideData } from "@/lib/jack/decks"

/**
 * How Jack's deck tools change a deck (#177), as pure functions of its content so they're tested
 * directly. Slide numbers are 1-based and refer to the deck as it is when each step runs (after the
 * steps before it). Errors are written for Jack.
 */

/** A slide's id: short, URL-safe, unique within its deck */
export function newSlideId(): string {
  return randomBytes(6).toString("base64url")
}

export type Applied = { content: JackDeckContent; touched: string[]; cssChanged: boolean }
export type ApplyResult = Applied | { error: string }

/** One slide to write: replace slide `slide` (html, notes or both), or with `insert` (or one past the end) add a new one there */
export type SlideWrite = { slide: number; html?: string; notes?: string; insert?: boolean }

export function applyWrites(content: JackDeckContent, writes: SlideWrite[], css?: string, makeId: () => string = newSlideId): ApplyResult {
  const slides = content.slides.slice()
  const touched = new Set<string>()
  for (const [i, write] of writes.entries()) {
    const where = `Slide write ${i + 1} (slide ${write.slide})`
    const n = write.slide
    if (!Number.isInteger(n) || n < 1) return { error: `${where}: slide numbers start at 1.` }
    const appending = n === slides.length + 1
    if (write.insert || appending) {
      if (n > slides.length + 1) return { error: `${where}: the deck has ${slides.length} slides, so a new slide can go at 1 to ${slides.length + 1}.` }
      if (!write.html?.trim()) return { error: `${where}: a new slide needs its html.` }
      const slide: JackSlideData = { id: makeId(), html: write.html, ...(write.notes?.trim() ? { notes: write.notes.trim() } : {}) }
      slides.splice(n - 1, 0, slide)
      touched.add(slide.id)
      continue
    }
    if (n > slides.length) return { error: `${where}: the deck has ${slides.length} slides. Use slide ${slides.length + 1} to add one at the end.` }
    if (write.html === undefined && write.notes === undefined) return { error: `${where}: give the html, the notes, or both.` }
    const current = slides[n - 1]
    const next: JackSlideData = { id: current.id, html: write.html ?? current.html }
    const notes = write.notes === undefined ? current.notes : write.notes.trim()
    if (notes) next.notes = notes
    slides[n - 1] = next
    if (next.html !== current.html || (next.notes ?? "") !== (current.notes ?? "")) touched.add(current.id)
  }
  const nextCss = css ?? content.css
  return { content: { css: nextCss, slides }, touched: [...touched], cssChanged: nextCss !== content.css }
}

/** A find-and-replace in one slide's HTML (or its notes, with `notes`), or in the deck CSS when `slide` is left out */
export type SlideEdit = { slide?: number; find: string; replace: string; all?: boolean; notes?: boolean }

export function applyEdits(content: JackDeckContent, edits: SlideEdit[]): ApplyResult {
  const slides = content.slides.slice()
  let css = content.css
  const touched = new Set<string>()
  for (const [i, edit] of edits.entries()) {
    const target = edit.slide === undefined ? "the deck CSS" : edit.notes ? `slide ${edit.slide}'s notes` : `slide ${edit.slide}`
    const where = `Edit ${i + 1} (${target})`
    if (!edit.find) return { error: `${where}: find can't be empty.` }
    if (edit.find === edit.replace) return { error: `${where}: find and replace are the same.` }
    if (edit.notes && edit.slide === undefined) return { error: `${where}: say which slide's notes to edit.` }
    let text: string
    if (edit.slide === undefined) text = css
    else {
      if (!Number.isInteger(edit.slide) || edit.slide < 1 || edit.slide > slides.length) return { error: `${where}: the deck has ${slides.length} slides.` }
      text = edit.notes ? (slides[edit.slide - 1].notes ?? "") : slides[edit.slide - 1].html
    }
    const count = text.split(edit.find).length - 1
    if (count === 0) return { error: `${where}: the find text isn't in ${target}. Call deck_view to see its current HTML, and copy the text exactly.` }
    if (count > 1 && !edit.all) return { error: `${where}: the find text appears ${count} times in ${target}. Add more of the surrounding text so it's unique, or set all to replace every one.` }
    const next = edit.all ? text.split(edit.find).join(edit.replace) : text.replace(edit.find, () => edit.replace)
    if (edit.slide === undefined) css = next
    else if (edit.notes) {
      // Notes don't change the picture, so the slide isn't re-rendered
      const { notes: _old, ...slide } = slides[edit.slide - 1]
      void _old
      slides[edit.slide - 1] = next.trim() ? { ...slide, notes: next.trim() } : slide
    } else {
      const slide = slides[edit.slide - 1]
      slides[edit.slide - 1] = { ...slide, html: next }
      touched.add(slide.id)
    }
  }
  return { content: { css, slides }, touched: [...touched], cssChanged: css !== content.css }
}

/**
 * The slides in a new order, by their current numbers: a number left out deletes that slide, and a
 * number given twice duplicates it (the copy is a new slide)
 */
export function applyOrder(content: JackDeckContent, order: number[], makeId: () => string = newSlideId): ApplyResult & { summary?: string } {
  if (!order.length) return { error: "order can't be empty: a deck needs at least one slide." }
  const bad = order.find((n) => !Number.isInteger(n) || n < 1 || n > content.slides.length)
  if (bad !== undefined) return { error: `order has ${bad}, but the deck's slides are 1 to ${content.slides.length}.` }
  const seen = new Set<number>()
  const touched: string[] = []
  const slides = order.map((n) => {
    const slide = content.slides[n - 1]
    if (!seen.has(n)) {
      seen.add(n)
      return slide
    }
    const copy = { ...slide, id: makeId() }
    touched.push(copy.id)
    return copy
  })
  const removed = content.slides.length - seen.size
  const duplicated = touched.length
  const moved = order.some((n, i) => n !== i + 1) && !removed && !duplicated
  const parts = [removed ? `deleted ${removed} slide${removed === 1 ? "" : "s"}` : null, duplicated ? `duplicated ${duplicated}` : null, moved || (removed === 0 && duplicated === 0) ? "reordered the slides" : null].filter(Boolean)
  return { content: { css: content.css, slides }, touched, cssChanged: false, summary: parts.join(", ") }
}
