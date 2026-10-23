/**
 * LOCAL ONLY: checks the sources-b database work (Jack 2.0 T5: Twitch and Instagram insights) against
 * the local database, where the unit tests only see a mocked Prisma: the EventSub message dedupe, a
 * stream's life (open, samples, close, VOD backfill, live only while seen lately, counted after its
 * samples are pruned), the row lock on the Twitch setting (five refreshes at once make one, revoked
 * webhooks), Central dates on the daily tables, and that the pages' and tools' reads run as SQL
 * (sorting with NULLs last, case-insensitive caption search).
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-sources-b.ts
 *
 * Refuses unless DATABASE_URL points at 127.0.0.1 or localhost. It writes only rows it creates and
 * deletes at the end, pass or fail: 1999 dates and throwaway ids, the Twitch setting under a throwaway
 * key, and one throwaway Instagram post. It never runs a whole job (those stamp the connectors' last
 * sync and read every due post), only the parts that take the rows to work on.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
}

const MINUTE = 60_000;
const DAY = 86_400_000;

async function main() {
  const { localDatabaseProblem } = await import("../src/server/jack/eval-support");
  const problem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL);
  if (problem) {
    console.error(`Refusing to run: ${problem}`);
    process.exit(1);
  }

  const { prisma } = await import("../src/server/db");
  const { claimEventSubMessage } = await import("../src/server/connectors/twitch/webhook");
  const streams = await import("../src/server/connectors/twitch/streams");
  const tokens = await import("../src/server/connectors/twitch/tokens");
  const { postsDueForInsights, readPostInsights, snapshotInstagramAccount } = await import("../src/server/connectors/instagram/sync");
  const twitchQueries = await import("../src/server/queries/twitch");
  const instagramQueries = await import("../src/server/queries/instagram-insights");

  const tag = `check-sources-b-${randomBytes(4).toString("hex")}`;
  const streamId = `${tag}-stream`;
  const vodStreamId = `${tag}-vod`;
  const postId = `${tag}-post`;
  // Not "twitch": the real setting (the app token, the club account's grant) is never touched
  const settingKey = `${tag}-twitch`;
  const start = new Date("1999-10-22T23:00:00Z");
  const days = [new Date("1999-10-19T00:00:00Z"), new Date("1999-10-20T00:00:00Z"), new Date("1999-10-21T00:00:00Z"), new Date("1999-10-22T00:00:00Z")];

  try {
    // --- EventSub dedupe ---
    check("a new EventSub message id is claimed", (await claimEventSubMessage(`${tag}-msg`, "notification")) === true);
    check("the same id again is a resend", (await claimEventSubMessage(`${tag}-msg`, "notification")) === false);

    // --- a stream's life ---
    const opened = await streams.recordStreamOnline({ id: streamId, startedAt: start });
    check("stream.online opens a row", opened.created && (await prisma.twitchStream.findUnique({ where: { id: streamId } }))?.endedAt === null);
    check("a second stream.online for it changes nothing", !(await streams.recordStreamOnline({ id: streamId, startedAt: start, title: "other" })).created);
    await streams.updateStreamDetails(streamId, { title: "Check stream", gameName: "iRacing" });
    for (const [m, viewers] of [[1, 10], [2, 30], [3, 20]] as const) await streams.recordViewerSample(streamId, new Date(start.getTime() + m * MINUTE + 5_000), viewers);
    await streams.recordViewerSample(streamId, new Date(start.getTime() + 3 * MINUTE + 40_000), 99);
    let row = await prisma.twitchStream.findUnique({ where: { id: streamId } });
    check("samples: one per minute (the same minute again is skipped)", (await prisma.twitchViewerSample.count({ where: { streamId } })) === 3);
    check("peak and running average come from the samples", row?.peakViewers === 30 && row?.avgViewers === 20, JSON.stringify(row));
    const lastSeen = await streams.streamLastSeen({ id: streamId, startedAt: start });
    check(
      "an open stream is live only while seen lately (its last sample)",
      lastSeen.getTime() === start.getTime() + 3 * MINUTE && streams.seenLately(lastSeen, new Date(start.getTime() + 5 * MINUTE)) && !streams.seenLately(lastSeen, new Date()) && (await streams.currentLiveStream())?.id !== streamId,
      lastSeen.toISOString(),
    );
    const closed = await streams.closeStreams({ endedAt: new Date(start.getTime() + 4 * MINUTE), id: streamId });
    row = await prisma.twitchStream.findUnique({ where: { id: streamId } });
    check("stream.offline closes it once", closed === 1 && row?.endedAt?.getTime() === start.getTime() + 4 * MINUTE && (await streams.closeStreams({ endedAt: new Date(), id: streamId })) === 0);
    await streams.updateStreamDetails(streamId, { title: "Renamed after closing", gameName: null });
    check("a closed stream's title stays", (await prisma.twitchStream.findUnique({ where: { id: streamId } }))?.title === "Check stream");

    const recorded = await streams.recordVideos(
      [
        { id: `${tag}-v1`, streamId, title: "Check stream", createdAt: start, seconds: 240, views: 12, url: "https://www.twitch.tv/videos/1" },
        { id: `${tag}-v2`, streamId: vodStreamId, title: "Older broadcast", createdAt: new Date(start.getTime() - 3 * DAY), seconds: 3_600, views: 40, url: "https://www.twitch.tv/videos/2" },
      ],
      new Date(start.getTime() + DAY),
    );
    const backfilled = await prisma.twitchStream.findUnique({ where: { id: vodStreamId } });
    check("a VOD fills in its stream and adds one it hadn't seen", recorded.updated === 1 && recorded.added === 1 && backfilled?.endedAt?.getTime() === start.getTime() - 3 * DAY + 3_600_000 && backfilled?.peakViewers === 0);
    const since = await streams.streamsWentLiveSince(new Date(start.getTime() - 4 * DAY), 50);
    check("streamsWentLiveSince lists them oldest first", since.filter((s) => s.id.startsWith(tag)).map((s) => s.id).join() === [vodStreamId, streamId].join());
    const summaries = await twitchQueries.listStreams({ from: new Date(start.getTime() - 4 * DAY), to: new Date(start.getTime() + DAY), now: start });
    const sampled = summaries.find((s) => s.id === streamId);
    const unsampled = summaries.find((s) => s.id === vodStreamId);
    check("the streams list knows which streams had viewers counted", sampled?.sampled === true && sampled.peakViewers === 30 && unsampled?.sampled === false && unsampled.peakViewers === null);
    // housekeeping.twitch-samples prunes samples after 180 days; the stream's numbers stay
    await prisma.twitchViewerSample.deleteMany({ where: { streamId } });
    const pruned = await twitchQueries.findStream(streamId, start);
    check("a stream whose samples were pruned still counts as counted, with its peak and average", pruned?.sampled === true && pruned.peakViewers === 30 && pruned.avgViewers === 20, JSON.stringify(pruned));
    const overview = await twitchQueries.twitchOverview(new Date());
    check("the overview query runs", typeof overview.last30.streams === "number");

    // --- the row lock on the Twitch setting (a throwaway key) ---
    await prisma.systemSetting.create({ data: { key: settingKey, value: JSON.stringify({ user: { accessToken: "old", refreshToken: "r0", expiresAt: new Date(Date.now() - 1).toISOString(), login: "check", userId: "1", scopes: [], connectedAt: new Date().toISOString(), connectedById: null } }) } });
    let refreshes = 0;
    const api = {
      async refreshUserToken(refreshToken: string) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 150));
        return { access_token: `new-${refreshes}`, refresh_token: `${refreshToken}-r${refreshes}`, expires_in: 14_000, token_type: "bearer" };
      },
    } as unknown as Parameters<typeof tokens.settingsTwitchTokens.user>[0];
    const source = tokens.settingsTwitchTokensFor(settingKey);
    const got = await Promise.all(Array.from({ length: 5 }, () => source.user(api)));
    const stored = await tokens.readTwitchSettings(settingKey);
    check("five calls with an expired token refresh it once, under the row lock", refreshes === 1 && new Set(got).size === 1 && got[0] === "new-1", `refreshes=${refreshes} tokens=${[...new Set(got)].join(",")}`);
    check("the rotated refresh token is stored", stored.user?.refreshToken === "r0-r1");
    await tokens.recordEventSubRevoked({ type: "stream.online", status: "notification_failures_exceeded", at: new Date().toISOString() }, settingKey);
    const revoked = await tokens.readTwitchSettings(settingKey);
    const cleared = await tokens.clearEventSubRevoked("stream.online", settingKey);
    const after = await tokens.readTwitchSettings(settingKey);
    check("a revoked webhook is kept next to the grant, and cleared again", revoked.eventsubRevoked?.length === 1 && revoked.user?.refreshToken === "r0-r1" && cleared && !after.eventsubRevoked && after.user?.refreshToken === "r0-r1");

    // --- Instagram: Central dates and the snapshot ---
    const lateEvening = new Date("1999-10-23T03:30:00Z"); // 10:30 PM Central on Oct 22
    await prisma.instagramAccountDaily.createMany({ data: days.slice(0, 3).map((date) => ({ date, followers: 100 })) });
    const fakeInsights = {
      userId: "17841400000000000",
      username: "check",
      profile: async () => ({ userId: "17841400000000000", username: "check", followers: 123, follows: 1, mediaCount: 1 }),
      accountDay: async (_id: string, day: Date) => ({ reach: day.getUTCDate(), views: 2, accountsEngaged: 3, totalInteractions: 4, follows: 5, unfollows: 6 }),
      post: async () => ({ reach: 7, likes: 8, comments: 9, saved: null, shares: 10, views: 11 }),
    };
    await snapshotInstagramAccount({ client: fakeInsights, now: lateEvening });
    const accountRows = await prisma.instagramAccountDaily.findMany({ where: { date: { gte: days[0], lte: days[3] } }, orderBy: { date: "asc" } });
    check("today's row is the Central date (Oct 22 at 10:30 PM CT)", accountRows.at(-1)?.date.toISOString() === "1999-10-22T00:00:00.000Z" && accountRows.at(-1)?.followers === 123, JSON.stringify(accountRows.map((r) => r.date)));
    check("the 3 days before get their numbers", accountRows.slice(0, 3).every((r) => r.reach === r.date.getUTCDate() && r.unfollows === 6), JSON.stringify(accountRows));

    await prisma.instagramPost.create({ data: { id: postId, permalink: "https://www.instagram.com/p/CHECK/", caption: "Check POST about Lone Star", mediaType: "IMAGE", postedAt: new Date(Date.now() - DAY) } });
    check("a never-read post is due for insights", (await postsDueForInsights(new Date(), 10_000)).some((p) => p.id === postId));
    // Only our post: the hourly job would read (and write) every due post
    const postRun = await readPostInsights([{ id: postId }], { client: fakeInsights, now: new Date() });
    const post = await prisma.instagramPost.findUnique({ where: { id: postId } });
    check("post insights are stored, null where Instagram gave none", postRun.counts?.updated === 1 && post?.reach === 7 && post.saved === null && post.insightsAt !== null);
    const sorted = await instagramQueries.listPostInsights({ sort: "saved", match: "check post", limit: 5 });
    check("posts sort by a number with nulls last, and caption search ignores case", sorted.some((p) => p.id === postId));
    const insights = await instagramQueries.instagramInsightsOverview(new Date());
    check("the Instagram overview query runs", typeof insights.week.days === "number");
  } finally {
    await prisma.twitchEventSubMessage.deleteMany({ where: { id: { startsWith: tag } } });
    await prisma.twitchStream.deleteMany({ where: { id: { startsWith: tag } } });
    await prisma.instagramPost.deleteMany({ where: { id: postId } });
    await prisma.instagramAccountDaily.deleteMany({ where: { date: { gte: days[0], lte: days[3] } } });
    await prisma.systemSetting.deleteMany({ where: { key: settingKey } });
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
