import { TIERS, type TierId } from "@/app/sponsors/tiers"
import { centralDay } from "@/lib/meetings"

/**
 * Sponsor prospects (#188, design §3.3 and §13): companies the club is courting for sponsorship, their
 * stage and the activity with each. Not the sponsors on the website (src/lib/sponsors.ts), which are set
 * in the site's code; the schema doesn't link the two. Shared by the Sponsors page, Jack's tools and
 * proposals, and the digest checks.
 */

export const PROSPECT_STAGES = ["idea", "researching", "contacted", "talking", "committed", "declined", "dormant"] as const
export type ProspectStage = (typeof PROSPECT_STAGES)[number]

export const PROSPECT_STAGE_LABEL: Record<ProspectStage, string> = {
  idea: "Idea",
  researching: "Researching",
  contacted: "Contacted",
  talking: "Talking",
  committed: "Committed",
  declined: "Declined",
  dormant: "Dormant",
}

/** Badge tones, by meaning: talking and committed are good news, declined is closed */
export const PROSPECT_STAGE_TONE: Record<ProspectStage, "neutral" | "info" | "accent" | "success" | "warning" | "danger"> = {
  idea: "neutral",
  researching: "neutral",
  contacted: "info",
  talking: "accent",
  committed: "success",
  declined: "danger",
  dormant: "neutral",
}

/** Still being worked on */
export const OPEN_STAGES: readonly ProspectStage[] = ["idea", "researching", "contacted", "talking"]
/** Finished either way */
export const CLOSED_STAGES: readonly ProspectStage[] = ["declined", "dormant"]
/** The club has reached out, so a long silence means a follow-up is overdue (the quiet check) */
export const FOLLOW_UP_STAGES: readonly ProspectStage[] = ["contacted", "talking"]

/** A prospect in a follow-up stage with no activity for this long counts as quiet (digest check, Sponsors page) */
export const QUIET_PROSPECT_DAYS = 21

export function isProspectStage(value: unknown): value is ProspectStage {
  return typeof value === "string" && (PROSPECT_STAGES as readonly string[]).includes(value)
}

/** A stage from what someone typed: the key or its label, any case ("Talking", "talking") */
export function parseProspectStage(value: string): ProspectStage | null {
  const clean = value.trim().toLowerCase()
  return PROSPECT_STAGES.find((stage) => stage === clean || PROSPECT_STAGE_LABEL[stage].toLowerCase() === clean) ?? null
}

/** The sponsorship tiers a prospect can be interested in (the Sponsors page's packages) */
export const TIER_IDS = TIERS.map((tier) => tier.id) as [TierId, ...TierId[]]
export const TIER_LABEL: Record<TierId, string> = Object.fromEntries(TIERS.map((tier) => [tier.id, tier.short])) as Record<TierId, string>

/** A tier from what someone typed: the id, the short name or the full name ("Gold", "Gold Partner") */
export function parseTier(value: string): TierId | null {
  const clean = value.trim().toLowerCase()
  return TIERS.find((tier) => tier.id === clean || tier.short.toLowerCase() === clean || tier.name.toLowerCase() === clean)?.id ?? null
}

/** What an officer can log; stage_change entries are written by the system when the stage changes */
export const ACTIVITY_TYPES = ["email_sent", "reply", "meeting", "call", "note"] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]
export type AnyActivityType = ActivityType | "stage_change"

export const ACTIVITY_LABEL: Record<AnyActivityType, string> = {
  email_sent: "Email sent",
  reply: "Reply",
  meeting: "Meeting",
  call: "Call",
  note: "Note",
  stage_change: "Stage change",
}

/** These are contact with the company: they move lastContactAt */
export const CONTACT_TYPES: readonly AnyActivityType[] = ["email_sent", "reply", "meeting", "call"]

export function activityLabel(type: string): string {
  return ACTIVITY_LABEL[type as AnyActivityType] ?? type
}

export const prospectPath = (id: string) => `/admin/sponsors/${id}`
export const SPONSORS_PAGE = "/admin/sponsors"

/** The text a stage change logs, e.g. "Stage: Contacted → Talking" */
export function stageChangeSummary(from: string, to: string): string {
  return `Stage: ${PROSPECT_STAGE_LABEL[from as ProspectStage] ?? from} → ${PROSPECT_STAGE_LABEL[to as ProspectStage] ?? to}`
}

/** Company names compare without case, spacing or a trailing "Inc."-style suffix, so "Acme, Inc." finds "ACME" */
export function companyKey(company: string): string {
  const words = company
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return words.replace(/ (inc|llc|ltd|co|corp|corporation|company)$/, "").trim() || words
}

/**
 * When a prospect last moved: its newest activity, else its last contact, else when it was added. The
 * quiet check and the "last activity" column count from this
 */
export function lastTouch(p: { createdAt: Date; lastContactAt: Date | null; lastActivityAt?: Date | null }): Date {
  const times = [p.createdAt, p.lastContactAt, p.lastActivityAt ?? null].filter((t): t is Date => t instanceof Date)
  return new Date(Math.max(...times.map((t) => t.getTime())))
}

/** In a follow-up stage and nothing has happened for QUIET_PROSPECT_DAYS */
export function isQuietProspect(p: { stage: string; createdAt: Date; lastContactAt: Date | null; lastActivityAt?: Date | null }, now: Date): boolean {
  if (!(FOLLOW_UP_STAGES as readonly string[]).includes(p.stage)) return false
  return now.getTime() - lastTouch(p).getTime() >= QUIET_PROSPECT_DAYS * 86_400_000
}

/** Whole days since an instant (0 for today or the future) */
export function daysSince(date: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000))
}

/** A next step whose due date (a Central date) is before today, on a prospect that isn't closed or committed */
export function isNextStepOverdue(p: { nextStepDue: Date | null; stage: string }, now: Date): boolean {
  if (!p.nextStepDue || !(OPEN_STAGES as readonly string[]).includes(p.stage)) return false
  return centralDay(p.nextStepDue) < centralDay(now)
}
