export type CycleWindow = "upcoming" | "open" | "closed";

/**
 * Where "now" falls in a recruiting round. `closesAt` is the deadline instant and is
 * exclusive: at exactly `closesAt` the round is already closed, so no write is accepted
 * (the deadline sweep uses the same rule: closesAt <= now).
 */
export function cycleWindow(cycle: { opensAt: Date; closesAt: Date }, now: Date = new Date()): CycleWindow {
  if (now < cycle.opensAt) return "upcoming";
  if (now >= cycle.closesAt) return "closed";
  return "open";
}
