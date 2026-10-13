/** "LEAGUE_ENTRY_GRANTED" → "League entry granted", "LeagueApplication" → "League application" */
export function humanizeCode(code: string): string {
  const words = code
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The admin page for an audited record, for the types that have one. */
const ENTITY_PAGES: Record<string, (id: string) => string> = {
  EVENT: (id) => `/admin/events/${id}/edit`,
  EVENT_SERIES: (id) => `/admin/series/${id}/edit`,
  VENUE: (id) => `/admin/venues/${id}/edit`,
  SEASON: (id) => `/admin/seasons/${id}/edit`,
  RESULT_UPLOAD: (id) => `/admin/results/${id}`,
  POST: (id) => `/admin/news/${id}`,
  PAGE: (id) => `/admin/pages/${id}`,
  PRODUCT: (id) => `/admin/products/${id}`,
  USER: (id) => `/admin/users/${id}/edit`,
  DRIVER_IDENTITY: () => "/admin/drivers",
  CAR_MAPPING: () => "/admin/cars",
}

export function entityHref(entityType: string, entityId: string): string | null {
  const page = ENTITY_PAGES[entityType.toUpperCase()]
  return page ? page(entityId) : null
}
