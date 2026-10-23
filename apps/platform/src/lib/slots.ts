/**
 * Plug-in slots for Jack 2.0 (#188, design §2.2). Every shared registry (tools, proposal kinds, jobs,
 * connectors, digest checks, Overview cards, page tabs) is split into one file per track, so parallel
 * work never edits the same file. Each registry joins its slot files here, in this fixed order.
 */

/** The build's tracks, in the order their slots are joined. "groundwork" is for the G2–G8 PRs */
export const SLOT_TRACKS = [
  "groundwork",
  "club-data",
  "memory",
  "changes",
  "sources-a",
  "sources-b",
  "documents",
  "discord-read",
  "discord-post",
  "decks-rooms",
  "sponsors-meetings",
  "automation",
] as const

export type SlotTrack = (typeof SLOT_TRACKS)[number]

/**
 * Joins a registry's slots in SLOT_TRACKS order, and throws when two entries share a key, naming both
 * tracks. Registries call it at module load, so a clash fails the build and the tests instead of one
 * entry quietly shadowing the other.
 *
 * A registry that only some tracks plug into leaves the others out of `slots`. A track that is listed
 * but whose slot is still undefined means a slot file was read before it finished loading: an import
 * cycle (a slot file importing its own registry). That throws too, instead of quietly dropping the
 * track's entries.
 */
export function joinSlots<T>(what: string, slots: Partial<Record<SlotTrack, readonly T[]>>, keyOf: (item: T) => string): T[] {
  const seen = new Map<string, SlotTrack>()
  const joined: T[] = []
  for (const track of SLOT_TRACKS) {
    if (!Object.hasOwn(slots, track)) continue
    const slot = slots[track]
    if (!slot) throw new Error(`The ${track} slot of the ${what} registry isn't initialized: an import cycle? (a slot file must not import its own registry)`)
    for (const item of slot) {
      const key = keyOf(item)
      const first = seen.get(key)
      if (first) throw new Error(`Duplicate ${what} "${key}": registered by ${first === track ? `${track} twice` : `${first} and ${track}`}`)
      seen.set(key, track)
      joined.push(item)
    }
  }
  return joined
}

/** Sorts by `order`, keeping slot order for ties (Array.prototype.sort is stable) */
export function byOrder<T extends { order: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order)
}
