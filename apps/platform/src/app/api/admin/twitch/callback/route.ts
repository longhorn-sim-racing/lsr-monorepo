import { NextResponse, type NextRequest } from "next/server"
import { requireRole } from "@/server/auth/guards"
import { createAuditLog } from "@/server/audit/log"
import { missingEnv } from "@/server/connectors/define"
import { CONNECTOR_ENTITY, recordConnectorError } from "@/server/connectors/state"
import { TWITCH_SCOPES } from "@/server/connectors/twitch/client"
import { TWITCH_CONNECTOR_ID, twitchAppApi } from "@/server/connectors/twitch/connector"
import { checkTwitchOAuthState, TWITCH_OAUTH_COOKIE, TWITCH_OAUTH_COOKIE_PATH, twitchRedirectUri, type TwitchConnectResult } from "@/server/connectors/twitch/oauth"
import { saveTwitchClubGrant } from "@/server/connectors/twitch/tokens"

/**
 * Where Twitch sends the admin back after the consent page (design §12.2). It checks the state against
 * this admin's cookie, swaps the code for tokens, and keeps them only when they're the club channel's
 * (TWITCH_BROADCASTER_ID) with the follower scope; anything else is revoked at once. The tokens go to
 * SystemSetting "twitch" and nowhere else; the audit entry names the account, never a token. The page
 * it returns to learns only a result code.
 */

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  let userId: string
  try {
    userId = (await requireRole("admin")).id
  } catch {
    return NextResponse.redirect(new URL("/403", request.url))
  }

  const done = (result: TwitchConnectResult) => {
    const response = NextResponse.redirect(new URL(`/admin/streams?twitch=${result}`, request.url))
    response.cookies.set(TWITCH_OAUTH_COOKIE, "", { httpOnly: true, path: TWITCH_OAUTH_COOKIE_PATH, maxAge: 0 })
    return response
  }

  const env = process.env
  if (missingEnv(["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_BROADCASTER_ID"], env).length) return done("not-configured")

  const url = new URL(request.url)
  const state = checkTwitchOAuthState({ cookie: request.cookies.get(TWITCH_OAUTH_COOKIE)?.value, state: url.searchParams.get("state"), userId, secret: env.TWITCH_CLIENT_SECRET! })
  if (!state.ok) return done("expired")
  const code = url.searchParams.get("code")
  if (url.searchParams.get("error") || !code) return done("denied")

  const api = twitchAppApi(env)
  try {
    const grant = await api.exchangeCode(code, twitchRedirectUri())
    const info = await api.validate(grant.access_token)
    const scopes = info?.scopes ?? grant.scope ?? []
    const problem: TwitchConnectResult | null = !info || info.user_id !== env.TWITCH_BROADCASTER_ID ? "wrong-account" : TWITCH_SCOPES.some((scope) => !scopes.includes(scope)) || !grant.refresh_token ? "missing-scope" : null
    if (problem || !info) {
      // A grant we won't keep (someone's personal account, say) shouldn't stay live at Twitch either
      await api.revoke(grant.access_token).catch(() => undefined)
      return done(problem ?? "wrong-account")
    }

    const now = new Date()
    await saveTwitchClubGrant({
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token!,
      expiresAt: new Date(now.getTime() + grant.expires_in * 1000).toISOString(),
      login: info.login ?? "",
      userId: info.user_id!,
      scopes,
      connectedAt: now.toISOString(),
      connectedById: userId,
      validatedAt: now.toISOString(),
    })
    await createAuditLog({
      actorUserId: userId,
      actionType: "CONNECT",
      entityType: CONNECTOR_ENTITY,
      entityId: TWITCH_CONNECTOR_ID,
      summary: `Connected the club's Twitch account @${info.login}`,
      after: { login: info.login, scopes },
    })
    return done("connected")
  } catch (error) {
    await recordConnectorError(TWITCH_CONNECTOR_ID, error)
    return done("failed")
  }
}
