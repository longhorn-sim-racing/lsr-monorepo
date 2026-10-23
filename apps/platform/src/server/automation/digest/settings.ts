import type { Prisma, ScheduledJob } from "@prisma/client"
import { z } from "zod"
import { cronFor, DIGEST_DEFAULT_SCHEDULE, DIGEST_JOB_KEY, scheduleFromCron, WEEKDAYS, type DigestSettingsInput, type Weekday } from "@/lib/jack/recurring"
import { createAuditLog } from "@/server/audit/log"
import { prisma } from "@/server/db"
import { postingChannels } from "@/server/discord-post/channels"
import { nextRunAfter } from "@/server/scheduler/schedule"
import { readDigestConfig, type DigestConfig } from "./config"

/**
 * Reading and saving the weekly digest's settings (design §11.2). The job row ("digest.weekly") holds
 * them: its config, its schedule (one day a week at one time, Central) and whether it's on. Any officer
 * sets the room, the day and time, the summary and on/off; only an admin changes where it posts outside
 * the console (Discord, Teams), like the other standing posts, and Discord only to a posting channel. A
 * saved channel that stops being one is kept (so officers can still save the rest), and the run refuses
 * it. Each save records who made it (config and the job's updatedById) and is audited.
 */

export type { DigestSettingsInput }

const inputSchema = z.object({
  enabled: z.boolean(),
  roomId: z.string().trim().max(100),
  day: z.enum(WEEKDAYS),
  time: z.string().trim(),
  summary: z.boolean(),
  discordChannelId: z.string().trim().max(25),
  teams: z.boolean(),
})

export type DigestJob = { job: ScheduledJob; config: DigestConfig; day: Weekday; time: string }

/** The digest's job row, made (off, on its default schedule) when it isn't there yet */
export async function loadDigestJob(now = new Date()): Promise<DigestJob> {
  const job =
    (await prisma.scheduledJob.findUnique({ where: { key: DIGEST_JOB_KEY } })) ??
    (await prisma.scheduledJob.upsert({
      where: { key: DIGEST_JOB_KEY },
      create: { key: DIGEST_JOB_KEY, kind: DIGEST_JOB_KEY, schedule: DIGEST_DEFAULT_SCHEDULE, enabled: false, nextRunAt: nextRunAfter(DIGEST_DEFAULT_SCHEDULE, now) },
      update: {},
    }))
  const schedule = scheduleFromCron(job.schedule)
  const day = schedule?.every === "week" && schedule.days?.length === 1 ? schedule.days[0] : "mon"
  return { job, config: readDigestConfig(job.config), day, time: schedule?.time ?? "09:00" }
}

export type SaveDigestResult = { ok: true; changed: string[] } | { ok: false; error: string }

/**
 * A Discord channel the digest may post in: one of the posting channels admins pick on Community →
 * Announcements (text and announcement channels the sync still knows), like every post the bot makes.
 * The send checks it again (discord.ts)
 */
async function discordChannelProblem(id: string): Promise<string | null> {
  if ((await postingChannels()).some((channel) => channel.id === id)) return null
  return "Pick one of the Discord posting channels for the digest. An admin adds a channel to them on Community → Announcements."
}

export async function saveDigestSettings(raw: DigestSettingsInput, actor: { userId: string; isAdmin: boolean }, now = new Date()): Promise<SaveDigestResult> {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: "Check the digest's settings and try again." }
  const input = parsed.data
  const { job, config } = await loadDigestJob(now)

  let schedule: string
  try {
    schedule = cronFor({ every: "week", days: [input.day], time: input.time })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Pick a day and a time." }
  }
  const roomId = input.roomId || null
  const discordChannelId = input.discordChannelId || null
  if (input.enabled && !roomId) return { ok: false, error: "Pick the room the digest goes to before turning it on." }
  if (roomId) {
    const room = await prisma.jackRoom.findUnique({ where: { id: roomId }, select: { archivedAt: true } })
    if (!room) return { ok: false, error: "That room doesn't exist (it may have been deleted)." }
    if (room.archivedAt) return { ok: false, error: "That room is archived. Unarchive it first, or pick another room." }
  }
  const outside = discordChannelId !== config.discordChannelId || input.teams !== config.teams
  if (outside && !actor.isAdmin) return { ok: false, error: "Only admins can change where the digest posts outside the console (Discord and Teams)." }
  if (discordChannelId && discordChannelId !== config.discordChannelId) {
    const problem = await discordChannelProblem(discordChannelId)
    if (problem) return { ok: false, error: problem }
  }

  const next: DigestConfig = { roomId, summary: input.summary, discordChannelId, teams: input.teams, configuredById: actor.userId, configuredAt: now.toISOString() }
  const changed = [
    ...(["roomId", "summary", "discordChannelId", "teams"] as const).filter((key) => next[key] !== config[key]),
    ...(schedule !== job.schedule ? ["schedule"] : []),
    ...(input.enabled !== job.enabled ? ["enabled"] : []),
  ]
  // Saving with nothing changed still records who looked after it last (taking it over keeps the summary going)
  const nextRunAt = input.enabled && (!job.enabled || schedule !== job.schedule) ? nextRunAfter(schedule, now) : job.nextRunAt
  await prisma.scheduledJob.update({
    where: { id: job.id },
    data: { config: next as unknown as Prisma.InputJsonValue, schedule, enabled: input.enabled, nextRunAt, updatedById: actor.userId },
  })
  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "DIGEST_CONFIGURED",
    entityType: "SCHEDULED_JOB",
    entityId: job.id,
    summary: `Saved the weekly digest's settings${changed.length ? ` (${changed.join(", ")})` : ""}${input.enabled !== job.enabled ? (input.enabled ? ", turned it on" : ", turned it off") : ""}`,
    before: { ...config, schedule: job.schedule, enabled: job.enabled },
    after: { ...next, schedule, enabled: input.enabled },
    metadata: { key: job.key, changed },
  })
  return { ok: true, changed }
}
