import { revalidatePath } from "next/cache";

/** The public pages admin changes refresh, for code that lists paths instead of refreshing them (see revalidatePaths) */
export const publicPaths = {
  drivers: "/drivers",
  driverProfile: (handle: string) => `/drivers/${handle}`,
  events: "/events",
  event: (slug: string) => `/events/${slug}`,
  series: "/lone-star-cup",
  news: "/news",
  newsPost: (slug: string) => `/news/${slug}`,
};

/**
 * Refreshes each path. The event, results and news services return the paths a change touched
 * (`revalidate` on their results) instead of refreshing them, because revalidatePath only works inside a
 * request (a server action or route handler) and the services also run from scripts. The admin actions
 * and Jack's proposal apply pass those paths here.
 */
export function revalidatePaths(paths: readonly string[]) {
  for (const path of paths) revalidatePath(path);
}

export function revalidateDriverList() {
  revalidatePath(publicPaths.drivers);
}

export function revalidateDriverProfile(handle: string) {
  revalidatePath(publicPaths.driverProfile(handle));
}

export function revalidateEventList() {
  revalidatePath(publicPaths.events);
}

export function revalidateEventDetail(slug: string) {
  revalidatePath(publicPaths.event(slug));
}

export function revalidateSeriesPages() {
  revalidatePath(publicPaths.series);
}

export function revalidateNewsList() {
  revalidatePath(publicPaths.news);
}

export function revalidateNewsPost(slug: string) {
  revalidatePath(publicPaths.newsPost(slug));
}

/** The public pages new race results show on: drivers, the event's page, the events list and the series */
export function resultsIngestionPaths(opts: { eventSlug?: string | null }): string[] {
  return [
    publicPaths.drivers,
    ...(opts.eventSlug ? [publicPaths.event(opts.eventSlug)] : []),
    publicPaths.events,
    publicPaths.series,
  ];
}
