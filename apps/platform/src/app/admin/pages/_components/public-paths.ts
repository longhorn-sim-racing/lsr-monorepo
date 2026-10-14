import { LSC_RULES_SLUG } from "@/lib/page-slugs"

/** Where each content page the site renders shows up, by slug. Pages not listed aren't linked anywhere yet. */
export const PAGE_PUBLIC_PATHS: Record<string, string> = {
  [LSC_RULES_SLUG]: "/lone-star-cup/rules",
}
