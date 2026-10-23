/**
 * LOCAL ONLY: fills the local database with the Discord fake's server, to look at Community → Discord,
 * the Overview card and Members → edit in the browser without a real bot (Jack 2.0 discord-read track).
 * The real sync runs against the Discord HTTP fake, answered in this process (no fakes server needed).
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/try-discord.ts            # sync #general, #lsc-chat and #setups
 *   pnpm --filter @lsr/platform exec tsx scripts/try-discord.ts --clean    # remove every fake row again
 *
 * It writes only the fake server's rows (its own channel, message and member ids) plus the daily stats
 * and member counts of the days it covers, and leaves the `discord` connector as it is (off, so the
 * page says Discord isn't connected and shows what was synced). Refuses unless DATABASE_URL points at
 * 127.0.0.1 or localhost.
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
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const FAKES_ORIGIN = "http://127.0.0.1:3999";
process.env.JACK_FAKES = "discord";
process.env.JACK_FAKES_URL = FAKES_ORIGIN;
const CLEAN = process.argv.includes("--clean");

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
  const { prismaDiscordStore } = await import("../src/server/connectors/discord/store");
  const sync = await import("../src/server/connectors/discord/sync");

  const router = createFakeRouter([discordFake]);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== FAKES_ORIGIN) throw new Error(`try-discord only talks to the fake, not ${new URL(request.url).origin}`);
    return router(request);
  };
  const client = discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId });
  const state = (await (await fetch(`${FAKES_ORIGIN}/discord/_fake/state`)).json()) as { channels: { id: string }[] };
  const channelIds = state.channels.map((c) => c.id);
  const memberIds = (await client.members({ limit: 1000 })).map((m) => m.user.id);

  try {
    // Remove what an earlier run left, then recount the days it covered without it
    const days = sync.daysBetween(new Date(Date.now() - 70 * 86_400_000), new Date());
    await prisma.discordMessage.deleteMany({ where: { channelId: { in: channelIds } } });
    await prisma.discordChannel.deleteMany({ where: { id: { in: channelIds } } });
    await prisma.discordMember.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.discordDailyStat.deleteMany({ where: { channelId: { in: channelIds } } });
    if (CLEAN) {
      await sync.rebuildDailyStats(prismaDiscordStore, days);
      await prisma.discordGuildDaily.deleteMany({ where: { date: { in: days } } });
      console.log("Removed the fake Discord server's rows.");
      return;
    }
    const ctx = { client, store: prismaDiscordStore };
    await sync.refreshChannels(ctx);
    await prisma.discordChannel.updateMany({ where: { id: { in: [FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat, FAKE_CHANNELS.setups] } }, data: { synced: true } });
    const messages = await sync.syncMessages(ctx, { backfillDays: 60 });
    await sync.rescan(ctx);
    const members = await sync.syncMembers(ctx);
    console.log(`Synced the fake server: ${messages.added} messages in ${messages.channels} channels and ${messages.threads} thread, ${members.memberCount} members.`);
    console.log("Open /admin/discord (and /admin for the Overview card). Remove it with --clean.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
