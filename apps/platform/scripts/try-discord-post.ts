/**
 * LOCAL ONLY: fills the local database with Discord posting data, to look at Community → Announcements and
 * the Discord page's role sync and events sections in the browser without a real bot (Jack 2.0
 * discord-post track). Run scripts/try-discord.ts first (it syncs the fake server's channels). The real
 * rule runner and event mirror run, against the Discord HTTP fake answered in this process.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/try-discord.ts
 *   pnpm --filter @lsr/platform exec tsx scripts/try-discord-post.ts            # rules, posts, mirrored events, a role rule
 *   pnpm --filter @lsr/platform exec tsx scripts/try-discord-post.ts --clean    # remove them again
 *
 * It writes: the posting channels setting (#announcements and #general), four standing rules and a role
 * sync rule (fixed ids), a sample public event ("Try: GM 2", slug try-discord-post-gm-2), the posts the
 * rules queue plus a few in every state, and DiscordEventMirror rows for the upcoming public events.
 * --clean removes all of that, every DiscordEventMirror row (only this track writes them), and the posting
 * setting. It leaves the `discord` connector as it is. Refuses unless DATABASE_URL points at 127.0.0.1 or
 * localhost.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Prisma } from "@prisma/client";

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
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const FAKES_ORIGIN = "http://127.0.0.1:3999";
process.env.JACK_FAKES = "discord";
process.env.JACK_FAKES_URL = FAKES_ORIGIN;
const CLEAN = process.argv.includes("--clean");

const RULES = {
  reminders: "7a7d1500-0000-4000-8000-00000000d801",
  newEvents: "7a7d1500-0000-4000-8000-00000000d802",
  twitch: "7a7d1500-0000-4000-8000-00000000d803",
  mirror: "7a7d1500-0000-4000-8000-00000000d804",
};
const ROLE_RULE = "7a7d1500-0000-4000-8000-00000000d805";
const EVENT_SLUG = "try-discord-post-gm-2";
const KEY = "try-discord-post:";

async function main() {
  const { localDatabaseProblem } = await import("../src/server/jack/eval-support");
  const problem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL);
  if (problem) {
    console.error(`Refusing to run: ${problem}`);
    process.exit(1);
  }
  const { prisma } = await import("../src/server/db");
  const { POSTING_SETTING } = await import("../src/server/discord-post/channels");

  const clean = async () => {
    const ruleIds = Object.values(RULES);
    const posts = await prisma.discordPost.deleteMany({ where: { OR: [{ ruleId: { in: ruleIds } }, { dedupeKey: { startsWith: KEY } }] } });
    await prisma.discordRule.deleteMany({ where: { id: { in: ruleIds } } });
    await prisma.discordRoleRule.deleteMany({ where: { id: ROLE_RULE } });
    const mirrors = await prisma.discordEventMirror.deleteMany({});
    await prisma.event.deleteMany({ where: { slug: EVENT_SLUG } });
    await prisma.systemSetting.deleteMany({ where: { key: POSTING_SETTING } });
    console.log(`Removed ${posts.count} posts, the rules, ${mirrors.count} mirrored events, the sample event and the posting channels.`);
  };
  if (CLEAN) {
    await clean();
    await prisma.$disconnect();
    return;
  }

  const { createFakeRouter } = await import("../src/server/connectors/fakes/router");
  const { discordFake } = await import("../src/server/connectors/discord/fake/handlers");
  const { FAKE_CHANNELS, FAKE_DISCORD } = await import("../src/server/connectors/discord/fake/data");
  const { discordClient } = await import("../src/server/connectors/discord/client");
  const { discordWriter } = await import("../src/server/connectors/discord/write");
  const { runDiscordRules } = await import("../src/server/discord-post/rule-runner");
  const { runEventMirror } = await import("../src/server/discord-post/event-mirror");
  const { postBody } = await import("../src/server/discord-post/compose");
  const { postNonce } = await import("../src/server/discord-post/outbox");

  const router = createFakeRouter([discordFake]);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== FAKES_ORIGIN) throw new Error(`try-discord-post only talks to the fake, not ${new URL(request.url).origin}`);
    return router(request);
  };
  const writer = discordWriter(discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId }).rest, FAKE_DISCORD.guildId);

  const channels = await prisma.discordChannel.count({ where: { id: { in: [FAKE_CHANNELS.announcements, FAKE_CHANNELS.general] } } });
  if (channels < 2) {
    console.error("The fake server's channels aren't in the database. Run scripts/try-discord.ts first.");
    process.exit(1);
  }
  await clean();
  const officer = await prisma.user.findFirst({ where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } } }, select: { id: true } });
  const now = new Date();
  const HOUR = 3_600_000;

  await prisma.systemSetting.create({ data: { key: POSTING_SETTING, value: JSON.stringify({ channels: [FAKE_CHANNELS.announcements, FAKE_CHANNELS.general] }) } });
  const start = new Date(now.getTime() + 3 * 24 * HOUR);
  start.setUTCHours(23, 30, 0, 0);
  await prisma.event.create({
    data: { slug: EVENT_SLUG, title: "Try: GM 2", summary: "Meet the teams and the new sim rigs. Pizza after.", startsAtUtc: start, endsAtUtc: new Date(start.getTime() + 2 * HOUR), timezone: "America/Chicago", status: "PUBLISHED", visibility: "public", publishedAt: new Date(now.getTime() - 60_000), registrationEnabled: true },
  });

  const cutoff = new Date(now.getTime() - 5 * 60_000);
  const lscPing = { type: "role", roleId: FAKE_DISCORD.roles.lscDriver, name: "LSC Driver" };
  await prisma.discordRule.createMany({
    data: [
      { id: RULES.reminders, kind: "event_reminder", channelId: FAKE_CHANNELS.announcements, config: { offsets: [1440, 60], series: null, ping: null }, enabled: true, cutoffAt: cutoff, createdById: officer?.id ?? null },
      { id: RULES.newEvents, kind: "new_event", channelId: FAKE_CHANNELS.announcements, config: { series: null, ping: lscPing }, enabled: true, cutoffAt: cutoff, createdById: officer?.id ?? null },
      { id: RULES.twitch, kind: "twitch_live", channelId: FAKE_CHANNELS.general, config: { ping: null }, enabled: false, cutoffAt: cutoff, createdById: officer?.id ?? null },
      { id: RULES.mirror, kind: "event_mirror", channelId: null, config: { series: null, location: "See the event page" }, enabled: true, cutoffAt: cutoff, createdById: officer?.id ?? null },
    ],
  });
  const rules = await runDiscordRules({ now, log: (line) => console.log(`  rules: ${line}`) });
  console.log(`Standing rules queued ${rules.queued} posts.`);

  type PostData = Omit<Prisma.DiscordPostUncheckedCreateInput, "id" | "nonce" | "source" | "channelId" | "content"> & { channelId?: string; content: object };
  const post = (n: number, data: PostData): Prisma.DiscordPostUncheckedCreateInput => ({
    source: "admin",
    channelId: FAKE_CHANNELS.announcements,
    dedupeKey: `${KEY}${n}`,
    createdById: officer?.id ?? null,
    approvedById: officer?.id ?? null,
    ...data,
    content: data.content as Prisma.InputJsonValue,
  });
  const rows = [
    post(1, { content: postBody({ text: "Sim lounge is open late this Friday. Bring your own wheel if you have one!" }), status: "SENT", scheduledFor: new Date(now.getTime() - 26 * HOUR), sentAt: new Date(now.getTime() - 26 * HOUR), discordMessageId: "1300000000000000901" }),
    post(2, { content: postBody({ text: "Which night works for the next practice?", poll: { question: "Practice night?", answers: ["Tuesday", "Wednesday", "Thursday"], hours: 48 } }), status: "SCHEDULED", scheduledFor: new Date(now.getTime() + 30 * HOUR) }),
    post(3, { channelId: FAKE_CHANNELS.general, content: postBody({ text: "LSC Round 3 recap is up on the site." }), status: "FAILED", scheduledFor: new Date(now.getTime() - 3 * HOUR), error: "The bot isn't allowed to post in the channel (Discord: Missing Permissions)." }),
    post(4, { content: postBody({ text: "Old draft about parking" }), status: "CANCELLED", scheduledFor: new Date(now.getTime() - 50 * HOUR), error: "Cancelled by an officer." }),
  ];
  for (const data of rows) {
    const id = randomUUID();
    await prisma.discordPost.create({ data: { ...data, id, nonce: postNonce(id) } });
  }

  const mirror = await runEventMirror(writer, { now, log: (line) => console.log(`  mirror: ${line}`) });
  const mirrored = await prisma.discordEventMirror.findMany();
  for (const [i, m] of mirrored.entries()) await fetch(`${FAKES_ORIGIN}/discord/_fake/interested`, { method: "POST", body: JSON.stringify({ eventId: m.discordEventId, count: 4 + i * 3 }) });
  await runEventMirror(writer, { now, log: () => {} });
  console.log(`Mirrored ${mirror.created} upcoming public events to the fake's Events list, with interested counts.`);

  await prisma.discordRoleRule.create({ data: { id: ROLE_RULE, roleId: FAKE_DISCORD.roles.lscDriver, condition: "lsc_driver", enabled: false, createdById: officer?.id ?? null } });
  console.log("Added a role sync rule (LSC Driver for the LSC Driver badge, off).");
  console.log("\nOpen /admin/announcements and /admin/discord. Remove it all with --clean.");
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
