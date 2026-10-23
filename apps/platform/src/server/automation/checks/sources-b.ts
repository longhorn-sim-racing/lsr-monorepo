import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { instagramInsightsConnector } from "@/server/connectors/instagram/connector"
import { twitchConnector } from "@/server/connectors/twitch/connector"
import { twitchAccount } from "@/server/connectors/twitch/tokens"
import type { DigestCheck, DigestCheckResult } from "../types"

/**
 * Digest and Overview "needs attention" checks from the sources-b track (design §11.2): only when a
 * switched-on connection needs an officer. Items name the problem and link to where it's fixed; they
 * never carry error text, which can quote an outside service.
 */

const NOTHING: DigestCheckResult = { count: 0, severity: "info", items: [] }
const when = (iso: string) => `${formatInTimeZone(new Date(iso), DEFAULT_TIMEZONE, "MMM d, h:mm a")} CT`

/** Twitch is on, but the club account has to be connected again, or its syncs are failing */
export const twitchNeedsAttention: DigestCheck = {
  id: "twitch.attention",
  label: "Twitch connection",
  href: "/admin/streams",
  order: 60,
  async run() {
    const status = await twitchConnector.status()
    if (!status.enabled) return NOTHING
    const account = await twitchAccount()
    if (account.reconnect) {
      return {
        count: 1,
        severity: "danger",
        items: [{ title: "The club's Twitch account has to be connected again (an admin, on Streams)", href: "/admin/streams", detail: `Twitch refused its token ${when(account.reconnect.at)}` }],
      }
    }
    if (status.state === "error") {
      return { count: 1, severity: "warning", items: [{ title: "Twitch syncs are failing", href: "/admin/connections", detail: status.lastErrorAt ? `Since ${when(status.lastErrorAt)}` : undefined }] }
    }
    return NOTHING
  },
}

/** Instagram insights are on, but their syncs fail (usually a token without the insights permission, or an expired one) */
export const instagramInsightsFailing: DigestCheck = {
  id: "instagram-insights.failing",
  label: "Instagram insights",
  href: "/admin/instagram",
  order: 61,
  async run() {
    const status = await instagramInsightsConnector.status()
    if (!status.enabled || status.state !== "error") return NOTHING
    return { count: 1, severity: "warning", items: [{ title: "Instagram insights aren't updating (check the token on the Instagram page)", href: "/admin/instagram", detail: status.lastErrorAt ? `Since ${when(status.lastErrorAt)}` : undefined }] }
  },
}

export const CHECKS: DigestCheck[] = [twitchNeedsAttention, instagramInsightsFailing]
