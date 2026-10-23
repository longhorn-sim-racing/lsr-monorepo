import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { pingCloudinary } from "@/server/cloudinary"
import { defineConnector } from "../define"
import type { ConnectorEnv } from "../types"
import { instagramGraph } from "./graph"
import { instagramPublisher, type InstagramPublisher } from "./publish"
import { PUBLISH_SETTING, publishAccount, readPublishAccess } from "./publish-token"

/**
 * Instagram publishing (#188, design §12.6): officers approve a post of a deck's slides (a proposal card,
 * or the deck page's button), and the slides go to Instagram as a post, a carousel or a story. It uses
 * its own token (SystemSetting "instagram_publish", from a second Meta app with
 * instagram_business_content_publish), never the feed's read token, and Cloudinary for the public JPEG
 * links Instagram fetches. Switched off until an admin turns it on (System → Connections) after its
 * smoke test, which reads the account and the day's quota and pings Cloudinary, and never posts.
 */

export const INSTAGRAM_PUBLISH_ID = "instagram-publish"

/** Cloudinary's: the public copies of the slides Instagram downloads */
export const PUBLISH_ENV = ["NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]

export type InstagramPublishClient = InstagramPublisher & { username: string | null }

/** A publisher for the stored publishing token, or null when none is stored. The account id comes from /me when it wasn't saved */
export async function instagramPublishClient(env: ConnectorEnv = process.env): Promise<InstagramPublishClient | null> {
  const access = await readPublishAccess()
  if (!access) return null
  const graph = instagramGraph(access.token, env)
  const userId = access.userId ?? (await instagramPublisher(graph, "me").account()).userId
  return { ...instagramPublisher(graph, userId), username: access.username }
}

const day = (iso: string) => formatInTimeZone(new Date(iso), DEFAULT_TIMEZONE, "MMM d")

export const instagramPublishConnector = defineConnector<InstagramPublishClient | null>({
  id: INSTAGRAM_PUBLISH_ID,
  label: "Instagram publishing",
  requiredEnv: PUBLISH_ENV,
  async missingSettings() {
    return (await readPublishAccess()) ? [] : [PUBLISH_SETTING]
  },
  createClient: (env) => instagramPublishClient(env),
  // Works while switched off. Reading the quota is what proves the token can publish; nothing is posted
  async smoke({ signal } = {}) {
    const client = await instagramPublishClient()
    if (!client) return { ok: false, summary: "No publishing token is saved: an admin pastes one on Content → Instagram (Publishing)." }
    const account = await client.account(signal)
    const quota = await client.quota(signal)
    const cloudinary = await pingCloudinary(signal)
    const summary = `Read @${account.username}: ${quota.used} of ${quota.total} API posts used in the last 24 hours; ${cloudinary.ok ? "Cloudinary answered" : cloudinary.detail}`
    return { ok: cloudinary.ok, summary }
  },
  async details() {
    const account = await publishAccount()
    if (!account.connected) return [{ label: "Token", value: "None saved: an admin pastes one on Content → Instagram (Publishing)" }]
    return [
      { label: "Account", value: account.username ? `@${account.username}` : "Unknown" },
      {
        label: "Token",
        value: `Its own (instagram_publish), renewed weekly by the instagram-publish.token job${account.tokenExpiresAt ? `; runs out ${day(account.tokenExpiresAt)} if renewing stops` : ""}`,
      },
      ...(account.refreshError ? [{ label: "Renewal", value: `Failed${account.refreshErrorAt ? ` ${day(account.refreshErrorAt)}` : ""}: ${account.refreshError}` }] : []),
    ]
  },
})
