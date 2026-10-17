/**
 * CSV for Google Sheets / Excel. Applicants write many of these values, so a cell that starts
 * with = + - @ (or a tab / carriage return) would be run as a formula by a spreadsheet; those get
 * a leading apostrophe, which makes the spreadsheet treat the cell as text.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A byte-order mark makes Excel and Sheets read the file as UTF-8 (accents, apostrophes). */
const BOM = String.fromCharCode(0xfeff);

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(","));
  return BOM + lines.join("\r\n") + "\r\n";
}

/** Makes column names unique by adding a suffix to repeats, so two questions with the same label stay separate. */
export function uniqueHeaders(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}
