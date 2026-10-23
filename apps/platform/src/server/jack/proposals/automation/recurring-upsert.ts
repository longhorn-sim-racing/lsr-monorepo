import { revalidatePath } from "next/cache"
import { z } from "zod"
import { cronFor, RECURRING_PAGE, RECURRING_PERSONAS, recurringJobKey, recurringQuestionPath, scheduleFromCron, type RecurringPersona, type RecurringSchedule } from "@/lib/jack/recurring"
import { formatUsd } from "@/lib/jack/spend"
import { JACK_PERSONA_NAME, jackRoomTitle } from "@/lib/jack/types"
import { recurringPromptSchema, recurringScheduleSchema, recurringTitleSchema } from "@/schemas/recurring-question.schema"
import { automationBudgetUsd } from "@/server/automation/cap"
import { estimateLine, estimateOne } from "@/server/automation/recurring/estimate"
import {
  createRecurringQuestionTx,
  RECURRING_PATHS,
  roomProblem,
  setRecurringQuestionOnTx,
  snapshotOf,
  TAKES_OVER,
  updateRecurringQuestionTx,
  type RecurringSnapshot,
  type RecurringWriteResult,
} from "@/server/automation/recurring/service"
import { prisma } from "@/server/db"
import { describeSchedule } from "@/server/scheduler/schedule"
import { officerIdSet } from "@/server/services/officers"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalDiffRow, ProposalKind } from "../types"

/**
 * recurring.upsert (design §4.3, automation): set up a recurring question, or change one: its title,
 * question, room, schedule (at most daily), who answers (Jack or Stand) and whether it's on. The card
 * shows the estimated monthly cost. A new question starts off unless the proposal turns it on, and runs
 * as the officer it was proposed for; so does one whose question, room or answerer a proposal changes
 * (the card shows "Asked as" then). Applying goes through the same service as the Recurring questions
 * page; a question that changed since makes it stale.
 */

export const recurringUpsertSchema = z
  .object({
    id: z.string().trim().min(1).max(64).optional().describe("To change a recurring question: its RecurringQuestion id (run_sql). Leave it out to set up a new one"),
    title: recurringTitleSchema.optional().describe("A short name, e.g. Weekly signups"),
    prompt: recurringPromptSchema.optional().describe("The question, as an officer would ask it each time"),
    schedule: recurringScheduleSchema.optional().describe("When it's asked: at most once a day"),
    persona: z.enum(RECURRING_PERSONAS).optional().describe("Who answers: jack (default) or stand (cheaper, for simple counts)"),
    roomId: z.string().trim().min(1).max(100).optional().describe("The room it's asked in; default this room"),
    on: z.boolean().optional().describe("Switch it on or off. A new one starts off unless an officer asked for it to start"),
  })
  .superRefine((p, ctx) => {
    if (p.id) return
    for (const key of ["title", "prompt", "schedule"] as const) if (p[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: `A new recurring question needs a ${key}.` })
  })

export type RecurringUpsertProposal = z.infer<typeof recurringUpsertSchema>

/** What the card and the staleness check keep: the question as it was (an edit), or nothing (a new one) */
const beforeSchema = z.object({ title: z.string(), prompt: z.string(), roomId: z.string(), persona: z.string(), schedule: z.string(), enabled: z.boolean() }).nullable()

const PERSONA_LABEL = (persona: string) => (persona === "jack" || persona === "stand" ? JACK_PERSONA_NAME[persona] : persona)
const when = (cron: string) => describeSchedule(cron) ?? cron
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function revalidateQuietly() {
  for (const path of RECURRING_PATHS) {
    try {
      revalidatePath(path)
    } catch {
      // Outside a request (scripts, the eval): nothing to revalidate
    }
  }
}

async function roomTitle(roomId: string): Promise<string> {
  const room = await prisma.jackRoom.findUnique({ where: { id: roomId }, select: { title: true } })
  return jackRoomTitle({ title: room?.title ?? null })
}

/** A write's refusal, as the framework wants it: stale when the question or its room moved on or went, failed otherwise */
function fail(result: Extract<RecurringWriteResult, { ok: false }>): never {
  if (result.reason === "invalid") throw new Error(result.error)
  throw new StaleProposalError(result.error)
}

