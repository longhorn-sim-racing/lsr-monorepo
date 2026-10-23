import { NextResponse, type NextRequest } from "next/server"
import { getSessionUser } from "@/server/auth/session"
import { LINK_COOKIE, LINK_COOKIE_MAX_AGE_S, LINK_COOKIE_PATH, startDiscordLink } from "@/server/services/discord-link.service"

export const dynamic = "force-dynamic"

/**
 * POST /api/discord/oauth/start: a signed-in member starts linking their Discord account (the form on
 * their profile editor). A POST, so another site can't start it: the session cookie isn't sent on a
 * cross-site POST. Sets the sealed state cookie and sends the browser to Discord (303).
 */
export async function POST(request: NextRequest) {
  const { user } = await getSessionUser()
  if (!user) return NextResponse.redirect(new URL("/auth/signin?next=/account", request.url), 303)

  const started = await startDiscordLink(user)
  if (!started.ok) return NextResponse.redirect(new URL(`/drivers/${encodeURIComponent(user.handle)}/edit?discord=${started.outcome}#discord`, request.url), 303)

  const response = NextResponse.redirect(started.url, 303)
  response.cookies.set(LINK_COOKIE, started.cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: LINK_COOKIE_PATH,
    maxAge: LINK_COOKIE_MAX_AGE_S,
  })
  response.headers.set("cache-control", "no-store")
  return response
}
