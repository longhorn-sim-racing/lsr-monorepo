import { InstagramApiError, refreshToken } from "@/lib/instagram"
import { redactSecrets } from "@/lib/redact"
import { prisma } from "@/server/db"

/**
 * The publishing token (#188, design §3.2 and §12.6) in SystemSetting "instagram_publish", apart from
 * the feed's read token ("instagram"): it comes from a second Meta app with
 * instagram_business_content_publish, so the read token can never publish. An admin pastes it on
 * Content → Instagram (publish-actions.ts); the weekly job renews it. SystemSetting is revoked from
 * Jack's SQL role, and the token never goes to a page, a log, an audit entry or the model: only the
 * server-side publish flow reads it, through `readPublishAccess()`.
 */

export const PUBLISH_SETTING = "instagram_publish"

const DAY = 86_400_000
/** Meta refreshes a token at least a day old; renewing weekly keeps it far from its 60 days */
export const PUBLISH_REFRESH_AFTER_MS = 6 * DAY
const TOKEN_LIFE_MS = 60 * DAY

type PublishSettings = {
  token?: string
  /** The professional account (IG_ID) the token belongs to, from /me when it was pasted */
  userId?: string
  username?: string
  connectedAt?: string
  connectedById?: string
  tokenRefreshedAt?: string
  tokenExpiresAt?: string
  /** Why the last renewal failed (redacted), until one works */
  refreshError?: string | null
  refreshErrorAt?: string | null
}

/** The token and its account, for the publish flow only */
export type PublishAccess = { token: string; userId: string | null; username: string | null; tokenRefreshedAt: string | null; tokenExpiresAt: string | null }

/** What pages may show: never the token */
export type PublishAccount = Omit<PublishSettings, "token"> & { connected: boolean }

async function readRow(): Promise<{ value: string; settings: PublishSettings } | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: PUBLISH_SETTING } })
  if (!row) return null
  try {
    return { value: row.value, settings: JSON.parse(row.value) as PublishSettings }
  } catch {
    return { value: row.value, settings: {} }
  }
}

export async function readPublishAccess(): Promise<PublishAccess | null> {
  const settings = (await readRow())?.settings
  if (!settings?.token) return null
  return { token: settings.token, userId: settings.userId ?? null, username: settings.username ?? null, tokenRefreshedAt: settings.tokenRefreshedAt ?? null, tokenExpiresAt: settings.tokenExpiresAt ?? null }
}

export async function publishAccount(): Promise<PublishAccount> {
  const { token, ...rest } = (await readRow())?.settings ?? {}
  return { ...rest, connected: Boolean(token) }
}

/** Stores a token an admin pasted (already checked against Instagram by the caller) */
export async function savePublishToken(input: { token: string; userId: string; username: string; connectedById: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date()
  const settings: PublishSettings = {
    token: input.token,
    userId: input.userId,
    username: input.username,
    connectedAt: now.toISOString(),
    connectedById: input.connectedById,
    // Tokens generated in the Meta dashboard are long-lived (60 days) from the start
    tokenRefreshedAt: now.toISOString(),
    tokenExpiresAt: new Date(now.getTime() + TOKEN_LIFE_MS).toISOString(),
    refreshError: null,
    refreshErrorAt: null,
  }
  const value = JSON.stringify(settings)
  await prisma.systemSetting.upsert({ where: { key: PUBLISH_SETTING }, update: { value }, create: { key: PUBLISH_SETTING, value } })
}

/** Forgets the token (what it posted stays on Instagram and in the history) */
export async function forgetPublishToken(): Promise<void> {
  await prisma.systemSetting.deleteMany({ where: { key: PUBLISH_SETTING } })
}

/**
 * Writes new settings only if the row still holds what was read (compare and swap), so a token an admin
 * pasted while a renewal ran isn't overwritten with the renewal's
 */
async function swap(before: string, settings: PublishSettings): Promise<boolean> {
  const { count } = await prisma.systemSetting.updateMany({ where: { key: PUBLISH_SETTING, value: before }, data: { value: JSON.stringify(settings) } })
  return count > 0
}

export type RefreshOutcome = { status: "refreshed"; expiresAt: string } | { status: "not-due"; refreshedAt: string } | { status: "none" } | { status: "replaced" }

/**
 * Renews the token when it's due (6 days since it was pasted or last renewed): Meta's
 * refresh_access_token gives a new one good for 60 days, which is stored in place of the old. A refusal
 * is kept on the setting (redacted) for the pages and thrown; an expired token can't be renewed, and an
 * admin pastes a new one.
 */
export async function refreshPublishToken({ now = new Date(), force = false }: { now?: Date; force?: boolean } = {}): Promise<RefreshOutcome> {
  const row = await readRow()
  const settings = row?.settings
  if (!row || !settings?.token) return { status: "none" }
  const refreshedAt = settings.tokenRefreshedAt ? new Date(settings.tokenRefreshedAt).getTime() : 0
  if (!force && now.getTime() - refreshedAt < PUBLISH_REFRESH_AFTER_MS) return { status: "not-due", refreshedAt: settings.tokenRefreshedAt ?? "" }

  try {
    const fresh = await refreshToken(settings.token)
    const expiresAt = new Date(now.getTime() + (fresh.expires_in > 0 ? fresh.expires_in * 1000 : TOKEN_LIFE_MS)).toISOString()
    const stored = await swap(row.value, { ...settings, token: fresh.access_token, tokenRefreshedAt: now.toISOString(), tokenExpiresAt: expiresAt, refreshError: null, refreshErrorAt: null })
    return stored ? { status: "refreshed", expiresAt } : { status: "replaced" }
  } catch (error) {
    const reason =
      error instanceof InstagramApiError && error.expiredToken
        ? "Instagram says the publishing token has expired or was revoked: an admin pastes a new one on Content → Instagram"
        : `Couldn't renew the publishing token: ${error instanceof Error ? error.message : String(error)}`
    const text = redactSecrets(reason).slice(0, 500)
    await swap(row.value, { ...settings, refreshError: text, refreshErrorAt: now.toISOString() })
    throw new Error(text)
  }
}
