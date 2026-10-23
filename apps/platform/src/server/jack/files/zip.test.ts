import { strToU8 } from "fflate"
import { describe, expect, it } from "vitest"
import { docxFile, handZip, localEntry, xlsxFile, zipBomb } from "./fixtures"
import { checkContent } from "./magic"
import { inspectZip, packZip, readZipParts, ZipLimitError, type PartPlan } from "./zip"

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const xml = (s: string) => strToU8(s)
const TYPES = localEntry("[Content_Types].xml", xml("<Types/>"))
const DOCUMENT = localEntry("word/document.xml", xml("<w:document><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>"), true)
const BOMB = localEntry("word/vbaProject.bin", new Uint8Array(5_000_000), true)

describe("inspectZip: the central directory and the local headers must agree", () => {
  it("lists the entries and counts the real uncompressed size", () => {
    const { names, totalBytes } = inspectZip(docxFile(["Hello"]))
    expect(names).toEqual(expect.arrayContaining(["[Content_Types].xml", "word/document.xml"]))
    expect(totalBytes).toBeGreaterThan(100)
  })

  it("reads a hand-written archive the same as a normal one", () => {
    expect(inspectZip(handZip([TYPES, DOCUMENT])).names).toEqual(["[Content_Types].xml", "word/document.xml"])
    expect(checkContent(DOCX, handZip([TYPES, DOCUMENT]))).toEqual({ ok: true })
  })

  it("refuses an entry the central directory lists inside another entry's data (hidden from a front-to-back reader)", () => {
    // A stored entry whose data is a whole second entry; only the central directory points at it
    const outer = localEntry("word/document.xml", BOMB.bytes)
    const zip = handZip([TYPES, outer], (o) => [
      { ...TYPES, offset: o[0] },
      { ...outer, offset: o[1] },
      { ...BOMB, offset: o[1] + 30 + outer.name.length },
    ])
    expect(() => inspectZip(zip)).toThrow(new ZipLimitError("layout"))
    expect(checkContent(DOCX, zip)).toMatchObject({ ok: false, error: expect.stringContaining("damaged") })
  })

  it("refuses two central records pointing at the same data", () => {
    const zip = handZip([TYPES, DOCUMENT], (o) => [
      { ...TYPES, offset: o[0] },
      { ...DOCUMENT, offset: o[1] },
      { ...DOCUMENT, name: "word/footnotes.xml", offset: o[1] },
    ])
    expect(() => inspectZip(zip)).toThrow(new ZipLimitError("layout"))
  })

  it("refuses a local entry the central directory leaves out (seen only by a front-to-back reader)", () => {
    const zip = handZip([TYPES, BOMB, DOCUMENT], (o) => [
      { ...TYPES, offset: o[0] },
      { ...DOCUMENT, offset: o[2] },
    ])
    expect(() => inspectZip(zip)).toThrow(new ZipLimitError("layout"))
  })

  it("refuses a central record whose name isn't the local header's, and the same name twice", () => {
    expect(() => inspectZip(handZip([TYPES, DOCUMENT], (o) => [{ ...TYPES, offset: o[0] }, { ...DOCUMENT, name: "word/other.xml", offset: o[1] }]))).toThrow(new ZipLimitError("layout"))
    const twice = localEntry("[Content_Types].xml", xml("<Types/>"))
    expect(() => inspectZip(handZip([TYPES, twice]))).toThrow(new ZipLimitError("layout"))
  })

  it("counts entries before reading them, and refuses garbage", () => {
    expect(() => inspectZip(docxFile(["a"]), { maxEntries: 1, maxTotalBytes: 1e9 })).toThrow(new ZipLimitError("entries"))
    expect(() => inspectZip(Buffer.from("PK\x03\x04 then nothing a ZIP needs"))).toThrow(new ZipLimitError("corrupt"))
  })

  it("stops inflating a bomb at the cap", () => {
    expect(() => inspectZip(zipBomb(50_000_000), { maxEntries: 10, maxTotalBytes: 2_000_000 })).toThrow(new ZipLimitError("size"))
  })
})

describe("readZipParts and packZip: what a parser gets", () => {
  const plan: PartPlan = {
    pick: (name) => (/^xl\/worksheets\/sheet\d+\.xml$/.test(name) ? { group: "sheets", max: 1_000 } : name === "xl/workbook.xml" ? { group: "book", max: 100_000 } : null),
    budgets: { sheets: 1_500, book: 100_000 },
  }

  it("keeps only the picked parts, cutting each at its cap and its group's budget", async () => {
    const wide = Array.from({ length: 200 }, (_, i) => [`row ${i}`, i])
    const xlsx = await xlsxFile({ One: wide, Two: wide, Three: wide })
    const { parts, left } = readZipParts(xlsx, plan)
    // exceljs writes the sheets before the workbook; the parts come in archive order
    expect(parts.map((p) => [p.name, p.data.length, p.cut])).toEqual([
      ["xl/worksheets/sheet1.xml", 1_000, true],
      ["xl/worksheets/sheet2.xml", 500, true],
      ["xl/workbook.xml", expect.any(Number), false],
    ])
    expect(left).toEqual(["xl/worksheets/sheet3.xml"])
  })

  it("never inflates what it doesn't pick", () => {
    // Deflate data that can't be inflated: reading it would fail, so passing means it was never read
    const broken = localEntry("xl/media/huge.bin", new Uint8Array(1_000), true)
    broken.bytes.fill(0xff, 30 + broken.name.length)
    const zip = handZip([localEntry("xl/workbook.xml", xml("<workbook/>")), broken])
    expect(() => inspectZip(zip)).toThrow(new ZipLimitError("corrupt"))
    expect(readZipParts(zip, plan).parts.map((p) => [p.name, Buffer.from(p.data).toString(), p.cut])).toEqual([["xl/workbook.xml", "<workbook/>", false]])
  })

  it("packs the parts into a fresh archive with only those entries, in order", () => {
    const packed = packZip([
      { name: "b.xml", data: xml("<b/>") },
      { name: "a.xml", data: xml("<a/>") },
    ])
    expect(inspectZip(packed).names).toEqual(["b.xml", "a.xml"])
    expect(readZipParts(packed, { pick: () => ({ group: "all", max: 100 }), budgets: { all: 100 } }).parts.map((p) => Buffer.from(p.data).toString())).toEqual(["<b/>", "<a/>"])
  })
})
