/**
 * A room opened at an old message (?m=, #188) in a long room loads a window around it the size of a
 * normal snapshot, which stops short of the newest messages. The gap is what the window left out:
 * every message after `after` up to `through`, the newest when the window was loaded. The page shows
 * a divider there with a link to the latest, and later snapshots don't fill the gap in (that would
 * double what the page holds); messages after `through` arrive live as usual.
 */
export type SnapshotGap = {
  /** The last message the window holds */
  after: { id: string; createdAt: string }
  /** The newest message in the room when the window was loaded */
  through: { id: string; createdAt: string }
  /** How many messages the gap holds */
  count: number
}

type Placed = { id: string; createdAt: string }

/** Whether `a` comes after `b` in a room: by time, then id, as snapshots order them */
function isAfter(a: Placed, b: Placed): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)
}

/** The messages outside the gap: what a later snapshot may add to a room opened at an old message */
export function outsideGap<T extends Placed>(messages: T[], gap: Pick<SnapshotGap, "after" | "through">): T[] {
  return messages.filter((message) => !isAfter(message, gap.after) || isAfter(message, gap.through))
}
