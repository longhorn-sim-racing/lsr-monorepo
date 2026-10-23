/**
 * LOCAL ONLY: checks the Discord sync (Jack 2.0 discord-read track) against the local database, where
 * the unit tests only see an in-memory store: the real sync runs against the Discord HTTP fake (answered
 * in this process, no server needed) into the real tables, then the queries the page, the Overview card
 * and Jack's tools read, the SQL behind them (threads counted in their channel, deleted rows left out,
 * open polls), a deletion noticed by the re-scan, and a purge that sticks: thread titles included, and
 * against sync writes in progress (the purge lock, both ways), with two purges at once keeping both.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-discord-read.ts
 *
 * Refuses unless DATABASE_URL points at 127.0.0.1 or localhost. It writes only the fake server's rows
 * (its own channel, message and member ids), puts back the DiscordDailyStat and DiscordGuildDaily rows
 * of the days it touched and the purged list as they were, and deletes its audit entries, pass or fail.
 * It never touches ConnectorState.
 */
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

// Quiet Prisma (it logs every query outside production)
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const FAKES_ORIGIN = "http://127.0.0.1:3999";
// Only the Discord client goes to the fake, answered in this process
process.env.JACK_FAKES = "discord";
process.env.JACK_FAKES_URL = FAKES_ORIGIN;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
}

