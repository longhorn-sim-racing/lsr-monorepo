import { SafeSlot } from "@/components/admin/safe-slot"
import { byOrder, joinSlots, type SlotTrack } from "@/lib/slots"
import { SECTIONS as decksRoomsSections } from "./decks-rooms"
import { SECTIONS as sourcesBSections } from "./sources-b"
import type { InstagramSection } from "./types"

export type { InstagramSection } from "./types"

/**
 * The Instagram page's plug-in sections, joined from the tracks' slot files and sorted by `order`.
 * Loading this module throws if two slots register the same id. Tracks add to their own slot files.
 */
export const INSTAGRAM_SECTIONS: InstagramSection[] = byOrder(
  joinSlots("Instagram section", { "sources-b": sourcesBSections, "decks-rooms": decksRoomsSections } satisfies Partial<Record<SlotTrack, InstagramSection[]>>, (section) => section.id),
)

/** The sections, below the page's own content; nothing while there are none */
export function InstagramSections() {
  if (!INSTAGRAM_SECTIONS.length) return null
  return (
    <div className="mt-4 flex flex-col gap-4">
      {INSTAGRAM_SECTIONS.map((section) => (
        <SafeSlot key={section.id} id={section.id} where="instagram" render={section.Section} />
      ))}
    </div>
  )
}
