import type { EvalSeeder, SeedContext } from "./types";

/**
 * Fills the eval copy with the sources-b track's fake data before a run (pnpm jack:eval:prepare), from
 * the Twitch and Instagram fakes (`pnpm jack:fakes` must be running; prepare sets JACK_FAKES=all). The
 * clients run with the fakes' own credentials and keep their tokens in memory, so nothing touches the
 * copy's SystemSetting rows or connector switches. Safe to run again, and never overwrites a number
 * that's already there (a real one, once the copy comes from a production with these connectors on).
 */

const DAY = 86_400_000;
const MINUTE = 60_000;

async function requireFakes(): Promise<void> {
  const { fakesOrigin } = await import("../../../src/server/connectors/base-url");
  const origin = fakesOrigin();
  const up = await fetch(`${origin}/_health`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.ok, () => false);
  if (!up) throw new Error(`The fakes server isn't answering at ${origin}: start it with \`pnpm jack:fakes\` (from apps/platform), then run prepare again.`);
}

/** A made-up but steady viewer count for minute `m` of a stream: a rise, a plateau and a tail */
export function fakeViewers(seed: number, m: number, minutes: number): number {
  const base = 12 + (seed % 23);
  const shape = m < 15 ? m / 15 : m > minutes - 10 ? Math.max(0.3, (minutes - m) / 10) : 1;
  return Math.max(1, Math.round(base * shape + ((seed + m * 7) % 5) - 2));
}

async function seedTwitch({ prisma, now }: SeedContext): Promise<string> {
  await requireFakes();
  const { twitchApi } = await import("../../../src/server/connectors/twitch/client");
  const { twitchClient } = await import("../../../src/server/connectors/twitch/connector");
  const { TWITCH_FAKE } = await import("../../../src/server/connectors/twitch/fake/handlers");
  const { recordVideos } = await import("../../../src/server/connectors/twitch/streams");
  const { memoryTwitchTokens } = await import("../../../src/server/connectors/twitch/tokens");
  const { chicagoDay } = await import("../../../src/lib/dates");

  const env = { ...process.env, TWITCH_CLIENT_ID: TWITCH_FAKE.clientId, TWITCH_CLIENT_SECRET: TWITCH_FAKE.clientSecret, TWITCH_BROADCASTER_ID: TWITCH_FAKE.broadcasterId };
  // The club account's grant, through the fake's consent page (it signs in as the club right away)
  const api = twitchApi({ clientId: TWITCH_FAKE.clientId, clientSecret: TWITCH_FAKE.clientSecret }, env);
  const redirect = "http://localhost/eval-seed";
  const consent = await fetch(api.authorizeUrl({ redirectUri: redirect, state: "eval" }), { redirect: "manual" });
  const grant = await api.exchangeCode(new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? "", redirect);
  const client = twitchClient(env, memoryTwitchTokens({ refreshToken: grant.refresh_token }));

  // Past broadcasts from their VODs (the daily job's own code)
  const videos = await client.archiveVideos({ max: 100 });
  const { added } = await recordVideos(videos, now);

  // The fake's broadcasts come without viewer counts; give each a minute-by-minute history so questions about peak and average viewers have answers
  let sampled = 0;
  for (const video of videos) {
    if (!video.streamId || (await prisma.twitchViewerSample.count({ where: { streamId: video.streamId } }))) continue;
    const minutes = Math.max(1, Math.round(video.seconds / 60));
    const seed = Number(video.streamId.slice(-4)) || 7;
    const data = Array.from({ length: minutes }, (_, m) => ({ streamId: video.streamId!, at: new Date(video.createdAt.getTime() + m * MINUTE), viewers: fakeViewers(seed, m, minutes) }));
    await prisma.twitchViewerSample.createMany({ data, skipDuplicates: true });
    const stats = await prisma.twitchViewerSample.aggregate({ where: { streamId: video.streamId }, _avg: { viewers: true }, _max: { viewers: true } });
    await prisma.twitchStream.update({ where: { id: video.streamId }, data: { peakViewers: stats._max.viewers ?? 0, avgViewers: stats._avg.viewers } });
    sampled++;
  }

  // Today's follower total from the fake, and 30 made-up days before it, rising to it
  const total = await client.followerTotal();
  const today = chicagoDay(now);
  const days = Array.from({ length: 31 }, (_, d) => ({ date: new Date(today.getTime() - d * DAY), followers: total - Math.round(d * 0.7) }));
  const { count: followerDays } = await prisma.twitchChannelDaily.createMany({ data: days, skipDuplicates: true });
  return `${videos.length} past broadcasts (${added} new, ${sampled} given viewer counts), ${total} followers (${followerDays} new days)`;
}

async function seedInstagram({ prisma, now }: SeedContext): Promise<string> {
  await requireFakes();
  const { instagramGraph } = await import("../../../src/server/connectors/instagram/graph");
  const { instagramInsights } = await import("../../../src/server/connectors/instagram/insights");
  const { INSTAGRAM_FAKE } = await import("../../../src/server/connectors/instagram/fake/handlers");
  const { chicagoDay } = await import("../../../src/lib/dates");

  // The fake's own token, never the copy's stored one
  const insights = instagramInsights(instagramGraph(INSTAGRAM_FAKE.token));
  const profile = await insights.profile();
  const today = chicagoDay(now);

  // 30 days of snapshots: today's follower count from the fake, made-up counts before it; then each complete day's numbers from the fake, where none are stored
  const days = Array.from({ length: 31 }, (_, d) => ({ date: new Date(today.getTime() - d * DAY), followers: profile.followers - Math.round(d * 1.3) }));
  await prisma.instagramAccountDaily.createMany({ data: days, skipDuplicates: true });
  const empty = await prisma.instagramAccountDaily.findMany({ where: { date: { gte: new Date(today.getTime() - 30 * DAY), lt: today }, reach: null }, select: { date: true } });
  for (const { date } of empty) await prisma.instagramAccountDaily.update({ where: { date }, data: await insights.accountDay(profile.userId, date) });

  // Every post the copy has (the feed sync's) and no numbers yet: the fake answers any real-looking media id
  const posts = await prisma.instagramPost.findMany({ where: { insightsAt: null }, select: { id: true } });
  let read = 0;
  for (const post of posts) {
    try {
      await prisma.instagramPost.update({ where: { id: post.id }, data: { ...(await insights.post(post.id)), insightsAt: now } });
      read++;
    } catch {
      // A post the fake says doesn't exist keeps no numbers
    }
  }
  return `${empty.length} days of account numbers, ${read} of ${posts.length} posts given numbers, ${profile.followers} followers`;
}

export const SEEDERS: EvalSeeder[] = [
  { name: "twitch: past streams, viewers and followers", run: seedTwitch },
  { name: "instagram: account days and post insights", run: seedInstagram },
];
