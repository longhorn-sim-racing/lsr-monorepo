import { describe, expect, it } from "vitest"
import { ACCEPT_ATTRIBUTE, checkFile, cleanDisplayName, fileExtension, isRasterImage, jackFileUrl, MAX_FILE_BYTES, storageName } from "./files"

const ok = (name: string, type = "", size = 1_000) => checkFile({ name, type, size })

describe("checkFile: what officers can attach", () => {
  it("takes photos, PDFs, spreadsheets, JSON, text, transcripts and Word documents, by extension", () => {
    const cases: [string, string, string][] = [
      ["photo.JPG", "IMAGE", "image/jpeg"],
      ["photo.jpeg", "IMAGE", "image/jpeg"],
      ["shot.png", "IMAGE", "image/png"],
      ["logo.webp", "IMAGE", "image/webp"],
      ["clip.gif", "IMAGE", "image/gif"],
      ["sponsor deck.pdf", "PDF", "application/pdf"],
      ["roster.csv", "CSV", "text/csv"],
      ["budget.xlsx", "SPREADSHEET", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["export.json", "JSON", "application/json"],
      ["notes.txt", "TEXT", "text/plain"],
      ["README.md", "TEXT", "text/markdown"],
      ["GM 2.vtt", "TRANSCRIPT", "text/vtt"],
      ["minutes.docx", "DOCUMENT", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ]
    for (const [name, kind, contentType] of cases) expect(ok(name), name).toMatchObject({ ok: true, kind, contentType })
  })

  it("accepts the types operating systems report for them, and an unknown type", () => {
    expect(ok("roster.csv", "application/vnd.ms-excel").ok).toBe(true) // Windows calls CSV an Excel file
    expect(ok("notes.md", "text/plain").ok).toBe(true)
    expect(ok("GM.vtt", "").ok).toBe(true)
    expect(ok("photo.jpg", "application/octet-stream").ok).toBe(true)
  })

  it("refuses a declared type that contradicts the extension", () => {
    const result = ok("photo.jpg", "application/pdf")
    expect(result).toMatchObject({ ok: false })
    expect(!result.ok && result.error).toContain("doesn't match .jpg")
  })

  it("refuses SVG, HTML and XML, macro files, archives and programs, saying why", () => {
    expect(ok("logo.svg")).toMatchObject({ ok: false, error: expect.stringContaining("can carry scripts") })
    expect(ok("page.html")).toMatchObject({ ok: false, error: expect.stringContaining("can carry scripts") })
    expect(ok("feed.xml")).toMatchObject({ ok: false, error: expect.stringContaining("can carry scripts") })
    expect(ok("budget.xlsm")).toMatchObject({ ok: false, error: expect.stringContaining("macros") })
    expect(ok("letter.docm")).toMatchObject({ ok: false, error: expect.stringContaining("macros") })
    expect(ok("photos.zip")).toMatchObject({ ok: false, error: expect.stringContaining("Archives") })
    expect(ok("backup.tar.gz")).toMatchObject({ ok: false, error: expect.stringContaining("Archives") })
    expect(ok("setup.exe")).toMatchObject({ ok: false, error: expect.stringContaining("Programs") })
    expect(ok("run.ps1")).toMatchObject({ ok: false, error: expect.stringContaining("Programs") })
  })

  it("refuses a dangerous declared type whatever the name says", () => {
    expect(ok("notes.txt", "text/html")).toMatchObject({ ok: false, error: expect.stringContaining("can carry scripts") })
    expect(ok("photo.png", "image/svg+xml")).toMatchObject({ ok: false })
  })

  it("refuses HEIC photos with how to export them as JPEG (the installed sharp can't decode HEVC)", () => {
    expect(ok("IMG_0042.HEIC")).toMatchObject({ ok: false, error: expect.stringContaining("Export it as JPEG") })
    expect(ok("IMG_0042.jpg", "image/heic")).toMatchObject({ ok: false, error: expect.stringContaining("Export it as JPEG") })
  })

  it("names what it takes when it doesn't know the type, or there's no extension", () => {
    expect(ok("slides.pptx")).toMatchObject({ ok: false, error: expect.stringContaining("Jack can't take .pptx files. He takes photos") })
    expect(ok("Makefile")).toMatchObject({ ok: false, error: expect.stringContaining("no extension") })
  })

  it("refuses empty files and files over 25 MB", () => {
    expect(checkFile({ name: "a.txt", size: 0 })).toEqual({ ok: false, error: "This file is empty." })
    expect(checkFile({ name: "a.pdf", size: MAX_FILE_BYTES }).ok).toBe(true)
    expect(checkFile({ name: "a.pdf", size: MAX_FILE_BYTES + 1 })).toEqual({ ok: false, error: "This file is 25 MB; the limit is 25 MB." })
    expect(checkFile({ name: "a.pdf", size: 61_400_000 })).toMatchObject({ error: "This file is 61 MB; the limit is 25 MB." })
  })
})

describe("file names", () => {
  it("keeps the shown name readable but drops folders and invisible characters", () => {
    expect(cleanDisplayName("C:\\Users\\gray\\Desktop\\GM 2 sign-in.csv")).toBe("GM 2 sign-in.csv")
    expect(cleanDisplayName("../../etc/passwd.txt")).toBe("passwd.txt")
    // A right-to-left override would make "photo‮gpj.exe" read as "photoexe.jpg"
    expect(cleanDisplayName("photo\u202Egpj.exe")).toBe("photogpj.exe")
    expect(cleanDisplayName("tab\tand\nnewline.txt")).toBe("tab and newline.txt")
    expect(cleanDisplayName("   ")).toBe("file")
  })

  it("caps a long name at 200 characters, keeping the extension", () => {
    const long = cleanDisplayName(`${"a".repeat(300)}.pdf`)
    expect(long).toHaveLength(200)
    expect(long.endsWith(".pdf")).toBe(true)
  })

  it("makes a storage-safe name: ASCII, no slashes or leading dots, extension kept", () => {
    expect(storageName("GM 2 sign-in (final).csv")).toBe("GM-2-sign-in-final.csv")
    expect(storageName("Café résumé.PDF")).toBe("Cafe-resume.pdf")
    expect(storageName("../../secret.txt")).toBe("secret.txt")
    expect(storageName(".env.txt")).toBe("env.txt")
    expect(storageName("日本語.png")).toBe("file.png")
    expect(storageName(`${"x".repeat(200)}.jpg`)).toBe(`${"x".repeat(80)}.jpg`)
    expect(storageName("a/b\\c%2F..%2Fd.json")).toMatch(/^[A-Za-z0-9._-]+\.json$/)
  })

  it("reads the extension from the last dot of the last path part", () => {
    expect(fileExtension("archive.tar.gz")).toBe("gz")
    expect(fileExtension("folder.v2/README")).toBe("")
    expect(fileExtension(".bashrc")).toBe("")
  })
})

describe("helpers", () => {
  it("serves files by id through the officer route", () => {
    expect(jackFileUrl("abc")).toBe("/api/admin/jack/files/abc")
    expect(jackFileUrl("abc", "thumb")).toBe("/api/admin/jack/files/abc?variant=thumb")
  })

  it("shows raster images inline and nothing else", () => {
    expect(isRasterImage("image/png")).toBe(true)
    expect(isRasterImage("image/jpeg; charset=binary")).toBe(true)
    expect(isRasterImage("image/svg+xml")).toBe(false)
    expect(isRasterImage("application/pdf")).toBe(false)
  })

  it("offers the picker every allowed extension and type", () => {
    expect(ACCEPT_ATTRIBUTE).toContain(".vtt")
    expect(ACCEPT_ATTRIBUTE).toContain("application/pdf")
    expect(ACCEPT_ATTRIBUTE).not.toContain(".svg")
  })
})
