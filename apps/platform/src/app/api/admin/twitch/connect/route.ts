import { NextResponse, type NextRequest } from "next/server"
import { requireRole } from "@/server/auth/guards"
import { missingEnv } from "@/server/connectors/define"
import { twitchAppApi } from "@/server/connectors/twitch/connector"
import { createTwitchOAuthState, TWITCH_CONNECT_PATH, TWITCH_OAUTH_COOKIE, TWITCH_OAUTH_COOKIE_PATH, TWITCH_OAUTH_TTL_MS, twitchRedirectUri } from "@/server/connectors/twitch/oauth"

/**
 * Starts connecting the club's Twitch account (admins only; design §12.2): sends the browser to
 * Twitch's consent page for `moderator:read:followers`, with a state bound to this admin by a short-lived
 * cookie (src/server/connectors/twitch/oauth.ts). The callback route finishes it.
 */

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  let userId: string
  try {
    userId = (await requireRole("admin")).id
  } catch {
    return NextResponse.redirect(new URL("/403", request.url))
  }
  if (missingEnv(["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_BROADCASTER_ID"]).length) {
    return NextResponse.redirect(new URL("/admin/streams?twitch=not-configured", request.url))
  }

  const redirectUri = twitchRedirectUri()
  const site = new URL(redirectUri)
  // Twitch sends the browser back to the registered address, so the cookie has to be set on that host
  if (new URL(request.url).origin !== site.origin) return NextResponse.redirect(new URL(TWITCH_CONNECT_PATH, site.origin))

  const { state, cookie } = createTwitchOAuthState(process.env.TWITCH_CLIENT_SECRET!, userId)
  const response = NextResponse.redirect(twitchAppApi().authorizeUrl({ redirectUri, state }))
  response.cookies.set(TWITCH_OAUTH_COOKIE, cookie, {
    httpOnly: true,
    secure: site.protocol === "https:",
    // Twitch's redirect back is a top-level GET, which Lax cookies go with
    sameSite: "lax",
    path: TWITCH_OAUTH_COOKIE_PATH,
    maxAge: TWITCH_OAUTH_TTL_MS / 1000,
  })
  return response
}
