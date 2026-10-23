import { Prisma } from "@prisma/client"
import { fromZonedTime } from "date-fns-tz"
import { isFeedbackRating, type JackFeedbackRating } from "@/lib/jack/feedback"
import type { JackPersonaKey } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { roundUsd } from "./cost"
import { EVAL_ROOM_PREFIX } from "./eval-support"
import { REPLY_TRIGGERS } from "./reply-triggers"
import { jackMonthlyBudgetUsd } from "./spend"

/**
 * The Usage page (Jack → Usage, design §10 and §13): what Jack cost by month, by persona, and by officer
 * and automation; how officers rated his replies; and what officers ask him first. Officers only. The
 * totals add up exactly what the spend meter does (spend.ts): the cost saved on each reply plus the
 * side jobs in JackUsage, by Central Time month.
 */

const TZ = "America/Chicago"
const PERSONAS: JackPersonaKey[] = ["jack", "lift", "stand"]

// ---------------------------------------------------------------------------
// months
// ---------------------------------------------------------------------------

/** A calendar month in Central Time: its key ("2026-10"), name ("October 2026") and [start, end) as instants */
export type UsageMonth = { key: string; label: string; start: Date; end: Date }

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/

/** The Central Time month an instant falls in, as "2026-10" */
export function monthKeyOf(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit" }).formatToParts(date)
  return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`
}

export function monthFromKey(key: string): UsageMonth | null {
  const match = MONTH_KEY.exec(key)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`
  const start = fromZonedTime(`${key}-01T00:00:00`, TZ)
  return { key, label: new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "long", year: "numeric" }).format(start), start, end: fromZonedTime(`${next}-01T00:00:00`, TZ) }
}

/** The month the page shows: `?month=` when it's a real month that has started, else this month */
export function usageMonth(raw: string | string[] | undefined, now = new Date()): UsageMonth {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ""
  const current = monthKeyOf(now)
  return monthFromKey(MONTH_KEY.test(value) && value <= current ? value : current)!
}

/** `count` months ending with `last`, newest first */
export function monthsBack(last: UsageMonth, count: number): UsageMonth[] {
  const months = [last]
  while (months.length < count) {
    const previous = months[months.length - 1]
    months.push(monthFromKey(monthKeyOf(new Date(previous.start.getTime() - 1)))!)
  }
  return months
}

// ---------------------------------------------------------------------------
// cost by month
// ---------------------------------------------------------------------------

export type MonthCost = { month: UsageMonth; byPersona: Record<JackPersonaKey, number>; totalUsd: number; replies: number }

type MonthRow = { month: string; persona: string | null; calls: number; cost: number }

/** Adds up month rows (from replies and side jobs) per month and persona; months with nothing come out as zeros */
export function summarizeMonths(months: UsageMonth[], rows: MonthRow[], replyRows: MonthRow[]): MonthCost[] {
  const byKey = new Map(months.map((month) => [month.key, { month, byPersona: { jack: 0, lift: 0, stand: 0 }, totalUsd: 0, replies: 0 } as MonthCost]))
  for (const row of rows) {
    const entry = byKey.get(row.month)
    if (!entry || !PERSONAS.includes(row.persona as JackPersonaKey)) continue
    entry.byPersona[row.persona as JackPersonaKey] += Number(row.cost)
  }
  for (const row of replyRows) {
    const entry = byKey.get(row.month)
    if (entry) entry.replies += Number(row.calls)
  }
  return [...byKey.values()].map((entry) => {
    const byPersona = { jack: roundUsd(entry.byPersona.jack), lift: roundUsd(entry.byPersona.lift), stand: roundUsd(entry.byPersona.stand) }
    return { ...entry, byPersona, totalUsd: roundUsd(byPersona.jack + byPersona.lift + byPersona.stand) }
  })
}

