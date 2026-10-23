import { z } from "zod"

/**
 * Exact find-and-replace edits on a long text (a page body, a news post), the way deck_edit edits a
 * slide: each `find` must appear exactly once in the text as it stands after the edits before it, and
 * either every edit applies or none does. Pure, so the kinds and the tests share it.
 */

export type TextEdit = { find: string; replace: string }

export const MAX_TEXT_EDITS = 30

/** A kind's `edits` field: the model sees these descriptions */
export const textEditsSchema = z
  .array(
    z.object({
      find: z.string().min(1).max(20_000).describe("Exact text to find, copied from the current text, with enough around it to appear only once"),
      replace: z.string().max(50_000).describe("What to put in its place (empty to delete it)"),
    }),
  )
  .min(1)
  .max(MAX_TEXT_EDITS)

/** The edited text, or why the edits can't apply (naming the edit, for the model to fix) */
export function applyTextEdits(text: string, edits: TextEdit[], what = "the text"): { text: string } | { error: string } {
  let next = text
  for (const [i, edit] of edits.entries()) {
    const where = edits.length === 1 ? "The edit" : `Edit ${i + 1}`
    if (!edit.find) return { error: `${where}: find can't be empty.` }
    if (edit.find === edit.replace) return { error: `${where}: find and replace are the same.` }
    const count = next.split(edit.find).length - 1
    if (count === 0) return { error: `${where}: the find text isn't in ${what}. Copy it exactly from the current text (spaces, line breaks and punctuation included).` }
    if (count > 1) return { error: `${where}: the find text appears ${count} times in ${what}. Add more of the text around it so it appears only once.` }
    // A function replacement, so "$&" and the like in the new text stay as written
    next = next.replace(edit.find, () => edit.replace)
  }
  return { text: next }
}
