import { revalidatePath } from "next/cache";

export function revalidateDriverList() {
  revalidatePath("/drivers");
}

export function revalidateDriverProfile(handle: string) {
  revalidatePath(`/drivers/${handle}`);
}

export function revalidateEventList() {
  revalidatePath("/events");
}

export function revalidateEventDetail(slug: string) {
  revalidatePath(`/events/${slug}`);
}

export function revalidateSeriesPages(slug?: string) {
  if (slug) revalidatePath(`/series/${slug}`);
  revalidatePath("/lone-star-cup");
}

export function revalidateNewsList() {
  revalidatePath("/news");
}

export function revalidateNewsPost(slug: string) {
  revalidatePath(`/news/${slug}`);
}

export function revalidateAfterResultsIngestion(opts: {
  eventSlug?: string | null;
  seriesSlug?: string | null;
}) {
  revalidateDriverList();
  if (opts.eventSlug) revalidateEventDetail(opts.eventSlug);
  revalidateEventList();
  revalidateSeriesPages(opts.seriesSlug ?? undefined);
}
