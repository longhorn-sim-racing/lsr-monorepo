import { describe, expect, it, vi } from "vitest"
import { capText, cellText, EXTRACT_LIMITS, extractText, vttText, wordText, xlsxParts, type ExtractLimits } from "./extract"
import { docxFile, imageFile, pdfFile, xlsxFile } from "./fixtures"
import { readZipParts } from "./zip"

const text = (s: string) => Buffer.from(s, "utf8")
const limits = (over: Partial<ExtractLimits>): ExtractLimits => ({ ...EXTRACT_LIMITS, ...over })

describe("extractText", () => {
  it("has no text for images", async () => {
    expect(await extractText("IMAGE", await imageFile("png"))).toEqual({ text: null, textStatus: "none" })
  })

  it("reads text and Markdown as they are, with Windows line endings fixed", async () => {
    expect(await extractText("TEXT", text("﻿# Agenda\r\n- Budget\r\n"))).toEqual({ text: "# Agenda\n- Budget", textStatus: "ok" })
  })

  it("caps text by characters and says it was cut", async () => {
    const result = await extractText("TEXT", text("line\n".repeat(1_000)), limits({ maxChars: 100 }))
    expect(result.textStatus).toBe("truncated")
    expect(result.text!.length).toBeLessThanOrEqual(100)
  })

  it("keeps a CSV's header and the first rows, up to the row cap", async () => {
    const csv = ["name,email", ...Array.from({ length: 50 }, (_, i) => `Driver ${i},d${i}@example.com`)].join("\n")
    const result = await extractText("CSV", text(csv), limits({ maxRows: 10 }))
    expect(result.textStatus).toBe("truncated")
    expect(result.text!.split("\n")).toHaveLength(11)
    expect(result.text!.split("\n")[0]).toBe("name,email")
    expect(await extractText("CSV", text("a,b\n1,2\n"), limits({ maxRows: 10 }))).toEqual({ text: "a,b\n1,2", textStatus: "ok" })
  })

  it("pretty-prints JSON", async () => {
    expect(await extractText("JSON", text('{"event":"GM 2","signups":[1,2]}'))).toEqual({ text: '{\n  "event": "GM 2",\n  "signups": [\n    1,\n    2\n  ]\n}', textStatus: "ok" })
  })

  it("reads a VTT transcript as speaker-tagged turns", async () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Dylan Smith>Welcome to GM 2.</v>\n\n00:00:04.500 --> 00:00:06.000\n<v Dylan Smith>Quick agenda first.</v>\n\n00:01:10.000 --> 00:01:12.000\n<v Gray>Thanks &amp; hi.</v>"
    expect(await extractText("TRANSCRIPT", text(vtt))).toEqual({ text: "[0:01] Dylan Smith: Welcome to GM 2. Quick agenda first.\n[1:10] Gray: Thanks & hi.", textStatus: "ok" })
  })

  it("reads Word documents (DOCX through mammoth)", async () => {
    const result = await extractText("DOCUMENT", docxFile(["Sponsor call notes", "Acme wants two slots."]))
    expect(result.textStatus).toBe("ok")
    expect(result.text).toContain("Sponsor call notes")
    expect(result.text).toContain("Acme wants two slots.")
  })

  it("reads every sheet of a workbook, with formulas as their saved results, never evaluated", async () => {
    const xlsx = await xlsxFile({
      Budget: [
        ["Item", "Cost"],
        ["Tires", 120],
        ["Total", { formula: "SUM(B2:B2)", result: 120 }],
        ["Note", { formula: "HYPERLINK(\"https://evil.example\")" } as never],
      ],
      Hidden: [["a, b", "said \"hi\""]],
    })
    const result = await extractText("SPREADSHEET", xlsx)
    expect(result.textStatus).toBe("ok")
    expect(result.text).toContain('## Sheet: Budget\nItem,Cost\nTires,120\nTotal,120\nNote,"=HYPERLINK(""https://evil.example"")"')
    expect(result.text).toContain('## Sheet: Hidden\n"a, b","said ""hi"""')
  })

  it("caps spreadsheet rows across sheets", async () => {
    const xlsx = await xlsxFile({ One: Array.from({ length: 30 }, (_, i) => [i]), Two: [["never read"]] })
    const result = await extractText("SPREADSHEET", xlsx, limits({ maxRows: 20 }))
    expect(result.textStatus).toBe("truncated")
    expect(result.text).not.toContain("never read")
  })

  it("gives dates as dates", async () => {
    const result = await extractText("SPREADSHEET", await xlsxFile({ GMs: [["GM 2", new Date(Date.UTC(2026, 9, 19))]] }))
    expect(result.text).toContain("GM 2,2026-10-19")
  })

  it("reads a big spreadsheet from a capped slice of its sheet XML, row by row, and stops at the row cap", async () => {
    // A lap export: 20,000 rows is about 4 MB of sheet XML. With 400 KB of XML allowed, exceljs only
    // ever gets the first 400 KB (zip.ts cuts it), and stops reading at the row cap
    const laps = Array.from({ length: 20_000 }, (_, i) => [`Driver ${i % 40}`, `Car ${i % 9}`, i, 90 + (i % 30) / 7, `lap note ${i}`])
    const xlsx = await xlsxFile({ Laps: [["Driver", "Car", "Lap", "Time", "Note"], ...laps] })
    const small = limits({ maxXmlBytes: 400_000, maxRows: 1_000 })
    const sheet = readZipParts(xlsx, xlsxParts(small)).parts.find((p) => p.name === "xl/worksheets/sheet1.xml")!
    expect(sheet).toMatchObject({ cut: true, data: expect.objectContaining({ length: 400_000 }) })

    const result = await extractText("SPREADSHEET", xlsx, small)
    expect(result.textStatus).toBe("truncated")
    const lines = result.text!.split("\n")
    expect(lines.slice(0, 3)).toEqual(["## Sheet: Laps", "Driver,Car,Lap,Time,Note", "Driver 0,Car 0,0,90,lap note 0"])
    expect(lines).toHaveLength(1 + 1_000)

    // A slice too small for the row cap still gives the rows it holds, and says it's partial
    const tiny = await extractText("SPREADSHEET", xlsx, limits({ maxXmlBytes: 20_000 }))
    expect(tiny.textStatus).toBe("truncated")
    expect(tiny.text!.split("\n").length).toBeGreaterThan(50)
  })

  it("stops reading a spreadsheet at the time limit, keeping what it read", async () => {
    const xlsx = await xlsxFile({ One: Array.from({ length: 50 }, (_, i) => [i]) })
    const start = Date.now()
    // The deadline is set from the first reading of the clock; after that the clock is a minute on
    const clock = vi.spyOn(Date, "now").mockImplementation(() => start + 60_000)
    clock.mockImplementationOnce(() => start)
    const result = await extractText("SPREADSHEET", xlsx)
    clock.mockRestore()
    expect(result).toEqual({ text: "## Sheet: One", textStatus: "timeout" })
  })

  it("reads a Word document too big for mammoth straight from its XML, capped", async () => {
    const docx = docxFile(["Bylaws", "Article 1: the club races."])
    expect(await extractText("DOCUMENT", docx, limits({ maxMammothBytes: 10 }))).toEqual({ text: "Bylaws\n\nArticle 1: the club races.", textStatus: "ok" })
    const cut = await extractText("DOCUMENT", docxFile(Array.from({ length: 500 }, (_, i) => `Paragraph ${i}`)), limits({ maxMammothBytes: 10, maxXmlBytes: 2_000 }))
    expect(cut.textStatus).toBe("truncated")
    expect(cut.text).toMatch(/^Paragraph 0\n\nParagraph 1\n/)
    expect(cut.text).not.toContain("Paragraph 499")
  })

  it("reads PDF text page by page, with the page count", async () => {
    const result = await extractText("PDF", await pdfFile(["GM 2 sign-in\nAda Lovelace", "Page two"]))
    expect(result).toMatchObject({ textStatus: "ok", pageCount: 2 })
    expect(result.text).toContain("--- Page 1 ---")
    expect(result.text).toContain("Ada Lovelace")
    expect(result.text).toContain("--- Page 2 ---\nPage two")
  })

  it("stops at the PDF page cap and says so", async () => {
    const result = await extractText("PDF", await pdfFile(["one", "two", "three"]), limits({ maxPdfPages: 2 }))
    expect(result).toMatchObject({ textStatus: "truncated", pageCount: 3 })
    expect(result.text).not.toContain("three")
  })

  it("says none for a PDF with no text layer (a scan)", async () => {
    expect(await extractText("PDF", await pdfFile([""]))).toEqual({ text: null, textStatus: "none", pageCount: 1 })
  })

  it("reports a file its parser can't read as failed, without throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await extractText("PDF", text("%PDF-1.7 broken"))).toEqual({ text: null, textStatus: "failed" })
    expect(await extractText("DOCUMENT", docxFile([]).subarray(0, 40))).toEqual({ text: null, textStatus: "failed" })
  })

  it("gives up at the time limit", async () => {
    const long = await pdfFile(Array.from({ length: 40 }, (_, i) => `Page ${i + 1}`))
    expect(await extractText("PDF", long, limits({ timeoutMs: 1 }))).toMatchObject({ text: null, textStatus: "timeout" })
  })
})

