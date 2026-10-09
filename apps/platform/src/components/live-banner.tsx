import { getLiveEvents } from "@/server/queries/events";
import { isEventLive } from "@/lib/events";
import { LiveBannerClient } from "./live-banner-client";

export async function LiveBanner() {
  let liveEvents;
  try {
    const allLiveEvents = await getLiveEvents();
    liveEvents = allLiveEvents.filter(event => isEventLive(event));
  } catch {
    return null;
  }

  if (liveEvents.length === 0) {
    return null;
  }

  // We'll just take the first one if multiple are live to avoid UI clutter.
  const event = liveEvents[0];

  return <LiveBannerClient event={{
    title: event.title,
    slug: event.slug,
    streamUrl: event.streamUrl,
    startsAtUtc: event.startsAtUtc,
    endsAtUtc: event.endsAtUtc
  }} />;
}
