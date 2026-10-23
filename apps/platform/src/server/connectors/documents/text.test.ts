import { strToU8, zipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import { EXTRACT_LIMITS, extractText } from "@/server/jack/files/extract"
import { fakeDocx, fakePdf, fakePptx } from "../google-drive/fake/fixtures"
import { readCapped } from "./bytes"
import { cleanDocumentName, documentReader, documentText, folderPath, presentationText, slideXmlText } from "./text"

// The real extractors, with a way to hand back what a reader would give
vi.mock("@/server/jack/files/extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/jack/files/extract")>()
  return { ...actual, extractText: vi.fn(actual.extractText) }
})

const buffer = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === "string" ? strToU8(bytes) : bytes)

describe("documentReader", () => {
  it("goes by the name's extension first, then the type", () => {
    expect(documentReader("Budget.XLSX", "application/octet-stream")).toMatchObject({ kind: "SPREADSHEET" })
    expect(documentReader("notes", "text/markdown; charset=utf-8")).toMatchObject({ kind: "TEXT" })
    expect(documentReader("GM 2.vtt", "text/plain")).toMatchObject({ kind: "TRANSCRIPT" })
    expect(documentReader("deck.pptx", "")).toMatchObject({ kind: "PRESENTATION" })
  })

  it("reads nothing from images, old Office files or macro files", () => {
    expect(documentReader("logo.png", "image/png")).toBeNull()
    expect(documentReader("budget.xls", "application/vnd.ms-excel")).toBeNull()
    expect(documentReader("budget.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12")).toBeNull()
    expect(documentReader("deck.pptm", "")).toBeNull()
  })
})

describe("documentText", () => {
  it("reads Markdown and CSV exports as they are", async () => {
    expect(await documentText({ kind: "TEXT", contentType: "text/markdown" }, buffer("# Inventory\r\n- 7 wheels\r\n"))).toEqual({ text: "# Inventory\n- 7 wheels", textStatus: "ok" })
    expect(await documentText({ kind: "CSV", contentType: "text/csv" }, buffer("Name,Shift\nA,Morning\n"))).toEqual({ text: "Name,Shift\nA,Morning", textStatus: "ok" })
  })

  it("tags a transcript's lines with their speakers, as room files are", async () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Fixture President>Welcome.</v>\n\n00:01:10.000 --> 00:01:12.000\n<v Fixture Treasurer>Budget is 400.</v>"
    expect(await documentText(documentReader("GM.vtt", "text/vtt")!, buffer(vtt))).toEqual({ text: "[0:01] Fixture President: Welcome.\n[1:10] Fixture Treasurer: Budget is 400.", textStatus: "ok" })
  })

  it("reads PDFs and Word files through G5's extractors", async () => {
    const pdf = await documentText(documentReader("contract.pdf", "")!, buffer(await fakePdf(["Deposit: 250 dollars"])))
    expect(pdf.textStatus).toBe("ok")
    expect(pdf.text).toContain("Deposit: 250 dollars")
    const docx = await documentText(documentReader("notes.docx", "")!, buffer(fakeDocx(["Hall B is booked."])))
    expect(docx).toEqual({ text: "Hall B is booked.", textStatus: "ok" })
  })

  it("refuses a file that isn't what its name says, before any parser sees it", async () => {
    expect(await documentText(documentReader("contract.pdf", "")!, buffer("not a pdf at all"))).toEqual({ text: null, textStatus: "error" })
    expect(await documentText(documentReader("notes.docx", "")!, buffer(await fakePdf(["x"])))).toEqual({ text: null, textStatus: "error" })
    expect(await documentText(documentReader("data.json", "")!, buffer("{ not json"))).toEqual({ text: null, textStatus: "error" })
  })

  it("says when a readable file has no text", async () => {
    expect(await documentText({ kind: "TEXT", contentType: "text/plain" }, buffer("   \n"))).toEqual({ text: null, textStatus: "none" })
  })

  it("drops NUL characters, which Postgres can't store (the readers pass them through)", async () => {
    const deck = documentReader("budget.pptx", "")!
    expect(await documentText(deck, buffer(fakePptx([{ lines: ["Budget\u0000 2026"] }])))).toEqual({ text: "--- Slide 1 ---\nBudget 2026", textStatus: "ok" })
    // Nothing left but the NULs: no text
    expect(await documentText(deck, buffer(fakePptx([{ lines: ["\u0000\u0000"] }])))).toEqual({ text: null, textStatus: "none" })
    // pdf.js gives NULs for some fonts
    vi.mocked(extractText).mockResolvedValueOnce({ text: "Budget\u0000 2026", textStatus: "ok" })
    expect(await documentText(documentReader("budget.pdf", "")!, buffer(await fakePdf(["Budget 2026"])))).toEqual({ text: "Budget 2026", textStatus: "ok" })
  })

  it("never throws: a reader that does makes the file \"error\"", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(extractText).mockRejectedValueOnce(new Error("reader crashed"))
    expect(await documentText(documentReader("contract.pdf", "")!, buffer(await fakePdf(["x"])))).toEqual({ text: null, textStatus: "error" })
    warn.mockRestore()
  })

  it("keeps the start of a long text and says it was cut", async () => {
    const result = await documentText({ kind: "TEXT", contentType: "text/plain" }, buffer("line\n".repeat(500)), { ...EXTRACT_LIMITS, maxChars: 100 })
    expect(result.textStatus).toBe("truncated")
    expect(result.text!.length).toBeLessThanOrEqual(100)
  })
})

