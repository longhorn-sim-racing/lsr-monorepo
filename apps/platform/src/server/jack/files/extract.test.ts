import { describe, expect, it, vi } from "vitest"
import { capText, cellText, EXTRACT_LIMITS, extractText, vttText, type ExtractLimits } from "./extract"
import { docxFile, imageFile, pdfFile, xlsxFile } from "./fixtures"

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
