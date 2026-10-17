import { describe, expect, it } from "vitest";
import { csvCell, toCsv, uniqueHeaders } from "./csv";

describe("csvCell", () => {
  it("passes plain values through", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(false)).toBe("false");
  });

  it("writes nothing for null and undefined", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes cells with commas, quotes or line breaks, doubling the quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it.each([
    ["=HYPERLINK(\"http://evil.test\",\"click\")", "'=HYPERLINK"],
    ["=1+1", "'=1+1"],
    ["+15125551234", "'+15125551234"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tTabbed", "'\tTabbed"],
    ["\rCarriage", "\"'\rCarriage\""],
  ])("neutralizes a spreadsheet formula: %j", (input, startsWith) => {
    expect(csvCell(input).replace(/^"/, "").startsWith(startsWith.replace(/^"/, ""))).toBe(true);
  });

  it("only guards the start of a cell, not text that merely contains those characters", () => {
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("1-2")).toBe("1-2");
    expect(csvCell("me@example.com")).toBe("me@example.com");
    expect(csvCell(" =not-a-formula")).toBe(" =not-a-formula");
  });

  it("writes dates as ISO text", () => {
    expect(csvCell(new Date("2026-10-16T04:59:00Z"))).toBe("2026-10-16T04:59:00.000Z");
  });
});

describe("toCsv", () => {
  const csv = toCsv(["Name", "Note"], [["Ada", "hi"], ["Grace", "a,b"]]);

  it("starts with a byte-order mark so Excel and Sheets read UTF-8", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("uses CRLF line endings and ends with one", () => {
    expect(csv.slice(1)).toBe('Name,Note\r\nAda,hi\r\nGrace,"a,b"\r\n');
  });

  it("neutralizes formulas in headers as well as rows", () => {
    expect(toCsv(["=bad"], []).slice(1)).toBe("'=bad\r\n");
  });

  it("keeps accents intact", () => {
    expect(toCsv(["Name"], [["José Núñez"]])).toContain("José Núñez");
  });
});

describe("uniqueHeaders", () => {
  it("leaves unique names alone and numbers repeats", () => {
    expect(uniqueHeaders(["A", "B", "A", "A", "B"])).toEqual(["A", "B", "A (2)", "A (3)", "B (2)"]);
  });
});
