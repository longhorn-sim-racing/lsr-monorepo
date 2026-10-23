import { prisma } from "@/server/db"
import { redactSecrets } from "@/lib/redact"
import { TwitchApiError, type TwitchApi, type TwitchTokenGrant } from "./client"

/**
 * Twitch's tokens (#188, design §3.2 and §12.2), in SystemSetting "twitch" (revoked from Jack's SQL
 * role; never shown, logged or audited):
 * - the app access token (client credentials), cached so each call doesn't mint one;
 * - the club account's grant: a user access token (about 4 hours) and its refresh token, which Twitch may
 *   rotate on every refresh and which backs at most 50 live access tokens. So every write happens under
 *   a row lock (SELECT … FOR UPDATE), and a refresh re-reads the row first: whoever waited for the lock
 *   uses the token the refresh before it stored instead of refreshing again.
 * When Twitch refuses the refresh token (a password change, the app disconnected), the grant is kept
 * but marked `reconnect`, and an admin connects the club account again on Content → Streams. The same
 * setting remembers EventSub subscriptions Twitch revoked (`eventsubRevoked`) until they work again.
 * Every function here takes the setting's key, only so the local DB check can use a throwaway row.
 */

export const TWITCH_SETTING_KEY = "twitch"

/** Refresh or re-mint a token this long before it runs out */
const EXPIRY_MARGIN_MS = 5 * 60_000

export type TwitchClubGrant = {
  accessToken: string
  refreshToken: string
  /** ISO time the access token runs out */
  expiresAt: string
  login: string
  userId: string
  scopes: string[]
  connectedAt: string
  connectedById: string | null
  /** Last time /oauth2/validate accepted it (Twitch wants that hourly) */
  validatedAt?: string
  refreshedAt?: string
}

export type TwitchSettings = {
  app?: { accessToken: string; expiresAt: string }
  user?: TwitchClubGrant
  /** Twitch refused the club account's refresh token: it has to be connected again. Redacted */
  reconnect?: { reason: string; at: string }
  /** Webhook subscriptions Twitch revoked, one per type; cleared when that type's challenge or a notification arrives again */
  eventsubRevoked?: EventSubRevoked[]
}

/** A revoked EventSub subscription: its type, Twitch's reason (`status`) and when */
export type EventSubRevoked = { type: string; status: string; at: string }

/** What pages show about the club account and the webhooks: never a token */
export type TwitchAccountView = {
  connected: boolean
  login: string | null
  scopes: string[]
  connectedAt: string | null
  validatedAt: string | null
  refreshedAt: string | null
  reconnect: { reason: string; at: string } | null
  /** Webhook subscriptions Twitch revoked: run scripts/twitch-eventsub.ts --apply again */
  webhooksRevoked: EventSubRevoked[]
}

/** Thrown when the club account's grant is missing or refused: nothing works with user tokens until an admin connects it again */
export class TwitchReconnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TwitchReconnectError"
  }
}

export function parseTwitchSettings(value: string | null | undefined): TwitchSettings {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as TwitchSettings) : {}
  } catch {
    return {}
  }
}

export async function readTwitchSettings(key = TWITCH_SETTING_KEY): Promise<TwitchSettings> {
  const row = await prisma.systemSetting.findUnique({ where: { key } })
  return parseTwitchSettings(row?.value)
}

export function twitchAccountView(settings: TwitchSettings): TwitchAccountView {
  const user = settings.user
  return {
    connected: Boolean(user?.refreshToken),
    login: user?.login ?? null,
    scopes: user?.scopes ?? [],
    connectedAt: user?.connectedAt ?? null,
    validatedAt: user?.validatedAt ?? null,
    refreshedAt: user?.refreshedAt ?? null,
    reconnect: settings.reconnect ?? null,
    webhooksRevoked: Array.isArray(settings.eventsubRevoked) ? settings.eventsubRevoked : [],
  }
}

export async function twitchAccount(): Promise<TwitchAccountView> {
  return twitchAccountView(await readTwitchSettings())
}

/**
 * Reads the setting under a row lock, lets `change` decide, and writes what it returns as `next`. The
 * lock is held for `change`'s whole run, Twitch calls included (a refresh), so keep those short: the
 * client's own timeout bounds them. Return a result instead of throwing when the write must still happen.
 */
