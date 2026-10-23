import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import { createAuditLog } from "@/server/audit/log"
import { discordApp, discordConnector, discordRedirectUri } from "@/server/connectors/discord/connector"
import { purgedHash } from "@/server/connectors/discord/metadata"
import { discordAuthorizeUrl, DISCORD_ISSUER, exchangeDiscordCode, fetchDiscordAccount, pkcePair, revokeDiscordToken } from "@/server/connectors/discord/oauth"
import { isSnowflake } from "@/server/connectors/discord/snowflake"
import { prismaDiscordStore, PURGED_SETTING, readPurged } from "@/server/connectors/discord/store"
import { daysBetween, rebuildDailyStats } from "@/server/connectors/discord/sync"

/**
 * Members linking their Discord account (design §12.1 "Linking accounts"), and an admin purging a
 * member's Discord data on request ("Privacy and terms").
 *
 * Linking is OAuth2 `identify` with PKCE S256. The state, the PKCE verifier and who started it travel in
 * a short-lived cookie sealed with AES-256-GCM (so it's both signed and private), keyed from the app's
 * client secret; the callback checks it belongs to the signed-in member and compares the state in
 * constant time. Discord's token is revoked as soon as the account's id is read, and only
 * `User.discordUserId` (plus the username, for display) is kept. Relinking needs an unlink first.
 */

export const LINK_COOKIE = "lsr_discord_link"
/** Where the cookie is sent: only the two OAuth routes */
export const LINK_COOKIE_PATH = "/api/discord/oauth"
/** How long a member has to approve on Discord */
export const LINK_COOKIE_MAX_AGE_S = 600

type LinkCookie = { v: 1; state: string; verifier: string; userId: string; exp: number }

/** The cookie's key: derived from the client secret, so no new secret is needed and a secret rotation voids open attempts */
function cookieKey(clientSecret: string): Buffer {
  return createHmac("sha256", clientSecret).update("lsr:discord-link-cookie:v1").digest()
}

export function sealLinkCookie(payload: Omit<LinkCookie, "v">, clientSecret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", cookieKey(clientSecret), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify({ v: 1, ...payload }), "utf8"), cipher.final()])
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".")
}

/** The cookie's contents, or null when it's missing, tampered with, sealed with another key, or expired */
export function openLinkCookie(value: string | undefined, clientSecret: string, now = Date.now()): LinkCookie | null {
  if (!value) return null
  try {
    const [iv, tag, body] = value.split(".").map((part) => Buffer.from(part, "base64url"))
    if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16) return null
    const decipher = createDecipheriv("aes-256-gcm", cookieKey(clientSecret), iv)
    decipher.setAuthTag(tag)
    const parsed = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) as Partial<LinkCookie>
    if (parsed.v !== 1 || typeof parsed.state !== "string" || typeof parsed.verifier !== "string" || typeof parsed.userId !== "string" || typeof parsed.exp !== "number") return null
    return parsed.exp > now ? (parsed as LinkCookie) : null
  } catch {
    return null
  }
}

