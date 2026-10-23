import { EntriesTab } from "../_components/entries-tab"
import type { KnowledgeTab } from "./types"

/** Knowledge page tabs from the memory track */
export const TABS: KnowledgeTab[] = [{ id: "entries", label: "Entries", order: 0, Tab: EntriesTab }]