export async function withTwitchSettings<R>(change: (current: TwitchSettings) => Promise<{ next?: TwitchSettings; result: R }>, key = TWITCH_SETTING_KEY): Promise<R> {
  await prisma.$executeRaw`INSERT INTO "SystemSetting" ("key", "value", "updatedAt") VALUES (${key}, '{}', now()) ON CONFLICT ("key") DO NOTHING`
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ value: string }[]>`SELECT "value" FROM "SystemSetting" WHERE "key" = ${key} FOR UPDATE`
      const { next, result } = await change(parseTwitchSettings(rows[0]?.value))
      if (next) await tx.systemSetting.update({ where: { key }, data: { value: JSON.stringify(next) } })
      return result
    },
    { maxWait: 15_000, timeout: 40_000 },
  )
}

/** Remembers that Twitch revoked a webhook subscription (one entry per type, the newest kept) */
export async function recordEventSubRevoked(revoked: EventSubRevoked, key = TWITCH_SETTING_KEY): Promise<void> {
  await withTwitchSettings(async (current) => {
    const others = (current.eventsubRevoked ?? []).filter((r) => r.type !== revoked.type)
    return { next: { ...current, eventsubRevoked: [...others, revoked] }, result: undefined }
  }, key)
}

/** Forgets a revoked subscription of `type` once Twitch delivers to it again (its challenge, or a notification). Reads before locking, so the usual call writes nothing */
export async function clearEventSubRevoked(type: string, key = TWITCH_SETTING_KEY): Promise<boolean> {
  if (!(await readTwitchSettings(key)).eventsubRevoked?.some((r) => r.type === type)) return false
  return withTwitchSettings(async (current) => {
    const rest = (current.eventsubRevoked ?? []).filter((r) => r.type !== type)
    if (rest.length === (current.eventsubRevoked ?? []).length) return { result: false }
    const next: TwitchSettings = { ...current, eventsubRevoked: rest }
    if (!rest.length) delete next.eventsubRevoked
    return { next, result: true }
  }, key)
}

const fresh = (expiresAt: string | undefined, now: number) => Boolean(expiresAt && Date.parse(expiresAt) - EXPIRY_MARGIN_MS > now)
const expiry = (grant: TwitchTokenGrant, now: number) => new Date(now + grant.expires_in * 1000).toISOString()

/**
 * Where a Twitch client gets its tokens. `failed` is a token Twitch just answered 401 to: the source
 * hands back a newer one (minted or refreshed), never the same one again
 */
export type TwitchTokenSource = {
  app(api: TwitchApi, options?: { failed?: string; signal?: AbortSignal }): Promise<string>
  user(api: TwitchApi, options?: { failed?: string; signal?: AbortSignal }): Promise<string>
  /** Records that /oauth2/validate accepted the user token */
  validated?(at: Date): Promise<void>
}

/** Whether Twitch refused a refresh token for good (it's invalid or revoked), rather than failing for a while */
const refusedRefresh = (error: unknown) => error instanceof TwitchApiError && (error.status === 400 || error.status === 401)

