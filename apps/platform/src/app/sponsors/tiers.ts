// Sponsorship packages, from the Business team's sponsor packet. The tier cards, the comparison
// table and the packet itself (public/SPONSOR_BENEFITS.pdf) all read from here; after a change,
// re-render the packet with `pnpm --filter @lsr/platform sponsor-packet`. Benefits are
// contractual: check with Business before editing.

export type TierId = "friend" | "silver" | "gold" | "platinum"

export type Tier = {
  id: TierId
  name: string
  short: string
  price: string
  /** What this tier adds on top of the ones below it. */
  benefits: string[]
}

export const TIERS: Tier[] = [
  {
    id: "friend",
    name: "Friend of LSR",
    short: "Friend",
    price: "$100 – $249",
    benefits: ["Business “Shout-out” on social media"],
  },
  {
    id: "silver",
    name: "Silver Partner",
    short: "Silver",
    price: "$250 – $999",
    benefits: ["Business name on website sponsorship page", "Business logo on Longhorn Sim Racing’s Livery"],
  },
  {
    id: "gold",
    name: "Gold Partner",
    short: "Gold",
    price: "$1,000 – $4,999",
    benefits: ["Logo (medium-sized) on website’s main page with a clickable link to sponsor", "One team shirt"],
  },
  {
    id: "platinum",
    name: "Platinum Partner",
    short: "Platinum",
    price: "$5,000+",
    benefits: [
      "Logo featured on the team banner displayed at tabling and press events",
      "Team merchandise package",
      "Scheduled campus visit with the team",
    ],
  },
]

/**
 * Rows of the comparison table. Each starts at one tier and, since every level includes
 * everything below it, carries through to Platinum.
 */
export const COMPARE: { label: string; from: TierId }[] = [
  { label: "Tax-deductible contribution", from: "friend" },
  { label: "Social media shout-out", from: "friend" },
  { label: "Name on the website sponsorship page", from: "silver" },
  { label: "Logo on the team livery", from: "silver" },
  { label: "Logo and link on the website's main page", from: "gold" },
  { label: "One team shirt", from: "gold" },
  { label: "Logo on the team banner at tabling and press events", from: "platinum" },
  { label: "Team merchandise package", from: "platinum" },
  { label: "Scheduled campus visit with the team", from: "platinum" },
]

export const tierIndex = (id: TierId) => TIERS.findIndex((tier) => tier.id === id)
