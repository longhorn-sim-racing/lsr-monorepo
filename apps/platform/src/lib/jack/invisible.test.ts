import { describe, expect, it } from "vitest"
import { codePointLabel, hiddenCharacters } from "./invisible"

/** ASCII spelled in tag characters (U+E0020-E007F), which a browser draws as nothing */
const tags = (ascii: string) => [...ascii].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("")
const ENGLAND = `\u{1f3f4}${tags("gbeng")}\u{e007f}`
const labels = (text: string, emoji = false) => hiddenCharacters(text, { emoji }).map(codePointLabel)

describe("hiddenCharacters", () => {
  it("finds ASCII hidden in tag characters, as in alt text that carries an email address out of sight", () => {
    expect(labels("podium\u{e0061}\u{e0062}")).toEqual(["U+E0061", "U+E0062"])
    expect(hiddenCharacters(`Three drivers on the podium${tags("jo@example.com")}`)).toHaveLength(14)
  })

  it("lets a caption keep the flags spelled in tag characters (England, Scotland, Wales), but not a made-up one carrying text", () => {
    expect(labels(`Go ${ENGLAND} ${`\u{1f3f4}${tags("gbsct")}\u{e007f}`} ${`\u{1f3f4}${tags("gbwls")}\u{e007f}`}`, true)).toEqual([])
    expect(labels(`\u{1f3f4}${tags("jdoe")}\u{e007f}`, true)).toEqual(["U+E006A", "U+E0064", "U+E006F", "U+E0065", "U+E007F"])
    expect(labels(`${ENGLAND}${tags("x")}`, true)).toEqual(["U+E0078"])
    // Alt text has no use for them
    expect(hiddenCharacters(`Go ${ENGLAND}`)).toHaveLength(6)
  })

  it("lets a caption keep joined emoji, and alt text the emoji presentation selectors", () => {
    expect(labels("👩🏽‍💻 🏳️‍🌈 ❤️‍🔥 🏃‍♀️ 👨‍👩‍👧 🧑‍🦰", true)).toEqual([])
    expect(labels("👩🏽‍💻 🏳️‍🌈")).toEqual(["U+200D", "U+200D"])
    expect(labels("1️⃣ ❤️ ✌🏽 #️⃣ ✈︎")).toEqual([])
    // A joiner between letters isn't part of an emoji
    expect(labels("a‍b", true)).toEqual(["U+200D"])
  })

  it("allows line breaks, but no other controls", () => {
    expect(labels("GM 2 recap!\n\nThanks all")).toEqual([])
    expect(labels("a\tb\rc\u0000\u007f\u0085", true)).toEqual(["U+0009", "U+000D", "U+0000", "U+007F", "U+0085"])
  })

  it("finds zero-width and bidi marks, fillers and variation selectors that ride along unseen", () => {
    expect(labels("​‮⁦‎﻿⁠­ㅤᅟ͏᠎", true)).toEqual(["U+200B", "U+202E", "U+2066", "U+200E", "U+FEFF", "U+2060", "U+00AD", "U+3164", "U+115F", "U+034F", "U+180E"])
    // Bytes smuggled as variation selectors after an emoji, or a selector on a plain letter
    expect(labels("😀\u{e0100}\u{e0101} a️", true)).toEqual(["U+E0100", "U+E0101", "U+FE0F"])
  })

  it("passes ordinary text, accents and other scripts", () => {
    expect(labels("GM 2 recap! Thanks @lsr_media #LSR — “quotes” café ñ 日本 한국어", true)).toEqual([])
  })
})