/** Who a new question, or a change to what one asks, runs as: the officer it was proposed for while they're still one, else whoever applied it */
async function ownerFor(ctx: { officer: { userId: string }; auditMetadata: { proposedFor: string | null } }): Promise<string> {
  const proposedFor = ctx.auditMetadata.proposedFor
  return proposedFor && (await officerIdSet([proposedFor])).has(proposedFor) ? proposedFor : ctx.officer.userId
}

export const recurringUpsertKind: ProposalKind<RecurringUpsertProposal> = {
  kind: "recurring.upsert",
  tool: "propose_recurring",
  description:
    "recurring.upsert: set up a question Jack is asked on a schedule (at most daily) in a room, answered as the officer it's for, or change one by id (title, question, schedule, room, jack or stand, on or off). The card shows its estimated monthly cost.",
  schema: recurringUpsertSchema,
  targetType: "RECURRING_QUESTION",
  permission: "officer",

  async prepare(p, ctx) {
    if (p.id) {
      const question = await prisma.recurringQuestion.findUnique({ where: { id: p.id }, include: { scheduledJob: true, createdBy: { select: { displayName: true } } } })
      if (!question) throw new ProposalInputError(`There's no recurring question with id ${p.id}. Find ids in RecurringQuestion with run_sql.`)
      const before = snapshotOf(question)
      const after: RecurringSnapshot = {
        title: p.title ?? before.title,
        prompt: p.prompt ?? before.prompt,
        roomId: p.roomId ?? before.roomId,
        persona: p.persona ?? before.persona,
        schedule: p.schedule ? cronFor(p.schedule) : before.schedule,
        enabled: p.on ?? before.enabled,
      }
      if (after.roomId !== before.roomId) {
        const problem = await roomProblem(prisma, after.roomId)
        if (problem) throw new ProposalInputError(problem === "gone" ? `There's no room with id ${after.roomId}.` : "That room is archived; pick another.")
      }
      const rooms = after.roomId === before.roomId ? null : await Promise.all([roomTitle(before.roomId), roomTitle(after.roomId)])
      const show = (field: keyof RecurringSnapshot, value: string | boolean): string =>
        field === "schedule" ? when(String(value)) : field === "persona" ? PERSONA_LABEL(String(value)) : field === "enabled" ? (value ? "On" : "Off") : String(value)
      const fields: [keyof RecurringSnapshot, string, ProposalDiffRow["format"]][] = [
        ["title", "Title", "text"],
        ["prompt", "Question", "markdown"],
        ["schedule", "When", "value"],
        ["persona", "Answered by", "value"],
        ["enabled", "On", "value"],
      ]
      const diff: ProposalDiffRow[] = fields
        .filter(([field]) => before[field] !== after[field])
        .map(([field, label, format]) => ({ field, label, before: show(field, before[field]), after: show(field, after[field]), format }))
      if (rooms) diff.splice(2, 0, { field: "roomId", label: "Room", before: rooms[0], after: rooms[1], format: "text" })
      if (!diff.length) throw new ProposalInputError(`Nothing would change: “${question.title}” already looks like that.`)
      // Changing what it asks, its room or who answers makes the officer it's for its owner (the service does it on apply)
      if (TAKES_OVER.some((field) => before[field as keyof RecurringSnapshot] !== after[field as keyof RecurringSnapshot]) && ctx.officer.userId !== question.createdById) {
        diff.push({ field: "createdById", label: "Asked as", before: question.createdBy?.displayName ?? "a former officer", after: ctx.officer.userId ? ctx.officer.displayName : "the officer who applies it", format: "value" })
      }
      const schedule = scheduleFromCron(after.schedule)
      const estimate = schedule ? await estimateOne({ jobKey: recurringJobKey(question.id), persona: after.persona as RecurringPersona, schedule }) : null
      return {
        before,
        targetId: question.id,
        view: {
          title: `Change the recurring question “${clip(question.title, 60)}”`,
          summary: `Applying it changes what's shown below.${estimate ? ` ${estimateLine(estimate)}, counted toward automations' ${formatUsd(automationBudgetUsd(), { wholeIfRound: true })} a month.` : ""}`,
          diff,
          links: [{ title: question.title, url: recurringQuestionPath(question.id) }],
        },
      }
    }

    const roomId = p.roomId ?? ctx.roomId
    const problem = await roomProblem(prisma, roomId)
    if (problem) throw new ProposalInputError(problem === "gone" ? `There's no room with id ${roomId}.` : "That room is archived; pick another.")
    const persona: RecurringPersona = p.persona ?? "jack"
    const schedule = p.schedule as RecurringSchedule
    const cron = cronFor(schedule)
    const [room, estimate] = await Promise.all([roomTitle(roomId), estimateOne({ jobKey: null, persona, schedule })])
    const owner = ctx.officer.userId ? ctx.officer.displayName : "the officer who applies it"
    const on = p.on ?? false
    return {
      before: null,
      view: {
        title: `Set up the recurring question “${clip(p.title!, 60)}”`,
        summary:
          `Asks it in “${room}” (${when(cron)}), answered by ${JACK_PERSONA_NAME[persona]} as ${owner} with no web search. ` +
          `${estimateLine(estimate)}, counted toward automations' ${formatUsd(automationBudgetUsd(), { wholeIfRound: true })} a month. ` +
          (on ? "It starts on." : "It starts off: turn it on on Jack → Recurring questions."),
        diff: [
          { field: "title", label: "Title", before: null, after: p.title!, format: "text" },
          { field: "prompt", label: "Question", before: null, after: p.prompt!, format: "markdown" },
          { field: "roomId", label: "Room", before: null, after: room, format: "text" },
          { field: "schedule", label: "When", before: null, after: when(cron), format: "value" },
          { field: "persona", label: "Answered by", before: null, after: JACK_PERSONA_NAME[persona], format: "value" },
          { field: "on", label: "On", before: null, after: on ? "On" : "Off", format: "value" },
          { field: "estimate", label: "Estimated cost", before: null, after: `${formatUsd(estimate.monthlyUsd)} a month`, format: "value" },
        ],
        links: [{ title: "Recurring questions", url: RECURRING_PAGE }],
      },
    }
  },

  async checkStale(p, before) {
    if (!p.id) return null
    const was = beforeSchema.safeParse(before)
    if (!was.success || !was.data) return "The proposal's copy of the question is missing. Ask Jack to propose it again."
    const question = await prisma.recurringQuestion.findUnique({ where: { id: p.id }, include: { scheduledJob: true } })
    if (!question) return "The recurring question was deleted since this was proposed."
    const now = snapshotOf(question)
    const moved = (Object.keys(was.data) as (keyof RecurringSnapshot)[]).filter((key) => now[key] !== was.data![key])
    return moved.length ? `“${question.title}” changed since this was proposed (${moved.join(", ")}).` : null
  },

  async apply(p, ctx) {
    const actor = { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata }
    const owner = await ownerFor(ctx)
    if (!p.id) {
      const result = await prisma.$transaction((tx) =>
        createRecurringQuestionTx(tx, { title: p.title, prompt: p.prompt, schedule: p.schedule, persona: p.persona ?? "jack", roomId: p.roomId ?? ctx.roomId }, actor, { createdById: owner, enabled: p.on ?? false }),
      )
      if (!result.ok) fail(result)
      revalidateQuietly()
      const on = result.question.scheduledJob.enabled
      return {
        summary: `Set up the recurring question “${result.question.title}” (${on ? "on" : "off: turn it on on Jack → Recurring questions"}).`,
        links: [{ title: result.question.title, url: recurringQuestionPath(result.question.id) }],
        created: [{ type: "RECURRING_QUESTION", id: result.question.id }],
      }
    }

    const was = beforeSchema.safeParse(ctx.before)
    if (!was.success || !was.data) throw new StaleProposalError("The proposal's copy of the question is missing. Ask Jack to propose it again.")
    const expected = was.data
    const changes = Object.fromEntries(
      (["title", "prompt", "schedule", "persona", "roomId"] as const).filter((key) => p[key] !== undefined).map((key) => [key, p[key]]),
    )
    const result = await prisma.$transaction(async (tx) => {
      // A change to what it asks, its room or who answers makes `owner` its owner (the service decides)
      const updated = await updateRecurringQuestionTx(tx, p.id!, changes, actor, { expected, owner })
      if (!updated.ok || p.on === undefined) return updated
      const switched = await setRecurringQuestionOnTx(tx, p.id!, p.on, actor)
      return switched.ok ? { ...switched, changed: [...updated.changed, ...switched.changed] } : switched
    })
    if (!result.ok) fail(result)
    revalidateQuietly()
    return {
      summary: result.changed.length ? `Changed the recurring question “${result.question.title}”.` : `“${result.question.title}” already looked like that.`,
      links: [{ title: result.question.title, url: recurringQuestionPath(result.question.id) }],
    }
  },
}
