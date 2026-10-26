import { DIGEST_DEFAULT_SCHEDULE, DIGEST_JOB_KEY, RECURRING_JOB_KIND } from "@/lib/jack/recurring"
import { runWeeklyDigest } from "@/server/automation/digest/run"
import { runRecurringQuestion } from "@/server/automation/recurring/run"
import type { JobKind } from "../types"

/** Both run Jack, so each gets its own invocation (the hand-off) with most of its 300 s */
const JACK_RUN_BUDGET_MS = 285_000

/** A recurring question (design §11.1): one job per question, created with it on Jack → Recurring questions */
export const recurringQuestionJob: JobKind = {
  kind: RECURRING_JOB_KIND,
  label: "Recurring question",
  description:
    "Asks one recurring question in its room, as the officer who set it up, and has Jack (or Stand) answer it with a short history and no web tools. Paused when its owner isn't an officer or its room is archived; skipped when automations reach their monthly cap. Set up, changed and switched on Jack → Recurring questions.",
  defaultSchedule: "0 9 * * 1",
  budgetMs: JACK_RUN_BUDGET_MS,
  handoff: true,
  singleton: false,
  run: (ctx) => runRecurringQuestion(ctx),
}

/** The weekly digest (design §11.2) */
export const weeklyDigestJob: JobKind = {
  kind: DIGEST_JOB_KEY,
  label: "Weekly digest",
  description:
    "Runs every “needs attention” check and posts the list to a Jack room (with Jack's short summary when it's on), and counts with links to Discord and Teams when they're set up. Off until an officer sets it up on Jack → Recurring questions.",
  defaultSchedule: DIGEST_DEFAULT_SCHEDULE,
  budgetMs: JACK_RUN_BUDGET_MS,
  handoff: true,
  run: (ctx) => runWeeklyDigest(ctx),
}

/** Scheduled job kinds from the automation track (design §6). The registry joins every track's jobs in a fixed order */
export const JOBS: JobKind[] = [recurringQuestionJob, weeklyDigestJob]
