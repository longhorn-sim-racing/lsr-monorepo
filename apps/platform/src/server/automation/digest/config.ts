import { z } from "zod"

/**
 * The weekly digest's settings (design §11.2), kept on its ScheduledJob ("digest.weekly") as `config`;
 * its day and time are the job's schedule and on/off is the job's `enabled`. Off until an officer sets
 * it up on Jack → Recurring questions. Where it posts outside the console (Discord, Teams) is an admin's
 * call; the room, the day and time and the summary are any officer's. Who saved it last is recorded here
 * and in the audit log.
 */

export const digestConfigSchema = z.object({
  /** The room the full digest goes to */
  roomId: z.string().min(1).max(100).nullable().catch(null),
  /** Jack sums it up in the room, in a reply to the digest (counts toward the automation cap) */
  summary: z.boolean().catch(true),
  /** A Discord channel that gets the counts and links (no items) */
  discordChannelId: z.string().regex(/^\d{17,20}$/).nullable().catch(null),
  /** The Teams channel behind TEAMS_WEBHOOK_URL gets the counts and links (no items) */
  teams: z.boolean().catch(false),
  configuredById: z.string().nullable().catch(null),
  /** ISO timestamp */
  configuredAt: z.string().nullable().catch(null),
})

export type DigestConfig = z.infer<typeof digestConfigSchema>

export const EMPTY_DIGEST_CONFIG: DigestConfig = { roomId: null, summary: true, discordChannelId: null, teams: false, configuredById: null, configuredAt: null }

/** The settings as saved, with anything missing or unreadable at its default */
export function readDigestConfig(raw: unknown): DigestConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_DIGEST_CONFIG }
  const parsed = digestConfigSchema.safeParse(raw)
  return parsed.success ? parsed.data : { ...EMPTY_DIGEST_CONFIG }
}