describe("vttText", () => {
  it("takes Zoom's 'Name: text' speakers and leaves notes and headers out", () => {
    const zoom = "WEBVTT\n\nNOTE exported by Zoom\n\n1\n00:00:02.000 --> 00:00:03.000\nAlex Kim: Can everyone hear me?\n\n2\n00:00:05.000 --> 00:00:06.000\nYes."
    expect(vttText(zoom)).toBe("[0:02] Alex Kim: Can everyone hear me?\n[0:05] Yes.")
  })

  it("shows hours for long meetings", () => {
    expect(vttText("WEBVTT\n\n01:02:03.000 --> 01:02:04.000\n<v.loud Sam>Late point</v>")).toBe("[1:02:03] Sam: Late point")
  })
})

describe("wordText", () => {
  it("gives paragraphs, tabs and breaks, and leaves out deleted text, tab stops and a text box's second copy", () => {
    const xml = [
      '<?xml version="1.0"?><w:document><w:body>',
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Item</w:t><w:tab/><w:t xml:space="preserve">$120 </w:t></w:r></w:p>',
      "<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>",
      "<w:p><mc:AlternateContent><mc:Choice><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></mc:Choice><mc:Fallback><w:p><w:r><w:t>Box</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:p>",
      "<w:p><w:r><w:t>Tires &amp; fuel</w:t></w:r></w:p>",
      "</w:body></w:document>",
    ].join("")
    expect(wordText(xml)).toBe("Item\t$120\n\nLine one\nLine two\n\nBox\n\nTires & fuel\n\n")
  })

  it("reads a document cut mid-paragraph up to the cut", () => {
    expect(wordText("<w:document><w:body><w:p><w:r><w:t>Whole</w:t></w:r></w:p><w:p><w:r><w:t>Half a sent")).toBe("Whole\n\nHalf a sent")
  })
})

describe("caps and cells", () => {
  it("cuts at a line break near the cap", () => {
    expect(capText("aaaa\nbbbb\ncccc", 12)).toEqual({ text: "aaaa\nbbbb\ncc", truncated: true })
    expect(capText(`${"a".repeat(95)}\n${"b".repeat(20)}`, 100)).toEqual({ text: "a".repeat(95), truncated: true })
  })

  it("turns spreadsheet cells into text", () => {
    expect(cellText(new Date("2026-10-19T00:00:00.000Z"))).toBe("2026-10-19")
    expect(cellText({ richText: [{ text: "Bold " }, { text: "plain" }] })).toBe("Bold plain")
    expect(cellText({ text: "Site", hyperlink: "https://longhornsimracing.org" })).toBe("Site")
    expect(cellText({ error: "#N/A" })).toBe("#N/A")
    expect(cellText(null)).toBe("")
  })
})