/** Constant time whatever the lengths (both sides hashed first) */
function same(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

/** How a link attempt ended, as the profile page explains it (`?discord=`) */
export type LinkOutcome = "linked" | "unlinked" | "already" | "taken" | "cancelled" | "expired" | "failed" | "unavailable"

/** Whether members can link now: the connector is set up and switched on */
export async function discordLinkingAvailable(): Promise<boolean> {
  return Boolean(discordApp()) && (await discordConnector.client()) !== null
}

/** Starts linking for a signed-in member: where to send their browser, and the sealed cookie to set */
export async function startDiscordLink(user: { id: string; discordUserId: string | null }): Promise<{ ok: true; url: string; cookie: string } | { ok: false; outcome: LinkOutcome }> {
  if (user.discordUserId) return { ok: false, outcome: "already" }
  const app = discordApp()
  if (!app || !(await discordLinkingAvailable())) return { ok: false, outcome: "unavailable" }
  const state = randomBytes(24).toString("base64url")
  const { verifier, challenge } = pkcePair()
  const cookie = sealLinkCookie({ state, verifier, userId: user.id, exp: Date.now() + LINK_COOKIE_MAX_AGE_S * 1000 }, app.clientSecret)
  return { ok: true, url: discordAuthorizeUrl({ clientId: app.clientId, redirectUri: discordRedirectUri(), state, codeChallenge: challenge }), cookie }
}

export type CallbackInput = { userId: string; cookie: string | undefined; code: string | null; state: string | null; iss: string | null; error: string | null }

/**
 * Finishes linking: checks the cookie and state, exchanges the code, reads the account's id, revokes the
 * token (always, even when a later step fails) and saves the link
 */
export async function finishDiscordLink(input: CallbackInput): Promise<LinkOutcome> {
  const app = discordApp()
  if (!app) return "unavailable"
  const sealed = openLinkCookie(input.cookie, app.clientSecret)
  if (!sealed || sealed.userId !== input.userId || !input.state || !same(sealed.state, input.state)) return "expired"
  if (input.error) return input.error === "access_denied" ? "cancelled" : "failed"
  if (input.iss && input.iss !== DISCORD_ISSUER) return "failed"
  if (!input.code || !(await discordLinkingAvailable())) return input.code ? "unavailable" : "failed"

  let token: string | null = null
  try {
    token = await exchangeDiscordCode(app, { code: input.code, redirectUri: discordRedirectUri(), codeVerifier: sealed.verifier })
    const account = await fetchDiscordAccount(token)
    return await linkDiscordAccount(input.userId, account)
  } catch (error) {
    console.error("[discord] Linking failed:", error instanceof Error ? error.message : error)
    return "failed"
  } finally {
    if (token) await revokeDiscordToken(app, token).catch((error) => console.error("[discord] Couldn't revoke the linking token:", error instanceof Error ? error.message : error))
  }
}

/** Saves a link: refused when the member already has one or the Discord account is another member's */
export async function linkDiscordAccount(userId: string, account: { id: string; username: string }): Promise<LinkOutcome> {
  if (!isSnowflake(account.id)) return "failed"
  try {
    return await prisma.$transaction(async (tx) => {
      const owner = await tx.user.findUnique({ where: { discordUserId: account.id }, select: { id: true } })
      if (owner) return owner.id === userId ? "already" : "taken"
      const { count } = await tx.user.updateMany({ where: { id: userId, discordUserId: null }, data: { discordUserId: account.id, discordUsername: account.username.slice(0, 64), discordLinkedAt: new Date() } })
      if (!count) return "already"
      await tx.discordMember.updateMany({ where: { id: account.id }, data: { userId } })
      return "linked"
    })
  } catch (error) {
    // Two members finishing with the same Discord account at once: the unique index catches the second
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "taken"
    throw error
  }
}

/** Removes a member's link (from their profile, or before deleting their account). Returns whether there was one */
export async function unlinkDiscord(userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { discordUserId: true } })
    await tx.discordMember.updateMany({ where: { userId }, data: { userId: null } })
    await tx.discordMessage.updateMany({ where: { userId }, data: { userId: null } })
    if (!user?.discordUserId) return false
    await tx.user.update({ where: { id: userId }, data: { discordUserId: null, discordUsername: null, discordLinkedAt: null } })
    return true
  })
}

/** `reference` is the purge's audit entry id: random, so the audit log never says whose data it was */
export type PurgeResult = { messages: number; member: boolean; unlinkedUserId: string | null; reference: string }

/**
 * Deletes everything the club holds about one Discord account, on request (design §12.1): its message
 * metadata, its member row and any member's link to it. It also goes on the do-not-collect list (as a
 * keyed hash, purgedHash; the list's key is made on the first purge), so the sync never stores it again,
 * and the daily counts it was part of are rebuilt where the messages still are. Admins only (the caller
 * checks); audited.
 */
export async function purgeDiscordData(discordUserId: string, actor: { userId: string }): Promise<PurgeResult> {
  if (!isSnowflake(discordUserId)) throw new Error("That isn't a Discord user id.")
  const result = await prisma.$transaction(async (tx) => {
    const span = await tx.discordMessage.aggregate({ where: { authorId: discordUserId }, _min: { createdAt: true }, _max: { createdAt: true } })
    const messages = await tx.discordMessage.deleteMany({ where: { authorId: discordUserId } })
    const member = await tx.discordMember.deleteMany({ where: { id: discordUserId } })
    const linked = await tx.user.findUnique({ where: { discordUserId }, select: { id: true } })
    if (linked) await tx.user.update({ where: { id: linked.id }, data: { discordUserId: null, discordUsername: null, discordLinkedAt: null } })
    const setting = await tx.systemSetting.findUnique({ where: { key: PURGED_SETTING } })
    const purged = readPurged(setting?.value)
    const key = purged.key ?? randomBytes(32).toString("base64url")
    const value = JSON.stringify({ key, authors: [...new Set([...purged.authors, purgedHash(key, discordUserId)])] })
    await tx.systemSetting.upsert({ where: { key: PURGED_SETTING }, update: { value }, create: { key: PURGED_SETTING, value } })
    return { messages: messages.count, member: member.count > 0, unlinkedUserId: linked?.id ?? null, span }
  })
  if (result.span._min.createdAt && result.span._max.createdAt) await rebuildDailyStats(prismaDiscordStore, daysBetween(result.span._min.createdAt, result.span._max.createdAt))
  // Neither the Discord id nor its hash: the audit log mustn't let anyone tell whose data was deleted
  const reference = randomBytes(8).toString("hex")
  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "PURGE",
    entityType: "DISCORD_MEMBER",
    entityId: reference,
    targetUserId: result.unlinkedUserId ?? undefined,
    summary: `Purged a member's Discord data on request: ${result.messages} message records${result.member ? ", their member record" : ""}${result.unlinkedUserId ? " and their account link" : ""}`,
    metadata: { messages: result.messages, member: result.member, unlinked: Boolean(result.unlinkedUserId) },
  })
  return { messages: result.messages, member: result.member, unlinkedUserId: result.unlinkedUserId, reference }
}
