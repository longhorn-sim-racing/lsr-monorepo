import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { getSiteUrl } from "@/lib/site-url"

/**
 * The club account's one-time grant (#188, design §12.2): an admin presses Connect on Content → Streams,
 * signs in to Twitch as the club account and approves `moderator:read:followers`; Twitch sends the
 * browser back to the callback with a code. The `state` that goes to Twitch is random, and the browser
 * keeps it in a short-lived httpOnly cookie, MAC'd with TWITCH_CLIENT_SECRET together with the admin's
 * user id and an expiry. So the callback only takes a code from the same browser, the same admin, within
 * ten minutes (no login CSRF, no replay from another session).
 */

export const TWITCH_OAUTH_COOKIE = "lsr_twitch_oauth"
export const TWITCH_CONNECT_PATH = "/api/admin/twitch/connect"
export const TWITCH_CALLBACK_PATH = "/api/admin/twitch/callback"
/** The cookie only goes to the two routes */
export const TWITCH_OAUTH_COOKIE_PATH = "/api/admin/twitch"
export const TWITCH_OAUTH_TTL_MS = 10 * 60_000

/** The callback Twitch sends the browser back to; registered in the Twitch app exactly */
export function twitchRedirectUri(): string {
  return `${getSiteUrl()}${TWITCH_CALLBACK_PATH}`
}

const mac = (secret: string, state: string, userId: string, expires: number) =>
  createHmac("sha256", secret).update(`twitch-oauth.${state}.${userId}.${expires}`, "utf8").digest("base64url")

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest()
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))

/** A new state for Twitch, and the cookie that binds it to this admin */
export function createTwitchOAuthState(secret: string, userId: string, nowMs = Date.now()): { state: string; cookie: string } {
  const state = randomBytes(24).toString("base64url")
  const expires = nowMs + TWITCH_OAUTH_TTL_MS
  return { state, cookie: `${state}.${expires}.${mac(secret, state, userId, expires)}` }
}

export type TwitchOAuthStateCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" }

/** Whether the state Twitch sent back is the one this admin's cookie holds, unexpired */
export function checkTwitchOAuthState({ cookie, state, userId, secret, nowMs = Date.now() }: { cookie: string | undefined; state: string | null; userId: string; secret: string; nowMs?: number }): TwitchOAuthStateCheck {
  if (!cookie || !state) return { ok: false, reason: "missing" }
  const parts = cookie.split(".")
  if (parts.length !== 3) return { ok: false, reason: "malformed" }
  const [saved, expiresText, signature] = parts
  const expires = Number(expiresText)
  if (!Number.isFinite(expires)) return { ok: false, reason: "malformed" }
  // Every comparison runs, so timing doesn't say which part failed
  const signed = same(signature, mac(secret, saved, userId, expires))
  const matches = same(saved, state)
  if (!signed || !matches) return { ok: false, reason: "mismatch" }
  if (expires <= nowMs) return { ok: false, reason: "expired" }
  return { ok: true }
}

/** What the Streams page says after the callback, by code: the URL carries only the code, never text from Twitch */
export const TWITCH_CONNECT_RESULTS = {
  connected: { tone: "success", text: "Connected the club's Twitch account." },
  denied: { tone: "warning", text: "Twitch access wasn't granted, so nothing changed." },
  "wrong-account": { tone: "danger", text: "That Twitch account isn't the club channel (TWITCH_BROADCASTER_ID). Sign out of Twitch, sign in as the club account, and connect again." },
  "missing-scope": { tone: "danger", text: "Twitch didn't grant the follower permission (moderator:read:followers). Connect again and approve it." },
  expired: { tone: "warning", text: "The connect link expired or was opened in another browser. Press Connect again." },
  "not-configured": { tone: "danger", text: "Twitch isn't set up: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET and TWITCH_BROADCASTER_ID are needed (System → Connections)." },
  failed: { tone: "danger", text: "Twitch didn't accept the sign-in. Try again in a minute; System → Connections shows the error." },
} as const

export type TwitchConnectResult = keyof typeof TWITCH_CONNECT_RESULTS
