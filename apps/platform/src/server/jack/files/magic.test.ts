import { strToU8 } from "fflate"
import { describe, expect, it } from "vitest"
import { docxFile, imageFile, pdfFile, xlsxFile, zipBomb } from "./fixtures"
import { checkContent, sniff } from "./magic"
import { decodeText } from "./text"

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const text = (s: string) => Buffer.from(s, "utf8")

describe("checkContent: the bytes match the declared type", () => {
  it("passes real images of each type, and refuses one renamed as another", async () => {
    for (const format of ["png", "jpeg", "webp", "gif"] as const) {
      expect(checkContent(`image/${format}`, await imageFile(format)), format).toEqual({ ok: true })
    }
    const jpeg = await imageFile("jpeg")
    expect(checkContent("image/png", jpeg)).toEqual({ ok: false, error: "This isn't the PNG its name says: it looks like a JPEG." })
  })

  it("names an HEIC photo saved as .jpg and says to export it", () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)])
    expect(checkContent("image/jpeg", heic)).toMatchObject({ ok: false, error: expect.stringContaining("HEIC photo") })
  })

  it("refuses a program or an HTML page posing as an image or PDF", () => {
    expect(checkContent("image/png", Buffer.from("MZ\x90\x00 this program cannot be run"))).toEqual({ ok: false, error: "This isn't the PNG its name says: it looks like a Windows program." })
    expect(checkContent("application/pdf", text("<html><script>alert(1)</script></html>"))).toMatchObject({ ok: false, error: expect.stringContaining("doesn't look like a PDF") })
  })

  it("passes a PDF, even with a little junk before its header", async () => {
    const pdf = await pdfFile(["Hello"])
    expect(checkContent("application/pdf", pdf)).toEqual({ ok: true })
    expect(checkContent("application/pdf", Buffer.concat([Buffer.from("junk\n"), pdf]))).toEqual({ ok: true })
  })

  it("passes real DOCX and XLSX files, and checks what's inside the ZIP", async () => {
    expect(checkContent(DOCX, docxFile(["Hi"]))).toEqual({ ok: true })
    expect(checkContent(XLSX, await xlsxFile({ Sheet1: [["a", 1]] }))).toEqual({ ok: true })
    // A Word file isn't a spreadsheet, and a plain ZIP is neither
    expect(checkContent(XLSX, docxFile(["Hi"]))).toMatchObject({ ok: false, error: expect.stringContaining("isn't an Excel spreadsheet") })
    expect(checkContent(DOCX, text("not a zip at all"))).toMatchObject({ ok: false, error: expect.stringContaining("Word document") })
  })

  it("refuses Office files with macros, whatever they're called", () => {
    const macro = docxFile(["Hi"], { "word/vbaProject.bin": strToU8("Attribute VB_Name") })
    expect(checkContent(DOCX, macro)).toMatchObject({ ok: false, error: expect.stringContaining("macros") })
  })

  it("refuses a zip bomb before any parser opens it", () => {
    const bomb = zipBomb(5_000_000)
    expect(bomb.length).toBeLessThan(50_000)
    expect(checkContent(DOCX, bomb, { maxEntries: 100, maxTotalBytes: 1_000_000 })).toMatchObject({ ok: false, error: expect.stringContaining("unpacks to far more") })
  })

  it("passes text that's text, refuses binary that claims to be text", () => {
    expect(checkContent("text/csv", text("name,email\nAda,ada@example.com\n"))).toEqual({ ok: true })
    expect(checkContent("text/plain", Buffer.from([0x48, 0x00, 0x49, 0x00, 0xff, 0x00]))).toMatchObject({ ok: false })
  })

  it("requires JSON to parse and a VTT to start with WEBVTT", () => {
    expect(checkContent("application/json", text('{"a":1}'))).toEqual({ ok: true })
    expect(checkContent("application/json", text("{a:1}"))).toEqual({ ok: false, error: "This JSON file isn't valid JSON, so it can't be read." })
    expect(checkContent("text/vtt", text("﻿WEBVTT\n\n00:00.000 --> 00:01.000\nHi"))).toEqual({ ok: true })
    expect(checkContent("text/vtt", text("1\n00:00:01,000 --> 00:00:02,000\nAn SRT file"))).toMatchObject({ ok: false, error: expect.stringContaining("WEBVTT") })
  })
})

describe("sniff", () => {
  it("names common formats from their first bytes", async () => {
    expect(sniff(await imageFile("gif"))).toBe("a GIF")
    expect(sniff(docxFile([]))).toBe("a ZIP archive")
    expect(sniff(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1]))).toBe("an old Office file (.doc or .xls)")
    expect(sniff(text("plain words"))).toBeNull()
  })
})

describe("decodeText", () => {
  it("reads UTF-8 (with or without a BOM), UTF-16 with a BOM, and Windows-1252", () => {
    expect(decodeText(text("﻿Café"))).toBe("Café")
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hi é", "utf16le")]))).toBe("Hi é")
    expect(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe("Café") // é in Windows-1252
  })

  it("says null for binary", () => {
    expect(decodeText(Buffer.from([0x00, 0x01, 0x02]))).toBeNull()
    expect(decodeText(Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 2 ? 0x01 : 0x41))))).toBeNull()
  })
})
