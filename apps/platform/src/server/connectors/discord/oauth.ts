import { createHash, randomBytes } from "node:crypto"
import { serviceBaseUrl } from "../base-url"
import type { ConnectorEnv } from "../types"
import { DISCORD_API_URL, DISCORD_TIMEOUT_MS, DISCORD_USER_AGENT } from "./client"

/**
 * Members linking their Discord account (design §12.1 "Linking accounts", research §2): OAuth2
 * `identify` with PKCE S256. The code is exchanged, the account's id read, and the token revoked right
 * away: no Discord token is ever stored. Token and revoke take form bodies only (JSON is rejected) and
 * the app's credentials by HTTP Basic. Errors name the step and status, never the code, a token or the
 * secret.
 */

export const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize"

/** The `iss` Discord adds to the callback (since 2026-10-14) */
export const DISCORD_ISSUER = "https://discord.com"

export class DiscordOAuthError extends Error {
  constructor(
    readonly step: "token" | "user" | "revoke",
    readonly status: number | null,
  ) {
    super(`Discord's ${step === "token" ? "token exchange" : step === "user" ? "account lookup" : "token revoke"} failed${status ? ` (${status})` : ""}`)
    this.name = "DiscordOAuthError"
  }
}

export type DiscordApp = { clientId: string; clientSecret: string }

const base64url = (bytes: Buffer) => bytes.toString("base64url")

/** A PKCE verifier (43 characters) and its S256 challenge */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: pkceChallenge(verifier) }
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest())
}

/** Where the member's browser goes to approve: identify only, PKCE, and our state */
export function discordAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string; env?: ConnectorEnv }): string {
  const url = new URL(serviceBaseUrl("discord", DISCORD_AUTHORIZE_URL, input.env))
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    scope: "identify",
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    // Skips the consent screen when the member already approved the app
    prompt: "none",
  }).toString()
  return url.toString()
}

async function post(step: DiscordOAuthError["step"], path: string, app: DiscordApp, form: Record<string, string>, env?: ConnectorEnv): Promise<Response> {
  const response = await fetch(`${serviceBaseUrl("discord", DISCORD_API_URL, env)}${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": DISCORD_USER_AGENT,
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
  })
  if (!response.ok) throw new DiscordOAuthError(step, response.status)
  return response
}

/** Exchanges the callback's code (with the PKCE verifier) for an access token */
export async function exchangeDiscordCode(app: DiscordApp, input: { code: string; redirectUri: string; codeVerifier: string }, env?: ConnectorEnv): Promise<string> {
  const response = await post("token", "/oauth2/token", app, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier }, env)
  const body = (await response.json().catch(() => null)) as { access_token?: unknown; scope?: unknown } | null
  if (typeof body?.access_token !== "string" || !body.access_token) throw new DiscordOAuthError("token", null)
  return body.access_token
}

/** The account the token belongs to: its id, plus its names for display */
export async function fetchDiscordAccount(accessToken: string, env?: ConnectorEnv): Promise<{ id: string; username: string; globalName: string | null }> {
  const response = await fetch(`${serviceBaseUrl("discord", DISCORD_API_URL, env)}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}`, "user-agent": DISCORD_USER_AGENT },
    signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
  })
  if (!response.ok) throw new DiscordOAuthError("user", response.status)
  const user = (await response.json().catch(() => null)) as { id?: unknown; username?: unknown; global_name?: unknown } | null
  if (typeof user?.id !== "string" || !/^\d{17,20}$/.test(user.id) || typeof user.username !== "string") throw new DiscordOAuthError("user", null)
  return { id: user.id, username: user.username, globalName: typeof user.global_name === "string" ? user.global_name : null }
}

/** Revokes the token, and with it the whole grant (research §2) */
export async function revokeDiscordToken(app: DiscordApp, token: string, env?: ConnectorEnv): Promise<void> {
  await post("revoke", "/oauth2/token/revoke", app, { token, token_type_hint: "access_token" }, env)
}
