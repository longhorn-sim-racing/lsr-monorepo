/**
 * "Needs attention" checks (#188, design §11.2). Each track registers its checks in
 * `checks/<track>.ts`; the weekly digest and the Overview's "Needs attention" card run the same code.
 * Checks are deterministic reads of club data, rendered from a template: no model writes them.
 *
 * Where the results go:
 * - The digest room message and the Overview card show each check's items (officers only).
 * - Discord and Teams posts get only each check's label, count and `href` (the console page that deals
 *   with it), never its items.
 * - Even so, items must never carry personal data that would matter if a post leaked: no emails, EIDs,
 *   phone numbers, payment amounts tied to a person, application answers or outside text. Name the
 *   thing (an event, a proposal, a prospect's company) and link to where an officer can see the rest.
 */

/** One thing that needs attention, linking to where an officer deals with it */
export type DigestItem = {
  /** e.g. "GM 2 has no results uploaded" */
  title: string
  /** A console path, e.g. "/admin/results?upload=1" */
  href: string
  /** e.g. "Ended Oct 19" */
  detail?: string
}

export type DigestCheckResult = {
  /** How many things need attention (can be more than `items` lists) */
  count: number
  severity: "info" | "warning" | "danger"
  /** The first few, for the room and the Overview; never posted outside */
  items: DigestItem[]
}

/** What a check gets when it runs */
export type DigestContext = {
  /** The time the digest is for (checks compare against it, not the clock, so a digest reads as one moment) */
  now: Date
  signal?: AbortSignal
}

export type DigestCheck = {
  /** Stable, e.g. "proposals.pending" */
  id: string
  /** e.g. "Pending proposals" */
  label: string
  /** The console page where officers deal with it, e.g. "/admin/jack/proposals". Outside posts link here: a path, never a full URL or one with personal data in it */
  href: string
  /** Where it sits in the digest and on the Overview, lowest first */
  order: number
  run(ctx: DigestContext): Promise<DigestCheckResult>
}
