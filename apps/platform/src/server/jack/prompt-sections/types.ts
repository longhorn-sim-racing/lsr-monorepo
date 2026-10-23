/**
 * A track's piece of Jack's system prompt (Jack 2.0, design §2.2 and §8). Each track fills its own file
 * in this folder and index.ts puts them together in a fixed order, so parallel work never edits the same
 * lines. The system prompt is the cached prefix, so this is fixed text too: no dates, names, counts or
 * connector status (a tool result says whether a service is connected).
 */
export type PromptSlot = {
  /**
   * The track's own prompt section, starting with its "# Heading" line, or "" for none. Keep it short:
   * how to use the track's tools and its rules. Notes on new tables go to describe_schema instead.
   */
  section: string
  /** Lines for "Where officers make changes", one per admin page, without the leading "- " */
  pages: string[]
}

/** The most a track's section may hold, in characters (the prompt size test checks it) */
export const PROMPT_SECTION_MAX_CHARS = 2_000

/** The most one page line may hold, in characters */
export const PROMPT_PAGE_MAX_CHARS = 240
