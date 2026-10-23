import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the sources-b track's tables: Twitch and Instagram insights */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: `Twitch (the club channel; twitch_stats reads all of this)
- "TwitchStream" is one broadcast; id is Twitch's stream id. endedAt null = live now (newest open row). title can be "" for a few seconds after going live. peakViewers and avgViewers come from "TwitchViewerSample" (concurrent viewers counted once a minute while live, not unique viewers); a stream with no samples was added from its VOD later, so its peakViewers 0 means "not counted", not zero. vodViews is the VOD's view count at the last daily snapshot (vodViewsAt).
- "TwitchChannelDaily" is the follower total once a day; date is the Central date.

Instagram insights (instagram_insights reads all of this)
- "InstagramAccountDaily": one row per Central date, taken that day: followers then, plus that day's reach, views, accountsEngaged, totalInteractions, follows and unfollows, filled in over the next 3 days (Instagram is up to 2 days late; null = not in yet). Adding reach over days counts an account once per day.
- "InstagramPost" rows are the club's posts (the feed sync); reach, likes, comments, saved, shares and views are lifetime numbers as of insightsAt (null = not read yet).`,
  tableNotes: {
    TwitchStream: "One Twitch broadcast. endedAt null = live now. Viewers only for streams with samples.",
    TwitchViewerSample: "Concurrent viewers once a minute while live; pruned after 180 days (peak and average stay on the stream).",
    TwitchChannelDaily: "Twitch follower total per Central date.",
    TwitchEventSubMessage: "Webhook message ids already handled (plumbing, no club data).",
    InstagramAccountDaily: "Instagram account numbers per Central date; followers is that day's count.",
    InstagramPost: "reach, likes, comments, saved, shares, views: the post's lifetime insights as of insightsAt.",
  },
}