describe("presentationText", () => {
  it("reads each slide in order, with its speaker notes", async () => {
    const deck = buffer(fakePptx([{ lines: ["Brand guide", "Burnt orange first"] }, { lines: ["Logos & marks"], notes: "White logo on dark photos" }]))
    expect(await presentationText(deck)).toEqual({ text: "--- Slide 1 ---\nBrand guide\nBurnt orange first\n\n--- Slide 2 ---\nLogos & marks\nNotes: White logo on dark photos", textStatus: "ok" })
  })

  it("sorts slides by number, not by name (slide10 after slide2)", async () => {
    const slides = Array.from({ length: 11 }, (_, i) => ({ lines: [`Slide text ${i + 1}`] }))
    const { text } = await presentationText(buffer(fakePptx(slides)))
    expect(text!.indexOf("Slide text 2")).toBeLessThan(text!.indexOf("Slide text 10"))
  })

  it("refuses decks with macros, archives that aren't decks and zip bombs", async () => {
    expect(await presentationText(buffer(fakePptx([{ lines: ["x"] }], { "ppt/vbaProject.bin": new Uint8Array(8) })))).toEqual({ text: null, textStatus: "error" })
    expect(await presentationText(buffer(fakeDocx(["not a deck"])))).toEqual({ text: null, textStatus: "error" })
    const bomb = zipSync({ "ppt/presentation.xml": strToU8("<p/>"), "ppt/slides/slide1.xml": new Uint8Array(120_000_000) }, { level: 9 })
    expect(await presentationText(buffer(bomb))).toEqual({ text: null, textStatus: "error" })
    expect(await presentationText(buffer("plain text"))).toEqual({ text: null, textStatus: "error" })
  })

  it("has no text for a deck of pictures", async () => {
    expect(await presentationText(buffer(fakePptx([{ lines: [] }])))).toEqual({ text: null, textStatus: "none" })
  })
})

describe("slideXmlText", () => {
  it("joins a paragraph's runs, keeps breaks and decodes entities", () => {
    const xml = `<p:sld><a:p><a:r><a:t>Gold </a:t></a:r><a:r><a:t>tier</a:t></a:r></a:p><a:p><a:r><a:t>A&amp;B</a:t></a:r><a:br/><a:r><a:t>&#x2014;next</a:t></a:r></a:p></p:sld>`
    expect(slideXmlText(xml)).toBe("Gold tier\nA&B\n—next")
  })

  it("reads a part full of unclosed tags in linear time", () => {
    const started = Date.now()
    expect(slideXmlText(`<a:t>${"<a ".repeat(100_000)}`)).toHaveLength(199_999)
    slideXmlText(`<${"a".repeat(300_000)}`)
    slideXmlText(`<a${" ".repeat(300_000)}`)
    // Quadratic matching took seconds on inputs this size (and hours on a 16 MB slide)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe("names and paths", () => {
  it("strips invisible and bidirectional characters, and caps the length", () => {
    expect(cleanDocumentName("budget‮fdp.exe")).toBe("budgetfdp.exe")
    expect(cleanDocumentName("  Sponsor\n deck  ")).toBe("Sponsor deck")
    expect(cleanDocumentName("x".repeat(400))).toHaveLength(300)
    expect(cleanDocumentName("​")).toBe("Untitled")
  })

  it("builds a folder path, with a slash inside a name kept apart from the separators", () => {
    expect(folderPath([])).toBe("/")
    expect(folderPath(["Events", "Q1/Q2"])).toBe("/Events/Q1∕Q2")
  })
})

describe("readCapped", () => {
  it("reads a body under the cap and refuses one over it, by its header or as it streams", async () => {
    expect((await readCapped(new Response("hello"), 10))?.toString()).toBe("hello")
    expect(await readCapped(new Response("hello", { headers: { "content-length": "5000" } }), 10)).toBeNull()
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(8))
        controller.close()
      },
    })
    expect(await readCapped(new Response(stream), 20)).toBeNull()
  })
})
