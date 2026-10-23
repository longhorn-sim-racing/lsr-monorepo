import { jobsFailing, schedulerStalled } from "@/server/scheduler/checks"
import type { DigestCheck } from "../types"

/** Digest and Overview "needs attention" checks from the groundwork track (design §11.2) */
export const CHECKS: DigestCheck[] = [schedulerStalled, jobsFailing]
