// The home page's featured video (the hotlap of the week or a competition clip) plays either a
// YouTube video or a video an officer uploaded to Cloudinary.

/**
 * How an uploaded video is delivered: an MP4 every browser plays, and a poster frame Cloudinary picks.
 * Uploads ask for both ahead of time (eager), because the free plan only converts videos up to 40 MB
 * on request.
 */
export const UPLOAD_VIDEO_TRANSFORM = "q_auto"
export const UPLOAD_POSTER_TRANSFORM = "so_auto,c_limit,w_1280,q_auto"
export const UPLOAD_EAGER = `${UPLOAD_VIDEO_TRANSFORM}/mp4|${UPLOAD_POSTER_TRANSFORM}/jpg`

/** The largest video Cloudinary's free plan takes */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export type VideoSource = { kind: "youtube"; id: string } | { kind: "upload"; src: string; poster: string }

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"])

/** A YouTube video id from watch, youtu.be, embed, shorts and live links */
export function youTubeId(url: string): string | null {
  let id: string | null = null
  try {
    const u = new URL(url)
    if (u.hostname === "youtu.be") id = u.pathname.split("/")[1] ?? null
    else if (!YOUTUBE_HOSTS.has(u.hostname)) return null
    else if (u.searchParams.has("v")) id = u.searchParams.get("v")
    else if (/^\/(embed|shorts|live)\//.test(u.pathname)) id = u.pathname.split("/")[2] ?? null
  } catch {}
  return id && /^[\w-]{11}$/.test(id) ? id : null
}

/**
 * An uploaded video's playable MP4 and poster frame, from the address Cloudinary gave back on upload
 * (`https://res.cloudinary.com/<cloud>/video/upload/v<version>/<id>.<ext>`)
 */
export function uploadedVideo(url: string): { src: string; poster: string } | null {
  const match = /^https:\/\/res\.cloudinary\.com\/([\w-]+)\/video\/upload\/(v\d+)\/([^?#]+)\.\w+$/.exec(url)
  if (!match) return null
  const [, cloud, version, publicId] = match
  const base = `https://res.cloudinary.com/${cloud}/video/upload`
  return {
    src: `${base}/${UPLOAD_VIDEO_TRANSFORM}/${version}/${publicId}.mp4`,
    poster: `${base}/${UPLOAD_POSTER_TRANSFORM}/${version}/${publicId}.jpg`,
  }
}

/** Where a saved video link plays from, or null when it's neither a YouTube video nor an upload */
export function videoSource(url: string): VideoSource | null {
  const id = youTubeId(url)
  if (id) return { kind: "youtube", id }
  const upload = uploadedVideo(url)
  return upload ? { kind: "upload", ...upload } : null
}
