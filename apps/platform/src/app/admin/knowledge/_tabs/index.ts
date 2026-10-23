import { byOrder, joinSlots, type SlotTrack } from "@/lib/slots"
import { TABS as documentsTabs } from "./documents"
import { TABS as memoryTabs } from "./memory"
import type { KnowledgeTab } from "./types"

export type { KnowledgeSearchParams, KnowledgeTab } from "./types"

/**
 * The Knowledge page's tabs, joined from the tracks' slot files and sorted by `order`. Loading this
 * module throws if two slots register the same id. Tracks add to their own slot files.
 */
export const KNOWLEDGE_TABS: KnowledgeTab[] = byOrder(
  joinSlots("Knowledge tab", { memory: memoryTabs, documents: documentsTabs } satisfies Partial<Record<SlotTrack, KnowledgeTab[]>>, (tab) => tab.id),
)

/** The tab a `?tab=` value names, or the first tab */
export function findKnowledgeTab(id: string | undefined): KnowledgeTab | undefined {
  return KNOWLEDGE_TABS.find((tab) => tab.id === id) ?? KNOWLEDGE_TABS[0]
}
