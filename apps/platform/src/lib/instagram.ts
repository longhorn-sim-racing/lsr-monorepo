// Instagram API with Instagram Login: read the club's own posts with a long-lived token.
// https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login
// INSTAGRAM_GRAPH_URL points it at a stand-in server for local testing.
const GRAPH_URL = process.env.INSTAGRAM_GRAPH_URL || "https://graph.instagram.com"

export const INSTAGRAM_PROFILE_URL = "https://instagram.com/longhorn_sim_racing"

export type InstagramMediaType = "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM"

export type InstagramMedia = {
  id: string
  caption?: string
  media_type: InstagramMediaType
  /** Missing for videos with licensed audio; Meta drops it even for your own posts */
  media_url?: string
  thumbnail_url?: string
  permalink: string
  timestamp: string
  children?: { data: { media_type: InstagramMediaType; media_url?: string; thumbnail_url?: string }[] }
}

/** An error from the Graph API. `expiredToken` means the account has to be connected again. */
export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly expiredToken: boolean,
  ) {
    super(message)
    this.name = "InstagramApiError"
  }
}

async function graph<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, GRAPH_URL)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  const res = await fetch(url, { cache: "no-store" })
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } }
  if (!res.ok || json.error) {
    const code = json.error?.code
    // 190 is Meta's "access token invalid or expired"
    throw new InstagramApiError(json.error?.message ?? `Instagram returned ${res.status}`, res.status, code === 190)
  }
  return json
}

/** The account a token belongs to. */
export function getProfile(token: string) {
  return graph<{ user_id: string; username: string }>("/me", { fields: "user_id,username", access_token: token })
}

/** The newest posts, newest first. */
export async function getRecentMedia(token: string, limit = 24) {
  const json = await graph<{ data: InstagramMedia[] }>("/me/media", {
    fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}",
    limit: String(limit),
    access_token: token,
  })
  return json.data
}

/**
 * Swap a long-lived token for a fresh one that's good for another 60 days. Meta only allows
 * this once the token is a day old, and refuses once it has expired.
 */
export function refreshToken(token: string) {
  return graph<{ access_token: string; expires_in: number }>("/refresh_access_token", {
    grant_type: "ig_refresh_token",
    access_token: token,
  })
}

/** The best still image for a post: the photo, a video's cover frame, or an album's first item. */
export function stillImageUrl(media: InstagramMedia): string | null {
  if (media.media_type === "VIDEO") return media.thumbnail_url ?? null
  if (media.media_type === "CAROUSEL_ALBUM") {
    const first = media.children?.data[0]
    if (first) return first.media_type === "VIDEO" ? (first.thumbnail_url ?? null) : (first.media_url ?? null)
  }
  return media.media_url ?? media.thumbnail_url ?? null
}
