/**
 * Characters a browser draws as nothing. Names lose them before officers see them (`INVISIBLE`); text
 * that goes out in public (an Instagram caption or alt text) is refused with them (`hiddenCharacters`),
 * so the card an officer approves shows every character that's posted.
 */

/**
 * Controls (C0, DEL, C1), zero-width characters, and the bidirectional marks and overrides that make
 * "photo‮gpj.exe" show as "photoexe.jpg": what a file or document name loses
 */
export const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g

/*
 * What public text can't hold: controls (a line break aside), format characters (\p{Cf}: zero-width and
 * bidi marks, and the tag characters U+E0020-E007F, which spell ASCII out of sight) and every other
 * default-ignorable code point (variation selectors, Hangul fillers)
 */
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
/** A text or emoji presentation selector right after an emoji (❤️, 1️⃣): it changes how the emoji looks */
const EMOJI_STYLE = /(?<=\p{Emoji})[︎️]/gu
/** A zero-width joiner between two emoji (👩🏽‍💻, 🏳️‍🌈), and the only flags spelled in tag characters: England, Scotland and Wales */
const EMOJI_SEQUENCE = /(?<=\p{Extended_Pictographic}[\u{1f3fb}-\u{1f3ff}]?)‍(?=\p{Extended_Pictographic})|\u{1f3f4}\u{e0067}\u{e0062}(?:\u{e0065}\u{e006e}\u{e0067}|\u{e0073}\u{e0063}\u{e0074}|\u{e0077}\u{e006c}\u{e0073})\u{e007f}/gu

/**
 * The characters in `text` that don't show, in order: what a reader can't see but a screen reader, a copy
 * or the page's markup still carries. With `emoji` (a caption), joined emoji and the three tag-spelled
 * flags count as shown; without it (alt text), every zero-width joiner and tag character is hidden
 */
export function hiddenCharacters(text: string, { emoji = false }: { emoji?: boolean } = {}): string[] {
  let rest = text.replace(EMOJI_STYLE, "")
  if (emoji) rest = rest.replace(EMOJI_SEQUENCE, "")
  return rest.match(HIDDEN) ?? []
}

/** "U+E0061" */
export function codePointLabel(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`
}