/** The instant as a UTC timestamp, the way Prisma stores DateTime columns (timestamp without time zone) */
const utc = (date: Date) => Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`

/** What Jack cost in each of `months` (newest first), by persona, and how many replies each had */
export async function monthlyCosts(months: UsageMonth[]): Promise<MonthCost[]> {
  if (!months.length) return []
  const from = months[months.length - 1].start
  const to = months[0].end
  const month = Prisma.sql`to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}, 'YYYY-MM')`
  const [replies, sideJobs] = await Promise.all([
    prisma.$queryRaw<MonthRow[]>(Prisma.sql`
      SELECT ${month} AS month, persona::text AS persona, count(*)::int AS calls, coalesce(sum("costUsd"), 0)::float8 AS cost
      FROM "JackMessage"
      WHERE kind = 'assistant' AND "costUsd" IS NOT NULL AND "createdAt" >= ${utc(from)} AND "createdAt" < ${utc(to)}
      GROUP BY 1, 2`),
    prisma.$queryRaw<MonthRow[]>(Prisma.sql`
      SELECT ${month} AS month, persona::text AS persona, count(*)::int AS calls, coalesce(sum("costUsd"), 0)::float8 AS cost
      FROM "JackUsage"
      WHERE "createdAt" >= ${utc(from)} AND "createdAt" < ${utc(to)}
      GROUP BY 1, 2`),
  ])
  return summarizeMonths(months, [...replies, ...sideJobs], replies)
}

// ---------------------------------------------------------------------------
// by officer and automation
// ---------------------------------------------------------------------------

/** The JackUsage job Stand's room naming saves (stand.ts) */
const NAME_ROOM_JOB = "name_room"

export type SpenderKind = "officer" | "automation" | "side_job" | "unlinked"

export type Spender = { key: string; label: string; kind: SpenderKind; calls: number; costUsd: number }

export type ReplyCostRow = {
  costUsd: Prisma.Decimal | number | null
  /** The message that started the reply: the newest one it answers, a scheduled note first */
  answers: { authorUserId: string | null; scheduled: boolean; author: { displayName: string } | null }[]
}

export type SideJobRow = { job: string; persona: string; calls: number; costUsd: number }

/**
 * Who each reply's cost goes to: the officer whose message started it (the reply ran as them), or
 * automation when it answered a scheduled note (a recurring question: no officer asked). Side jobs from
 * JackUsage go by job: Stand naming rooms, and anything else (later automations, such as digest summaries)
 * as automation. Highest cost first.
 */
export function attributeSpend(replies: ReplyCostRow[], sideJobs: SideJobRow[]): Spender[] {
  const out = new Map<string, Spender>()
  const add = (key: string, label: string, kind: SpenderKind, calls: number, cost: number) => {
    const entry = out.get(key) ?? { key, label, kind, calls: 0, costUsd: 0 }
    entry.calls += calls
    entry.costUsd += cost
    out.set(key, entry)
  }
  for (const reply of replies) {
    const cost = Number(reply.costUsd ?? 0)
    const start = reply.answers[0]
    if (!start) add("unlinked", "Replies to no message (older or deleted)", "unlinked", 1, cost)
    else if (start.scheduled) add("automation:recurring", "Recurring questions", "automation", 1, cost)
    else if (start.authorUserId) add(`officer:${start.authorUserId}`, start.author?.displayName ?? "Former officer", "officer", 1, cost)
    else add("officer:former", "Former officers", "officer", 1, cost)
  }
  for (const job of sideJobs) {
    if (job.job === NAME_ROOM_JOB) add("side:name_room", "Naming rooms (Stand)", "side_job", job.calls, job.costUsd)
    else add(`automation:${job.job}`, `Automation: ${job.job}`, "automation", job.calls, job.costUsd)
  }
  return [...out.values()].map((s) => ({ ...s, costUsd: roundUsd(s.costUsd) })).sort((a, b) => b.costUsd - a.costUsd || a.label.localeCompare(b.label))
}

/** The month's spend by who it was for (attributeSpend) */
export async function spendBySource(month: UsageMonth): Promise<Spender[]> {
  const inMonth = { createdAt: { gte: month.start, lt: month.end } }
  const [replies, sideJobs] = await Promise.all([
    prisma.jackMessage.findMany({
      where: { ...inMonth, kind: "assistant", costUsd: { not: null } },
      select: {
        costUsd: true,
        answers: {
          where: { OR: REPLY_TRIGGERS },
          orderBy: [{ scheduled: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { authorUserId: true, scheduled: true, author: { select: { displayName: true } } },
        },
      },
    }),
    prisma.jackUsage.groupBy({ by: ["job", "persona"], where: inMonth, _sum: { costUsd: true }, _count: { _all: true } }),
  ])
  return attributeSpend(
    replies,
    sideJobs.map((group) => ({ job: group.job, persona: group.persona, calls: group._count._all, costUsd: Number(group._sum.costUsd ?? 0) }))
  )
}

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------

export type FeedbackCounts = { up: number; down: number; notes: number }

/** A thumbs-down, with what it was about. One with a note is an eval candidate */
export type ThumbsDown = {
  id: string
  at: Date
  by: string
  note: string | null
  messageId: string
  roomId: string
  roomTitle: string | null
  /** The officer message that started the reply, cut short */
  question: string | null
  /** The reply, cut short */
  reply: string
}

const SNIPPET_CHARS = 280

/** One line of a message, cut short, without the reply's bold and code marks (the room renders them; here they'd show as is) */
function snippet(text: string): string {
  const flat = text.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim()
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat
}

/** How the month's ratings came out, and its thumbs-down (newest first, at most `limit`) */
export async function feedbackForMonth(month: UsageMonth, limit = 50): Promise<{ counts: FeedbackCounts; down: ThumbsDown[] }> {
  const inMonth = { createdAt: { gte: month.start, lt: month.end } }
  const [groups, notes, down] = await Promise.all([
    prisma.jackFeedback.groupBy({ by: ["rating"], where: inMonth, _count: { _all: true } }),
    prisma.jackFeedback.count({ where: { ...inMonth, rating: "down", note: { not: null } } }),
    prisma.jackFeedback.findMany({
      where: { ...inMonth, rating: "down" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        note: true,
        createdAt: true,
        user: { select: { displayName: true } },
        message: {
          select: {
            id: true,
            roomId: true,
            content: true,
            room: { select: { title: true } },
            answers: { where: { OR: REPLY_TRIGGERS }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { content: true } },
          },
        },
      },
    }),
  ])
  const counts: FeedbackCounts = { up: 0, down: 0, notes }
  for (const group of groups) if (isFeedbackRating(group.rating)) counts[group.rating as JackFeedbackRating] = group._count._all
  return {
    counts,
    down: down.map((row) => ({
      id: row.id,
      at: row.createdAt,
      by: row.user.displayName,
      note: row.note?.trim() || null,
      messageId: row.message.id,
      roomId: row.message.roomId,
      roomTitle: row.message.room.title,
      question: row.message.answers[0] ? snippet(row.message.answers[0].content) || null : null,
      reply: snippet(row.message.content),
    })),
  }
}

// ---------------------------------------------------------------------------
// common questions
// ---------------------------------------------------------------------------

/** Words left out of "common questions": the ones nearly every question has, and Jack's own names */
const STOP_WORDS = new Set(
  (
    "a about above after again against all also am an and any are aren't as at be because been before being below between both but by can can't cannot " +
    "could couldn't did didn't do does doesn't doing don't down during each few for from further get gets getting give go going got had hadn't has hasn't " +
    "have haven't having he her here hers herself him himself his how i i'd i'll i'm i've if in into is isn't it it's its itself just know let let's like " +
    "make me more most much my myself need no nor not now of off on once one only or other our ours ourselves out over own please same she should " +
    "shouldn't show so some such tell than thank thanks that that's the their theirs them themselves then there there's these they they're this those " +
    "through to too under until up us use very want was wasn't we we're were weren't what what's when where where's which while who who's whom why " +
    "will with won't would wouldn't yes yet you you're your yours yourself hey hi hello okay ok jack lift stand also could can see find look list many " +
    "pm ct im ve ll re"
  ).split(" ")
)

export type CommonWord = { word: string; rooms: number; examples: { roomId: string; title: string | null; question: string }[] }

/**
 * A simple, honest grouping of what officers ask first: the words that show up in the first message of
 * the most rooms (each room counts a word once). Common words ("the", "what", "please") are left out, and
 * words aren't merged ("event" and "events" count apart). Only words in at least `minRooms` rooms
 */
export function commonWords(rooms: { id: string; title: string | null; question: string }[], { limit = 15, minRooms = 2, examples = 3 } = {}): CommonWord[] {
  const byWord = new Map<string, CommonWord>()
  for (const room of rooms) {
    const words = new Set(
      room.question
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .split(/[^\p{L}\p{N}']+/u)
        .map((word) => word.replace(/^'+|'+$/g, "").replace(/'s$/, ""))
        // Two letters is enough for the club's own words ("GM", "F1")
        .filter((word) => word.length >= 2 && !/^\d+$/.test(word) && !STOP_WORDS.has(word))
    )
    for (const word of words) {
      const entry = byWord.get(word) ?? { word, rooms: 0, examples: [] }
      entry.rooms++
      if (entry.examples.length < examples) entry.examples.push({ roomId: room.id, title: room.title, question: snippet(room.question) })
      byWord.set(word, entry)
    }
  }
  return [...byWord.values()]
    .filter((entry) => entry.rooms >= minRooms)
    .sort((a, b) => b.rooms - a.rooms || a.word.localeCompare(b.word))
    .slice(0, limit)
}

/**
 * The rooms opened in the month (newest first, not the eval's) with each one's first officer message to Jack:
 * in a mention-mode room, the first that mentions him, not what officers said among themselves before it
 */
export async function firstQuestions(month: UsageMonth, limit = 500): Promise<{ id: string; title: string | null; question: string }[]> {
  const rooms = await prisma.jackRoom.findMany({
    where: { createdAt: { gte: month.start, lt: month.end }, NOT: { id: { startsWith: EVAL_ROOM_PREFIX } } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: limit,
    select: { id: true, title: true, messages: { where: { kind: "user", expectsAnswer: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1, select: { content: true } } },
  })
  return rooms.filter((room) => room.messages[0]?.content.trim()).map((room) => ({ id: room.id, title: room.title, question: room.messages[0].content }))
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

export type UsageOverview = {
  month: UsageMonth
  /** Whether `month` is this month (the cap applies to it now) */
  current: boolean
  budgetUsd: number
  months: MonthCost[]
  selected: MonthCost
  spenders: Spender[]
  feedback: { counts: FeedbackCounts; down: ThumbsDown[] }
  rooms: number
  words: CommonWord[]
}

/** Everything the Usage page shows for one month, with the twelve months up to this one */
export async function getUsageOverview(raw: string | string[] | undefined, now = new Date()): Promise<UsageOverview> {
  const month = usageMonth(raw, now)
  const thisMonth = usageMonth(undefined, now)
  const months = monthsBack(thisMonth, 12)
  const [costs, spenders, feedback, questions, selected] = await Promise.all([
    monthlyCosts(months),
    spendBySource(month),
    feedbackForMonth(month),
    firstQuestions(month),
    // A month older than the table's twelve is added up on its own
    months.some((m) => m.key === month.key) ? null : monthlyCosts([month]).then((rows) => rows[0]),
  ])
  return {
    month,
    current: month.key === thisMonth.key,
    budgetUsd: jackMonthlyBudgetUsd(),
    months: costs,
    selected: selected ?? costs.find((c) => c.month.key === month.key)!,
    spenders,
    feedback,
    rooms: questions.length,
    words: commonWords(questions),
  }
}
