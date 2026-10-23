/**
 * A track's notes on its tables, for describe_schema (#188, design §8: detailed table notes go to
 * describe_schema, not the system prompt). Same style as ../schema-notes.ts: short, true to the code.
 */
export type SchemaNotesSlot = {
  /** A paragraph or a few "- " lines on how the track's tables fit together; added after the core notes when describe_schema lists every table. Empty for none */
  notes: string
  /** One line per table, shown next to its columns. A note on a table that already has one is appended to it */
  tableNotes: Record<string, string>
}