/** The tokens in SystemSetting "twitch" (`key`), the app's single store */
export const settingsTwitchTokensFor = (key = TWITCH_SETTING_KEY): TwitchTokenSource => ({
  async app(api, { failed, signal } = {}) {
    const cached = (await readTwitchSettings(key)).app
    if (cached && cached.accessToken !== failed && fresh(cached.expiresAt, Date.now())) return cached.accessToken
    return withTwitchSettings(async (current) => {
      const now = Date.now()
      // Another call may have minted one while this one waited for the lock
      if (current.app && current.app.accessToken !== failed && fresh(current.app.expiresAt, now)) return { result: current.app.accessToken }
      const grant = await api.mintAppToken(signal)
      return { next: { ...current, app: { accessToken: grant.access_token, expiresAt: expiry(grant, now) } }, result: grant.access_token }
    }, key)
  },

  async user(api, { failed, signal } = {}) {
    const settings = await readTwitchSettings(key)
    if (!settings.user) throw new TwitchReconnectError("The club's Twitch account isn't connected: an admin connects it on Content → Streams.")
    if (settings.reconnect) throw new TwitchReconnectError(`The club's Twitch account has to be connected again on Content → Streams: ${settings.reconnect.reason}`)
    if (settings.user.accessToken !== failed && fresh(settings.user.expiresAt, Date.now())) return settings.user.accessToken

    const outcome = await withTwitchSettings<{ token: string } | { refused: string }>(async (current) => {
      const now = Date.now()
      const user = current.user
      if (!user) return { result: { refused: "the club account was disconnected" } }
      if (current.reconnect) return { result: { refused: current.reconnect.reason } }
      // A refresh that finished while this call waited for the lock already stored a newer token
      if (user.accessToken !== failed && fresh(user.expiresAt, now)) return { result: { token: user.accessToken } }
      try {
        const grant = await api.refreshUserToken(user.refreshToken, signal)
        const next: TwitchClubGrant = {
          ...user,
          accessToken: grant.access_token,
          refreshToken: grant.refresh_token ?? user.refreshToken,
          expiresAt: expiry(grant, now),
          scopes: grant.scope ?? user.scopes,
          refreshedAt: new Date(now).toISOString(),
        }
        return { next: { ...current, user: next }, result: { token: grant.access_token } }
      } catch (error) {
        if (!refusedRefresh(error)) throw error
        // Kept, but marked: the write must land, so this returns instead of throwing (that would roll it back)
        const reason = redactSecrets(error instanceof Error ? error.message : String(error), { maxLength: 300 })
        return { next: { ...current, reconnect: { reason, at: new Date(now).toISOString() } }, result: { refused: reason } }
      }
    }, key)
    if ("refused" in outcome) throw new TwitchReconnectError(`Twitch refused the club account's refresh token, so it has to be connected again on Content → Streams (${outcome.refused}).`)
    return outcome.token
  },

  async validated(at) {
    await withTwitchSettings(async (current) => (current.user ? { next: { ...current, user: { ...current.user, validatedAt: at.toISOString() } }, result: undefined } : { result: undefined }), key)
  },
})

export const settingsTwitchTokens: TwitchTokenSource = settingsTwitchTokensFor()

/** Saves the club account's grant after the connect flow; clears any reconnect mark */
export async function saveTwitchClubGrant(grant: Omit<TwitchClubGrant, "refreshedAt">): Promise<void> {
  await withTwitchSettings(async (current) => {
    const next: TwitchSettings = { ...current, user: grant }
    delete next.reconnect
    return { next, result: undefined }
  })
}

/** Forgets the club account's grant, returning its tokens so the caller can revoke them at Twitch */
export async function forgetTwitchClubGrant(): Promise<{ accessToken: string; refreshToken: string } | null> {
  return withTwitchSettings(async (current) => {
    const next: TwitchSettings = { ...current }
    delete next.user
    delete next.reconnect
    const user = current.user
    return { next, result: user ? { accessToken: user.accessToken, refreshToken: user.refreshToken } : null }
  })
}

/**
 * Tokens kept in memory, for scripts that must not touch the database's settings (the eval seeder) and
 * for tests. Starts with a refresh token when given one
 */
export function memoryTwitchTokens(start: { refreshToken?: string } = {}): TwitchTokenSource {
  let app: { token: string; expiresAt: number } | null = null
  let user: { token: string; expiresAt: number; refreshToken: string } | null = start.refreshToken ? { token: "", expiresAt: 0, refreshToken: start.refreshToken } : null
  return {
    async app(api, { failed, signal } = {}) {
      if (app && app.token !== failed && app.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return app.token
      const grant = await api.mintAppToken(signal)
      app = { token: grant.access_token, expiresAt: Date.now() + grant.expires_in * 1000 }
      return app.token
    },
    async user(api, { failed, signal } = {}) {
      if (!user) throw new TwitchReconnectError("No Twitch user token in this run.")
      if (user.token && user.token !== failed && user.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return user.token
      const grant = await api.refreshUserToken(user.refreshToken, signal)
      user = { token: grant.access_token, expiresAt: Date.now() + grant.expires_in * 1000, refreshToken: grant.refresh_token ?? user.refreshToken }
      return user.token
    },
  }
}
