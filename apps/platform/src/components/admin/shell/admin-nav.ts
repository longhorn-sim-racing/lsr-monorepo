export type AdminNavItem = {
  title: string
  href: string
  /** Extra words the command menu matches on */
  keywords?: string[]
}

export type AdminNavGroup = {
  /** Shown above the group in the sidebar; the first group has none */
  label?: string
  items: AdminNavItem[]
}

/** The admin console's navigation, grouped by job. The sidebar, top bar and command menu all read it. */
export const ADMIN_NAV: AdminNavGroup[] = [
  {
    items: [
      { title: "Overview", href: "/admin", keywords: ["home", "dashboard"] },
      { title: "Jack", href: "/admin/jack", keywords: ["ai", "assistant", "ask", "chat", "rooms"] },
      { title: "Decks and graphics", href: "/admin/jack/decks", keywords: ["slides", "presentation", "instagram", "story", "post", "promo", "jack"] },
      { title: "Proposals", href: "/admin/jack/proposals", keywords: ["proposed changes", "apply", "discard", "pending", "jack"] },
      { title: "Recurring questions", href: "/admin/jack/recurring", keywords: ["scheduled questions", "automation", "weekly", "daily", "jack"] },
      { title: "Usage", href: "/admin/jack/usage", keywords: ["cost", "spend", "budget", "feedback", "jack"] },
    ],
  },
  {
    label: "Events",
    items: [
      { title: "Events", href: "/admin/events", keywords: ["calendar", "registration", "attendance"] },
      { title: "Series", href: "/admin/series" },
      { title: "Venues", href: "/admin/venues", keywords: ["location"] },
    ],
  },
  {
    label: "Racing",
    items: [
      { title: "Seasons", href: "/admin/seasons", keywords: ["league", "standings"] },
      { title: "Results", href: "/admin/results", keywords: ["upload", "race"] },
      { title: "Hotlap and clips", href: "/admin/hotlap", keywords: ["competition clip", "video", "highlights", "home page"] },
      { title: "Driver mapping", href: "/admin/drivers", keywords: ["guid", "identity"] },
      { title: "Car mapping", href: "/admin/cars" },
    ],
  },
  {
    label: "Members",
    items: [
      { title: "Members and roles", href: "/admin/users", keywords: ["users", "officers", "badges", "eid"] },
      { title: "Recruiting", href: "/admin/recruiting", keywords: ["applications", "apply", "rounds", "interviews", "decisions"] },
    ],
  },
  {
    label: "Community",
    items: [
      { title: "Discord", href: "/admin/discord", keywords: ["server", "channels", "polls", "activity", "members", "role sync", "linked accounts"] },
      { title: "Announcements", href: "/admin/announcements", keywords: ["discord posts", "reminders", "standing rules", "scheduled posts"] },
    ],
  },
  {
    label: "Club",
    items: [
      { title: "Meetings", href: "/admin/meetings", keywords: ["agenda", "minutes", "summary", "transcript", "decisions", "gm", "board"] },
      { title: "Action items", href: "/admin/action-items", keywords: ["tasks", "to-dos", "owners", "follow-ups", "overdue"] },
      { title: "Sponsors", href: "/admin/sponsors", keywords: ["prospects", "outreach", "sponsorship", "partners", "pipeline"] },
    ],
  },
  {
    label: "Money",
    items: [
      { title: "Payments", href: "/admin/payments", keywords: ["stripe", "refunds", "donations"] },
      { title: "Products", href: "/admin/products", keywords: ["pricing", "fees"] },
      { title: "LSC entries", href: "/admin/league-entries", keywords: ["lone star cup", "applications", "entrants"] },
    ],
  },
  {
    label: "Content",
    items: [
      { title: "News", href: "/admin/news", keywords: ["posts"] },
      { title: "Pages", href: "/admin/pages", keywords: ["rules"] },
      { title: "Gallery", href: "/admin/gallery", keywords: ["photos", "albums"] },
      { title: "Instagram", href: "/admin/instagram" },
      { title: "Knowledge", href: "/admin/knowledge", keywords: ["knowledge base", "memory", "notes", "documents", "drive", "sharepoint", "teams", "jack"] },
      { title: "Streams", href: "/admin/streams", keywords: ["twitch", "live", "vods", "viewers", "followers"] },
    ],
  },
  {
    label: "System",
    items: [
      { title: "Notifications", href: "/admin/notifications", keywords: ["email"] },
      { title: "Audit log", href: "/admin/audit", keywords: ["history", "changes"] },
      { title: "Tools", href: "/admin/tools" },
      { title: "Connections", href: "/admin/connections", keywords: ["integrations", "connectors", "services", "env", "smoke test"] },
      { title: "Scheduled jobs", href: "/admin/jobs", keywords: ["cron", "scheduler", "sync", "runs", "heartbeat"] },
    ],
  },
]

/** The nav item a path belongs to: the longest matching href, with Overview matching only /admin itself. */
export function findNavItem(pathname: string): { group: AdminNavGroup; item: AdminNavItem } | null {
  let best: { group: AdminNavGroup; item: AdminNavItem } | null = null
  for (const group of ADMIN_NAV) {
    for (const item of group.items) {
      const matches = item.href === "/admin" ? pathname === "/admin" : pathname === item.href || pathname.startsWith(`${item.href}/`)
      if (matches && (!best || item.href.length > best.item.href.length)) best = { group, item }
    }
  }
  return best
}
