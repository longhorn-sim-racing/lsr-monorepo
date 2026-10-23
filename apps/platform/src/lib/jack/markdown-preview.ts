/**
 * A rendered preview of Markdown on a proposal card (#188, design §4.3: news posts show a rendered
 * preview). The server parses the Markdown the way the site's MDX does and saves this small tree with
 * the proposal; the card draws it as React elements, never as HTML, and never loads a picture from a
 * link (an image shows as a link with its host). Plain JSON: it's saved on JackProposal.view.
 */

export type MdPreviewInline =
  | { t: "text"; v: string }
  | { t: "strong" | "em" | "del"; c: MdPreviewInline[] }
  | { t: "code"; v: string }
  /** `url`: a site path or a web link, as written; the card checks it before linking (partLink) */
  | { t: "link"; url: string; c: MdPreviewInline[] }
  | { t: "image"; url: string; alt: string }
  | { t: "br" }

export type MdPreviewListItem = { checked?: boolean; c: MdPreviewBlock[] }

export type MdPreviewAlign = "left" | "center" | "right" | null

export type MdPreviewBlock =
  | { t: "h"; depth: number; c: MdPreviewInline[] }
  | { t: "p"; c: MdPreviewInline[] }
  | { t: "code"; lang?: string; v: string }
  | { t: "quote"; c: MdPreviewBlock[] }
  | { t: "list"; ordered: boolean; start?: number; items: MdPreviewListItem[] }
  /** The first row is the header */
  | { t: "table"; align: MdPreviewAlign[]; rows: MdPreviewInline[][][] }
  | { t: "hr" }

export type JackProposalPreview = {
  /** What it previews, e.g. "News post preview" */
  label: string
  /** Shown above the text as the page shows it: the post's title and excerpt */
  title?: string
  excerpt?: string
  blocks: MdPreviewBlock[]
  /** The text was too long to preview whole; the card says so */
  truncated?: boolean
}
