import { prisma } from "@/server/db"
import { uploadRemoteImage } from "@/server/cloudinary"
import { getProfile, getRecentMedia, InstagramApiError, refreshToken, stillImageUrl } from "@/lib/instagram"

// The club Instagram feed: an officer pastes an access token once (Admin → Instagram), then an
// hourly job (.github/workflows/instagram-cron.yml → /api/cron/instagram) copies new posts into
// InstagramPost and Cloudinary and renews the token weekly so it never reaches its 60-day expiry.
// See docs/instagram.md.

const SETTING_KEY = "instagram"
const DAY = 24 * 60 * 60 * 1000
/** Meta allows a refresh once a token is a day old; weekly leaves plenty of slack before 60 days. */
const REFRESH_AFTER = 7 * DAY
/** How many recent posts each sync looks at. */
const SYNC_LIMIT = 24

type InstagramSettings = {
  token?: string
  userId?: string
  username?: string
  connectedAt?: string
  tokenRefreshedAt?: string
  tokenExpiresAt?: string
  lastSyncAt?: string
  lastError?: string | null
  lastErrorAt?: string | null
}

/** What the admin page shows. Never includes the token. */
export type InstagramStatus = Omit<InstagramSettings, "token"> & { connected: boolean }

export type InstagramSyncResult = {
  ok: boolean
  skipped?: "not-connected"
  added: number
  updated: number
  removed: number
  error?: string
}

async function readSettings(): Promise<InstagramSettings> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } })
  if (!row) return {}
  try {
    return JSON.parse(row.value) as InstagramSettings
  } catch {
    return {}
  }
}

async function writeSettings(settings: InstagramSettings) {
  const value = JSON.stringify(settings)
  await prisma.systemSetting.upsert({ where: { key: SETTING_KEY }, update: { value }, create: { key: SETTING_KEY, value } })
}

export async function getInstagramStatus(): Promise<InstagramStatus> {
  const { token, ...rest } = await readSettings()
  return { ...rest, connected: Boolean(token) }
}

/** Check a pasted token against Instagram and store it. Throws if Instagram rejects it. */
export async function connectInstagram(rawToken: string) {
  const token = rawToken.trim()
  if (!token) throw new Error("Paste the access token first")

  let profile
  try {
    profile = await getProfile(token)
  } catch (error) {
    if (error instanceof InstagramApiError) {
      throw new Error("Instagram didn't accept that token. Copy it again from the Meta dashboard and paste the whole thing.")
    }
    throw error
  }

  const now = new Date()
  const previous = await readSettings()
  await writeSettings({
    ...previous,
    token,
    userId: profile.user_id,
    username: profile.username,
    connectedAt: now.toISOString(),
    // Tokens made in the Meta dashboard are already long-lived (60 days)
    tokenRefreshedAt: now.toISOString(),
    tokenExpiresAt: new Date(now.getTime() + 60 * DAY).toISOString(),
    lastError: null,
    lastErrorAt: null,
  })
  return profile
}

/** Forget the token. Posts already copied stay on the site. */
export async function disconnectInstagram() {
  const settings = await readSettings()
  delete settings.token
  await writeSettings({ ...settings, lastError: null, lastErrorAt: null })
}

export async function setInstagramPostHidden(id: string, hidden: boolean) {
  return prisma.instagramPost.update({ where: { id }, data: { hidden } })
}

/** Copy new posts from Instagram, update edited captions, drop deleted posts, and renew the token when due. */
export async function syncInstagram(): Promise<InstagramSyncResult> {
  const settings = await readSettings()
  const result: InstagramSyncResult = { ok: true, added: 0, updated: 0, removed: 0 }
  if (!settings.token) return { ...result, ok: false, skipped: "not-connected" }

  const now = new Date()
  try {
    const refreshedAt = settings.tokenRefreshedAt ? new Date(settings.tokenRefreshedAt).getTime() : 0
    if (now.getTime() - refreshedAt > REFRESH_AFTER) {
      const fresh = await refreshToken(settings.token)
      settings.token = fresh.access_token
      settings.tokenRefreshedAt = now.toISOString()
      settings.tokenExpiresAt = new Date(now.getTime() + fresh.expires_in * 1000).toISOString()
      // Save straight away so a failure further down can't lose the new token
      await writeSettings(settings)
    }

    const media = await getRecentMedia(settings.token, SYNC_LIMIT)
    const existing = new Map(
      (
        await prisma.instagramPost.findMany({
          where: { id: { in: media.map((item) => item.id) } },
          select: { id: true, publicId: true },
        })
      ).map((post) => [post.id, post]),
    )

    const imageErrors: string[] = []
    for (const item of media) {
      const previous = existing.get(item.id)
      let image: { publicId: string; width: number | null; height: number | null } | null = null

      // Copy the image once; Instagram's own image links expire after a while
      if (!previous?.publicId) {
        const source = stillImageUrl(item)
        if (source) {
          try {
            image = await uploadRemoteImage(source, `instagram/${item.id}`)
          } catch (error) {
            imageErrors.push(error instanceof Error ? error.message : String(error))
          }
        }
      }

      const fields = {
        permalink: item.permalink,
        caption: item.caption ?? null,
        mediaType: item.media_type,
        postedAt: new Date(item.timestamp),
        ...(image ?? {}),
      }
      await prisma.instagramPost.upsert({ where: { id: item.id }, update: fields, create: { id: item.id, ...fields } })
      if (previous) result.updated++
      else result.added++
    }

    // A post deleted on Instagram comes off the site too. Only look within the window just
    // fetched, so older posts aren't mistaken for deleted ones.
    if (media.length > 0) {
      const oldest = new Date(Math.min(...media.map((item) => new Date(item.timestamp).getTime())))
      const { count } = await prisma.instagramPost.deleteMany({
        where: { postedAt: { gte: oldest }, id: { notIn: media.map((item) => item.id) } },
      })
      result.removed = count
    }

    settings.lastSyncAt = now.toISOString()
    if (imageErrors.length > 0) {
      settings.lastError = `Couldn't copy ${imageErrors.length} image${imageErrors.length === 1 ? "" : "s"}: ${imageErrors[0]}`
      settings.lastErrorAt = now.toISOString()
      result.error = settings.lastError
    } else {
      settings.lastError = null
      settings.lastErrorAt = null
    }
    await writeSettings(settings)
    return result
  } catch (error) {
    const message =
      error instanceof InstagramApiError && error.expiredToken
        ? "Instagram access has expired or was revoked. Connect the account again."
        : error instanceof Error
          ? error.message
          : String(error)
    settings.lastError = message
    settings.lastErrorAt = now.toISOString()
    await writeSettings(settings)
    return { ...result, ok: false, error: message }
  }
}
