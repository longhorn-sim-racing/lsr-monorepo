// Corporate sponsors, shared by the homepage strip, /sponsors and /about.
//
// Placement follows the sponsorship tiers: Gold and up appear on the homepage, /about and
// /sponsors; Silver only on /sponsors. Tier benefits are contractual, so check a sponsor's
// tier with the business team before adding them anywhere.

export type SponsorTier = "gold" | "silver"

export type Sponsor = {
  name: string
  logo: string
  tier: SponsorTier
  /** Plain URL; use sponsorHref() to add the referral tags for a given page. */
  url?: string
  title?: string
  description?: string
}

export const SPONSORS: Sponsor[] = [
  {
    name: "PitLane Systems",
    logo: "/sponsors/pitlane.png",
    tier: "gold",
    url: "https://www.pitlanesystems.com/",
    title: "Official Broadcast Partner",
    description:
      "PitLane Systems builds the first unified broadcast director software for sim racing, consolidating camera control, overlays, timing data, and OBS into a single dashboard — bringing TV-grade production to our Assetto Corsa events.",
  },
  {
    name: "Race Club Austin",
    logo: "/sponsors/raceclub.png",
    tier: "gold",
    url: "https://www.raceclubsim.com/",
  },
  {
    name: "Driven to Care",
    // Black ink recolored to white for the dark site; driventocare.png is the original
    logo: "/sponsors/driventocare-reversed.png",
    tier: "gold",
    url: "https://www.driventocare.org/",
  },
  {
    name: "Yugo",
    logo: "/sponsors/yugo.png",
    tier: "silver",
    description:
      "Yugo is a global student living brand and operator creating safe, supportive communities where students can connect and thrive.",
  },
]

export const GOLD_SPONSORS = SPONSORS.filter((sponsor) => sponsor.tier === "gold")

/** The sponsor's URL with referral tags, e.g. campaign "sponsor-homepage". */
export function sponsorHref(url: string, campaign: string): string {
  const u = new URL(url)
  u.searchParams.set("utm_source", "longhornsimracing.org")
  u.searchParams.set("utm_medium", "referral")
  u.searchParams.set("utm_campaign", campaign)
  return u.toString()
}
