import { SafeSlot } from "@/components/admin/safe-slot"
import { byOrder, joinSlots, type SlotTrack } from "@/lib/slots"
import { SECTIONS as discordPostSections } from "./discord-post"
import type { DiscordSection } from "./types"

export type { DiscordSection } from "./types"

/**
 * The Discord page's plug-in sections, joined from the tracks' slot files and sorted by `order`. Loading
 * this module throws if two slots register the same id. Tracks add to their own slot files.
 */
export const DISCORD_SECTIONS: DiscordSection[] = byOrder(
  joinSlots("Discord section", { "discord-post": discordPostSections } satisfies Partial<Record<SlotTrack, DiscordSection[]>>, (section) => section.id),
)

/** The sections, below the page's own panels; nothing while there are none */
export function DiscordSections() {
  if (!DISCORD_SECTIONS.length) return null
  return (
    <div className="mt-4 flex flex-col gap-4">
      {DISCORD_SECTIONS.map((section) => (
        <SafeSlot key={section.id} id={section.id} where="discord" render={section.Section} />
      ))}
    </div>
  )
}
