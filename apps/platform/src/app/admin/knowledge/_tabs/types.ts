import type { ReactNode } from "react"

/** The Knowledge page's search params, as Next.js passes them (already awaited) */
export type KnowledgeSearchParams = Record<string, string | string[] | undefined>

/**
 * A tab on the Knowledge page (#188, design §9): Entries (memory track), Documents and Teams messages
 * (documents track). Registered in `_tabs/<track>.tsx`; the memory track builds the page and its tab
 * bar from this registry. `Tab` is a server component that loads its own data for the page's search
 * params (search box, filters, page number).
 */
export type KnowledgeTab = {
  /** Stable, used in the URL (?tab=documents) */
  id: string
  /** e.g. "Documents" */
  label: string
  /** Where it sits in the tab bar, lowest first */
  order: number
  Tab: (props: { searchParams: KnowledgeSearchParams }) => Promise<ReactNode> | ReactNode
}
