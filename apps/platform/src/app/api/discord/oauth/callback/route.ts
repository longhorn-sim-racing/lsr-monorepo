import { NextResponse, type NextRequest } from "next/server"
import { getSessionUser } from "@/server/auth/session"
import { finishDiscordLink, LINK_COOKIE, LINK_COOKIE_PATH } from "@/server/services/discord-link.service"

export const dynamic = "force-dynamic"

/**
 * GET /api/discord/oauth/callback: where Discord sends the member back (?code&state&iss, or ?error).
 * The link is saved only for the signed-in member who started it (the sealed cookie), then the cookie
 * is cleared and the member lands on their profile editor with the outcome. Registered as the redirect
 * URI in the Developer Portal.
 */
export async function GET(request: NextRequest) {
  const { user } = await getSessionUser()
  const params = request.nextUrl.searchParams
  const outcome = user
    ? await finishDiscordLink({
        userId: user.id,
        cookie: request.cookies.get(LINK_COOKIE)?.value,
        code: params.get("code"),
        state: params.get("state"),
        iss: params.get("iss"),
        error: params.get("error"),
      })
    : null

  const target = user ? `/drivers/${encodeURIComponent(user.handle)}/edit?discord=${outcome}#discord` : "/auth/signin?next=/account"
  const response = NextResponse.redirect(new URL(target, request.url), 303)
  response.cookies.set(LINK_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", path: LINK_COOKIE_PATH, maxAge: 0 })
  response.headers.set("cache-control", "no-store")
  // This URL carried the code; the next page needn't be told it
  response.headers.set("referrer-policy", "no-referrer")
  return response
}
