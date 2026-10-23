import { describe, expect, it } from "vitest"
import { parseCsv, readTable } from "./table"

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes and line breaks inside quotes", () => {
    expect(parseCsv('a,b,c\n"x, y","say ""hi""","two\nlines"\r\nlast,,')).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "two\nlines"],
      ["last", "", ""],
    ])
  })
})

describe("readTable", () => {
  it("reads a CSV's header and the rows that have something in them", () => {
    const table = readTable("﻿Name,Email,Name\nAna,ana@example.com,A\n,,\nBen ,ben@example.com,B\n", { workbook: false, filename: "list.csv" })
    expect(table).toEqual({
      sheet: null,
      sheets: [],
      headers: ["Name", "Email", "Name (2)"],
      rows: [
        ["Ana", "ana@example.com", "A"],
        ["Ben", "ben@example.com", "B"],
      ],
    })
  })

  it("reads a workbook's sheets, the first with rows unless one is named", () => {
    const text = "## Sheet: Notes\nonly a title\n\n## Sheet: Responses\nEmail,Discord\nana@example.com,ana#1\n\n## Sheet: Old (hidden)\nEmail\nold@example.com\n"
    expect(readTable(text, { workbook: true, filename: "form.xlsx" })).toMatchObject({ sheet: "Responses", sheets: ["Notes", "Responses", "Old"], headers: ["Email", "Discord"], rows: [["ana@example.com", "ana#1"]] })
    expect(readTable(text, { workbook: true, sheet: "old", filename: "form.xlsx" })).toMatchObject({ sheet: "Old", rows: [["old@example.com"]] })
    expect(() => readTable(text, { workbook: true, sheet: "Missing", filename: "form.xlsx" })).toThrow("form.xlsx has no sheet “Missing”. Its sheets: Notes, Responses, Old.")
  })

  it("names blank headers and says when there's nothing to read", () => {
    expect(readTable("Email,\na@example.com,x", { workbook: false, filename: "a.csv" }).headers).toEqual(["Email", "Column 2"])
    expect(() => readTable("Only,a,header\n", { workbook: false, filename: "a.csv" })).toThrow("a.csv has no rows under a header row.")
  })
})