async function main() {
  const { localDatabaseProblem } = await import("../src/server/jack/eval-support");
  const problem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL);
  if (problem) {
    console.error(`Refusing to run: ${problem}`);
    process.exit(1);
  }

  const { prisma } = await import("../src/server/db");
  const { createFakeRouter } = await import("../src/server/connectors/fakes/router");
  const { discordFake } = await import("../src/server/connectors/discord/fake/handlers");
  const { FAKE_CHANNELS, FAKE_DISCORD } = await import("../src/server/connectors/discord/fake/data");
  const { discordClient } = await import("../src/server/connectors/discord/client");
  const { lockPurgedListTx, prismaDiscordStore, PURGE_LOCK, PURGED_SETTING, purgedFrom, readPurged } = await import("../src/server/connectors/discord/store");
  const { purgedHash } = await import("../src/server/connectors/discord/metadata");
  const { randomBytes } = await import("node:crypto");
  const sync = await import("../src/server/connectors/discord/sync");
  const queries = await import("../src/server/queries/discord");
  const { purgeDiscordData } = await import("../src/server/services/discord-link.service");
  const { pruneDiscord } = await import("../src/server/scheduler/jobs/discord-read");

  // The fake, in-process: requests to its origin are answered by its routes, anything else is refused
  const router = createFakeRouter([discordFake]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== FAKES_ORIGIN) throw new Error(`check-discord-read only talks to the fake, not ${new URL(request.url).origin}`);
    return router(request);
  };
  const hook = (method: string, path: string, body?: unknown) => fetch(`${FAKES_ORIGIN}/discord/_fake/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  const client = discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId });
  const ctx = { client, store: prismaDiscordStore };
  const state = (await (await hook("GET", "state")).json()) as { channels: { id: string }[] };
  const channelIds = state.channels.map((c) => c.id);
  const memberIds = (await client.members({ limit: 1000 })).map((m) => m.user.id);
  const now = new Date();
  const days = sync.daysBetween(new Date(now.getTime() - 70 * 86_400_000), now);
  const actor = await prisma.user.findFirst({ select: { id: true } });

  const cleanFakeRows = async () => {
    // Threads under the fake's channels too, whatever their ids
    const threads = (await prisma.discordChannel.findMany({ where: { parentId: { in: channelIds } }, select: { id: true } })).map((t) => t.id);
    const ids = [...new Set([...channelIds, ...threads])];
    await prisma.discordMessage.deleteMany({ where: { channelId: { in: ids } } });
    await prisma.discordChannel.deleteMany({ where: { id: { in: ids } } });
    await prisma.discordMember.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.discordDailyStat.deleteMany({ where: { channelId: { in: channelIds } } });
  };
  // What this check may overwrite: the days' stats, the guild days, the purged list
  await cleanFakeRows();
  const savedStats = await prisma.discordDailyStat.findMany({ where: { date: { in: days } } });
  const savedGuild = await prisma.discordGuildDaily.findMany({ where: { date: { in: days } } });
  const savedPurged = await prisma.systemSetting.findUnique({ where: { key: PURGED_SETTING } });
  const purgeReferences: string[] = [];

  try {
    const { channels } = await sync.refreshChannels(ctx);
    const general = channels.find((c) => c.id === FAKE_CHANNELS.general);
    check("new channels arrive switched off, with their category", general?.synced === false && general.parentName === "Club", JSON.stringify(general));
    check("no thread is kept from a channel that isn't opted in", !channels.some((c) => c.parentId === FAKE_CHANNELS.setups), JSON.stringify(channels.map((c) => c.name)));

    await prisma.discordChannel.updateMany({ where: { id: { in: [FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat, FAKE_CHANNELS.setups] } }, data: { synced: true } });
    const first = await sync.syncMessages(ctx, { backfillDays: 60 });
    const thread = await prisma.discordChannel.findFirst({ where: { parentId: FAKE_CHANNELS.setups } });
    check("an active thread is stored under its channel once that's opted in", thread?.id === FAKE_CHANNELS.monzaThread, JSON.stringify(thread));
    const monzaOwner = (await client.activeThreads()).threads.find((t) => t.id === FAKE_CHANNELS.monzaThread)?.owner_id;
    check("with who started it", Boolean(monzaOwner) && thread?.ownerId === monzaOwner, JSON.stringify({ monzaOwner, ownerId: thread?.ownerId }));
    const stored = await prisma.discordMessage.count({ where: { channelId: { in: channelIds } } });
    check("the sync stores the opted-in channels' messages", first.added > 50 && first.added === stored && first.problems.length === 0, JSON.stringify(first));
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'DiscordMessage'`;
    check("DiscordMessage has no column for text", !columns.some((c) => /content$|text|body/i.test(c.column_name)), columns.map((c) => c.column_name).join(", "));
    const announcements = await prisma.discordMessage.count({ where: { channelId: FAKE_CHANNELS.announcements } });
    check("a channel that isn't opted in isn't read", announcements === 0);
    const sample = { id: "1300000000000000001", channelId: FAKE_CHANNELS.announcements, authorId: "1300000000000000002", createdAt: now, editedAt: null, contentLength: 1, attachments: 0, isReply: false, poll: null, lastSeenAt: now };
    const refused = await prismaDiscordStore.savePage(FAKE_CHANNELS.announcements, { insert: [sample], cursor: { lastMessageId: sample.id } });
    const announcementsRow = await prisma.discordChannel.findUnique({ where: { id: FAKE_CHANNELS.announcements } });
    check("a page for a channel that isn't opted in writes nothing", refused === null && !(await prisma.discordMessage.findUnique({ where: { id: sample.id } })) && announcementsRow?.lastMessageId === null, JSON.stringify(refused));
    const threadPage = await prismaDiscordStore.savePage(FAKE_CHANNELS.monzaThread, { cursor: { lastSyncedAt: now } });
    check("a thread's page is written while its channel is opted in", threadPage?.added === 0, JSON.stringify(threadPage));

    const again = await sync.syncMessages(ctx, { backfillDays: 60 });
    check("a second sync adds nothing", again.added === 0, JSON.stringify(again));

    const fakeStats = await prisma.discordDailyStat.findMany({ where: { channelId: { in: channelIds } } });
    const threadMessages = thread ? await prisma.discordMessage.count({ where: { channelId: thread.id } }) : 0;
    check("daily stats count threads toward their channel", fakeStats.some((s) => s.channelId === FAKE_CHANNELS.setups) && !fakeStats.some((s) => s.channelId === thread?.id) && threadMessages > 0);
    const statTotal = fakeStats.reduce((n, s) => n + s.messages, 0);
    check("daily stats add up to the stored messages", statTotal === stored, `${statTotal} vs ${stored}`);

    const polls = await prismaDiscordStore.openPolls(new Date(), 10);
    check("the open poll is found by the JSON query", polls.some((p) => p.poll.question === "Next LSC track?"), JSON.stringify(polls.map((p) => p.poll.question)));

    // A deletion inside the re-scan window
    const recent = await prisma.discordMessage.findFirst({ where: { channelId: FAKE_CHANNELS.general, createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } }, orderBy: { createdAt: "desc" } });
    if (recent) await hook("DELETE", `messages/${FAKE_CHANNELS.general}/${recent.id}`);
    const rescan = await sync.rescan(ctx);
    const gone = recent ? await prisma.discordMessage.findUnique({ where: { id: recent.id } }) : null;
    check("the re-scan marks a deleted message", Boolean(gone?.deletedAt) && rescan.deleted === 1, JSON.stringify(rescan));
    const afterStats = await prisma.discordDailyStat.aggregate({ where: { channelId: { in: channelIds } }, _sum: { messages: true } });
    check("and the day's count drops", afterStats._sum.messages === statTotal - 1, String(afterStats._sum.messages));

    // A member deletes their forum post: the re-scan drops the thread and its messages, and doesn't fail
    const monzaMessages = await prisma.discordMessage.count({ where: { channelId: FAKE_CHANNELS.monzaThread } });
    await hook("DELETE", `channels/${FAKE_CHANNELS.monzaThread}`);
    const dropped = await sync.rescan(ctx);
    const monzaLeft = await prisma.discordMessage.count({ where: { channelId: FAKE_CHANNELS.monzaThread } });
    check(
      "a thread deleted in Discord is dropped with its messages, without a problem",
      monzaMessages > 0 && dropped.threadsGone === 1 && dropped.problems.length === 0 && monzaLeft === 0 && !(await prisma.discordChannel.findUnique({ where: { id: FAKE_CHANNELS.monzaThread } })),
      JSON.stringify({ monzaMessages, monzaLeft, dropped }),
    );
    const setupsStats = await prisma.discordDailyStat.aggregate({ where: { channelId: FAKE_CHANNELS.setups }, _sum: { messages: true } });
    check("and its channel's daily counts drop with it", (setupsStats._sum.messages ?? 0) === (await prisma.discordMessage.count({ where: { channelId: FAKE_CHANNELS.spaThread, deletedAt: null } })), JSON.stringify(setupsStats));

    const members = await sync.syncMembers(ctx);
    check("the member sync stores the members, never the bot", members.memberCount >= 40 && !(await prisma.discordMember.findUnique({ where: { id: FAKE_DISCORD.botUserId } })), JSON.stringify(members));

    const activity = await queries.discordActivity({ days: 30, now });
    const general30 = activity.channels.find((c) => c.id === FAKE_CHANNELS.general);
    check("discordActivity reads the totals and distinct members", Boolean(general30 && general30.messages > 0 && general30.activeMembers > 0 && activity.activeMembers >= general30.activeMembers), JSON.stringify(general30));
    const week = await queries.discordWeek(now);
    check("discordWeek reads this week", week.messages > 0 && week.memberCount !== null, JSON.stringify(week));
    const pollList = await queries.discordPolls({ days: 90, limit: 10, now });
    check("discordPolls reads the polls with their counts", pollList.polls.some((p) => p.poll.question === "Next LSC track?" && p.status === "open" && p.totalVotes === 22), JSON.stringify(pollList.polls.map((p) => [p.poll.question, p.status, p.totalVotes])));
    const channelRows = await queries.discordChannels(now);
    check("discordChannels lists channels, not threads", channelRows.some((c) => c.id === FAKE_CHANNELS.setups && c.threads >= 1) && !channelRows.some((c) => c.id === thread?.id));

    // A purge: everything about one author goes, and the next sync doesn't bring it back
    const author = await prisma.discordMessage.findFirst({ where: { channelId: FAKE_CHANNELS.general, deletedAt: null }, select: { authorId: true } });
    if (author && actor) {
      const result = await purgeDiscordData(author.authorId, { userId: actor.id });
      purgeReferences.push(result.reference);
      const left = await prisma.discordMessage.count({ where: { authorId: author.authorId } });
      check("a purge deletes the author's messages and member row", result.messages > 0 && left === 0 && !(await prisma.discordMember.findUnique({ where: { id: author.authorId } })), JSON.stringify(result));
      const entry = await prisma.auditLog.findFirst({ where: { entityType: "DISCORD_MEMBER", entityId: result.reference } });
      check("the purge's audit entry names neither the account nor its hash", Boolean(entry) && !JSON.stringify(entry).includes(author.authorId), JSON.stringify(entry));
      await prisma.discordChannel.updateMany({ where: { id: { in: channelIds } }, data: { lastMessageId: null } });
      await sync.syncMessages(ctx, { backfillDays: 60 });
      await sync.syncMembers(ctx);
      check("and a fresh sync never collects them again", (await prisma.discordMessage.count({ where: { authorId: author.authorId } })) === 0 && !(await prisma.discordMember.findUnique({ where: { id: author.authorId } })));
    } else check("a purge (needs a user to act as)", false, "no user in the local database");

    // Fake accounts no local user has linked (a purge unlinks), and not purged above
    const free: string[] = [];
    for (const id of memberIds) {
      if (id === FAKE_DISCORD.botUserId || id === author?.authorId) continue;
      if (!(await prisma.user.findUnique({ where: { discordUserId: id }, select: { id: true } }))) free.push(id);
    }

    // A thread's starter purged: the thread stays (others' replies still count) as "a thread", and later syncs keep it so
    const spa = await prisma.discordChannel.findUnique({ where: { id: FAKE_CHANNELS.spaThread } });
    const spaOwner = (await client.archivedThreads(FAKE_CHANNELS.setups)).threads.find((t) => t.id === FAKE_CHANNELS.spaThread)?.owner_id ?? null;
    check("an archived thread is stored with who started it", Boolean(spa && spaOwner && spa.ownerId === spaOwner && spa.name === "Spa wet setup"), JSON.stringify({ spa, spaOwner }));
    if (spaOwner && free.includes(spaOwner) && actor) {
      const result = await purgeDiscordData(spaOwner, { userId: actor.id });
      purgeReferences.push(result.reference);
      const renamed = await prisma.discordChannel.findUnique({ where: { id: FAKE_CHANNELS.spaThread } });
      check("a purge removes the titles of threads they started and keeps the threads", result.threads === 1 && renamed?.name === "a thread" && renamed.ownerId === null, JSON.stringify({ result, renamed }));
      await sync.syncMessages(ctx, { backfillDays: 60 });
      await sync.rescan(ctx);
      const after = await prisma.discordChannel.findUnique({ where: { id: FAKE_CHANNELS.spaThread } });
      check("and the sync and re-scan never write the title back", after?.name === "a thread" && after.ownerId === null, JSON.stringify(after));
    } else console.log("SKIP  a purge of a thread's starter  (no user to act as, or the starter is linked to a local account)");

    // The purge lock, in Postgres. A purge in progress (holding it exclusively, the account deleted and listed but not
    // committed yet): a page, a member list and a thread written meanwhile wait for it, then leave the account out
    const [late, both1, both2] = free.filter((id) => id !== spaOwner).slice(-3);
    if (late && both1 && both2 && actor) {
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      let committedAt = 0;
      const purge = prisma.$transaction(
        async (tx) => {
          await lockPurgedListTx(tx);
          await tx.discordMessage.deleteMany({ where: { authorId: late } });
          await tx.discordMember.deleteMany({ where: { id: late } });
          const purged = readPurged((await tx.systemSetting.findUnique({ where: { key: PURGED_SETTING } }))?.value);
          const key = purged.key ?? randomBytes(32).toString("base64url");
          const value = JSON.stringify({ key, authors: [...purged.authors, purgedHash(key, late)] });
          await tx.systemSetting.upsert({ where: { key: PURGED_SETTING }, update: { value }, create: { key: PURGED_SETTING, value } });
          held();
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          committedAt = Date.now();
        },
        { timeout: 20_000 },
      );
      await holding;
      const timed = async <T>(write: Promise<T>) => ({ value: await write, at: Date.now() });
      const lateRow = { ...sample, id: "1300000000000000011", channelId: FAKE_CHANNELS.general, authorId: late };
      const lateThread = { id: "1300000000000000012", name: "Late thread title", type: 11, parentId: FAKE_CHANNELS.setups, parentName: "setups", ownerId: late };
      const [page, members, threads] = await Promise.all([
        timed(prismaDiscordStore.savePage(FAKE_CHANNELS.general, { insert: [lateRow] })),
        timed(prismaDiscordStore.saveMembers([{ id: late, username: "late.member", displayName: null, joinedAt: null, roles: [] }], now)),
        timed(prismaDiscordStore.saveChannels([lateThread])),
      ]);
      await purge;
      const waited = [page.at, members.at, threads.at].every((at) => at >= committedAt);
      check("sync writes wait for a purge in progress", waited, JSON.stringify({ committedAt, page: page.at, members: members.at, threads: threads.at }));
      const lateThreadRow = await prisma.discordChannel.findUnique({ where: { id: lateThread.id } });
      check(
        "then leave the purged account out: no message, no member row, and its thread untitled",
        page.value?.added === 0 &&
          !(await prisma.discordMessage.findUnique({ where: { id: lateRow.id } })) &&
          members.value.joined === 0 &&
          !(await prisma.discordMember.findUnique({ where: { id: late } })) &&
          lateThreadRow?.name === "a thread" &&
          lateThreadRow.ownerId === null,
        JSON.stringify({ page: page.value, members: members.value, lateThreadRow }),
      );

      // The other way: a sync write in progress (holding it shared); two purges wait for it, and for each other, keeping both on the list
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      let writeDoneAt = 0;
      const write = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${PURGE_LOCK}))`;
          entered();
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          writeDoneAt = Date.now();
        },
        { timeout: 20_000 },
      );
      await inside;
      const purges = await Promise.all([both1, both2].map((id) => purgeDiscordData(id, { userId: actor.id })));
      const purgedAt = Date.now();
      await write;
      purgeReferences.push(...purges.map((p) => p.reference));
      check("a purge waits for a sync write in progress", writeDoneAt > 0 && purgedAt >= writeDoneAt, JSON.stringify({ writeDoneAt, purgedAt }));
      const list = purgedFrom((await prisma.systemSetting.findUnique({ where: { key: PURGED_SETTING } }))?.value);
      check("two purges at once both stay on the list (with the ones before)", list.has(both1) && list.has(both2) && list.has(late), `size ${list.size}`);
    } else console.log("SKIP  the purge lock  (no user to act as, or not enough unlinked fake accounts)");

    // Switching a channel off: everything stored from it goes, its threads included
    const lscStored = await prisma.discordMessage.count({ where: { channelId: FAKE_CHANNELS.lscChat } });
    const switched = await prismaDiscordStore.switchOff(FAKE_CHANNELS.lscChat);
    const lscRow = await prisma.discordChannel.findUnique({ where: { id: FAKE_CHANNELS.lscChat } });
    check(
      "switching a channel off deletes its records and daily counts and resets it",
      switched === lscStored &&
        lscStored > 0 &&
        (await prisma.discordMessage.count({ where: { channelId: FAKE_CHANNELS.lscChat } })) === 0 &&
        (await prisma.discordDailyStat.count({ where: { channelId: FAKE_CHANNELS.lscChat } })) === 0 &&
        lscRow?.synced === false &&
        lscRow.lastMessageId === null,
      JSON.stringify({ lscStored, switched, lscRow }),
    );

    // The prune's SQL, in a transaction rolled back at the end (it deletes across the whole table): a thread
    // and a message record left under a channel that isn't opted in go; what's opted in stays
    const stray = { id: "1300000000000000003", name: "Stray thread", type: 11, parentId: FAKE_CHANNELS.announcements, parentName: "announcements", synced: false };
    await prisma.discordChannel.create({ data: stray });
    await prisma.discordMessage.create({ data: { id: "1300000000000000004", channelId: stray.id, authorId: sample.authorId, createdAt: now, lastSeenAt: now } });
    const generalBefore = await prisma.discordMessage.count({ where: { channelId: FAKE_CHANNELS.general } });
    const ROLLBACK = new Error("rollback");
    const seen: { result?: { pruned: unknown; strayThread: boolean; strayMessage: boolean; generalAfter: number } } = {};
    await prisma
      .$transaction(
        async (tx) => {
          const pruned = await pruneDiscord(tx, new Date(now.getTime() - 365 * 86_400_000));
          seen.result = {
            pruned,
            strayThread: Boolean(await tx.discordChannel.findUnique({ where: { id: stray.id } })),
            strayMessage: Boolean(await tx.discordMessage.findUnique({ where: { id: "1300000000000000004" } })),
            generalAfter: await tx.discordMessage.count({ where: { channelId: FAKE_CHANNELS.general } }),
          };
          throw ROLLBACK;
        },
        { timeout: 30_000 },
      )
      .catch((error) => {
        if (error !== ROLLBACK) throw error;
      });
    const pruned = seen.result;
    check("the prune removes what's left from channels that aren't opted in, and keeps opted-in ones", Boolean(pruned && !pruned.strayThread && !pruned.strayMessage && pruned.generalAfter === generalBefore), JSON.stringify(pruned));
    check("and the prune's transaction was rolled back", Boolean(await prisma.discordChannel.findUnique({ where: { id: stray.id } })));
  } finally {
    globalThis.fetch = realFetch;
    await cleanFakeRows();
    await prisma.discordDailyStat.deleteMany({ where: { date: { in: days } } });
    if (savedStats.length) await prisma.discordDailyStat.createMany({ data: savedStats });
    await prisma.discordGuildDaily.deleteMany({ where: { date: { in: days } } });
    if (savedGuild.length) await prisma.discordGuildDaily.createMany({ data: savedGuild });
    if (savedPurged) await prisma.systemSetting.upsert({ where: { key: PURGED_SETTING }, update: { value: savedPurged.value }, create: { key: PURGED_SETTING, value: savedPurged.value } });
    else await prisma.systemSetting.deleteMany({ where: { key: PURGED_SETTING } });
    await prisma.auditLog.deleteMany({ where: { entityType: "DISCORD_MEMBER", entityId: { in: purgeReferences } } });
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
