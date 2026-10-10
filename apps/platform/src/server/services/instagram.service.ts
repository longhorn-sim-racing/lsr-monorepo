import { prisma } from "@/server/db"
import { destroyImage, uploadRemoteImage } from "@/server/cloudinary"
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

/** Hidden or shown on the site. Returns false if the post is gone (a sync removed it meanwhile). */
export async function setInstagramPostHidden(id: string, hidden: boolean) {
  const { count } = await prisma.instagramPost.updateMany({ where: { id }, data: { hidden } })
  return count > 0
}

/**
 * Record how a sync went. Re-reads the settings first, so a token pasted or disconnected
 * while the sync ran isn't overwritten with the one the sync started with.
 */
async function recordSync(status: Pick<InstagramSettings, "lastSyncAt" | "lastError" | "lastErrorAt">) {
  await writeSettings({ ...(await readSettings()), ...status })
}

/** Run `task` over `items`, a few at a time. */
async function inBatches<T>(items: T[], size: number, task: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(task))
}

/** Copy new posts from Instagram, update edited captions, drop deleted posts, and renew the token when due. */
export async function syncInstagram(): Promise<InstagramSyncResult> {
  const settings = await readSettings()
  const result: InstagramSyncResult = { ok: true, added: 0, updated: 0, removed: 0 }
  if (!settings.token) return { ...result, ok: false, skipped: "not-connected" }

  const now = new Date()
  let token = settings.token
  try {
    const refreshedAt = settings.tokenRefreshedAt ? new Date(settings.tokenRefreshedAt).getTime() : 0
    if (now.getTime() - refreshedAt > REFRESH_AFTER) {
      const fresh = await refreshToken(token)
      token = fresh.access_token
      const latest = await readSettings()
      // Only store the renewed token if nobody replaced or removed the old one meanwhile
      if (latest.token === settings.token) {
        await writeSettings({
          ...latest,
          token,
          tokenRefreshedAt: now.toISOString(),
          tokenExpiresAt: new Date(now.getTime() + fresh.expires_in * 1000).toISOString(),
        })
      }
    }

    const media = await getRecentMedia(token, SYNC_LIMIT)
    const existing = new Map(
      (
        await prisma.instagramPost.findMany({
          where: { id: { in: media.map((item) => item.id) } },
          select: { id: true, publicId: true },
        })
      ).map((post) => [post.id, post]),
    )

    // Copy each new image once (Instagram's own image links expire), a few at a time so a
    // first sync of 24 posts fits comfortably in one request
    const images = new Map<string, { publicId: string; width: number | null; height: number | null }>()
    const imageErrors: string[] = []
    await inBatches(
      media.filter((item) => !existing.get(item.id)?.publicId),
      4,
      async (item) => {
        const source = stillImageUrl(item)
        if (!source) return
        try {
          images.set(item.id, await uploadRemoteImage(source, `instagram/${item.id}`))
        } catch (error) {
          imageErrors.push(error instanceof Error ? error.message : String(error))
        }
      },
    )

    for (const item of media) {
      const fields = {
        permalink: item.permalink,
        caption: item.caption ?? null,
        mediaType: item.media_type,
        postedAt: new Date(item.timestamp),
        ...(images.get(item.id) ?? {}),
      }
      await prisma.instagramPost.upsert({ where: { id: item.id }, update: fields, create: { id: item.id, ...fields } })
      if (existing.has(item.id)) result.updated++
      else result.added++
    }

    // A post deleted on Instagram comes off the site, image and all. Only look within the
    // window just fetched, so older posts aren't mistaken for deleted ones.
    if (media.length > 0) {
      const oldest = new Date(Math.min(...media.map((item) => new Date(item.timestamp).getTime())))
      const gone = await prisma.instagramPost.findMany({
        where: { postedAt: { gte: oldest }, id: { notIn: media.map((item) => item.id) } },
        select: { id: true, publicId: true },
      })
      for (const post of gone) {
        if (post.publicId?.startsWith("instagram/")) await destroyImage(post.publicId)
      }
      const { count } = await prisma.instagramPost.deleteMany({ where: { id: { in: gone.map((post) => post.id) } } })
      result.removed = count
    }

    if (imageErrors.length > 0) {
      result.error = `Couldn't copy ${imageErrors.length} image${imageErrors.length === 1 ? "" : "s"}: ${imageErrors[0]}`
    }
    await recordSync({
      lastSyncAt: now.toISOString(),
      lastError: result.error ?? null,
      lastErrorAt: result.error ? now.toISOString() : null,
    })
    return result
  } catch (error) {
    const message =
      error instanceof InstagramApiError && error.expiredToken
        ? "Instagram access has expired or was revoked. Connect the account again."
        : error instanceof Error
          ? error.message
          : String(error)
    await recordSync({ lastError: message, lastErrorAt: now.toISOString() })
    return { ...result, ok: false, error: message }
  }
}
