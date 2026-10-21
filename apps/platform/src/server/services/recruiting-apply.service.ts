// Whether the public application can be used right now. Applicant pages and actions ask this first.

import { isRecruitingEnabled } from "@/lib/recruiting/flags";
import { launchBlocked } from "@/lib/recruiting/launch";
import { getActiveRound } from "@/server/services/recruiting.service";

export type ApplyRound = { id: string; name: string; slug: string; opensAt: Date; closesAt: Date };

export type ApplyAvailability =
  /** Switched off (the `recruiting` flag) or the questions are still placeholders on the real site: show nothing about why */
  | { state: "off" }
  /** Switched on, but no round is active */
  | { state: "no-round" }
  | { state: "upcoming" | "open" | "closed"; round: ApplyRound };

export async function getApplyAvailability(now: Date = new Date()): Promise<ApplyAvailability> {
  if (launchBlocked() || !(await isRecruitingEnabled())) return { state: "off" };
  const round = await getActiveRound(now);
  if (!round) return { state: "no-round" };
  return { state: round.window, round: { id: round.id, name: round.name, slug: round.slug, opensAt: round.opensAt, closesAt: round.closesAt } };
}
