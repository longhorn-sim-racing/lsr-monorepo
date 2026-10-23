import type { EvalSeeder } from "./types";

/** The fake server's channels the eval copy syncs (everything but the voice channel; the officers' channel is hidden from the bot) */
const SYNCED = ["general", "announcements", "lscChat", "setups"] as const;

/**
 * Fills the eval copy with the discord-read track's fake data before a run (pnpm jack:eval:prepare):
 * the real sync, against the Discord fake (`pnpm jack:fakes` must be running), with the fake's own keys
 * whatever the environment says. It opts the fake's public channels in and switches the `discord`
 * connector on in the eval copy, so search and the Discord tools answer there (the eval's process needs
 * JACK_FAKES and the fake's DISCORD_* values too; see docs/jack-2/tracks/discord-read.md). Safe to run
 * again: the sync only adds what's new.
 */
export const SEEDERS: EvalSeeder[] = [
  {
    name: "discord: channels, messages, members and polls",
    async run({ prisma, log }) {
      const [{ discordClient }, { FAKE_CHANNELS, FAKE_DISCORD }, { prismaDiscordStore }, { refreshChannels, rescan, syncMembers, syncMessages }] = await Promise.all([
        import("../../../src/server/connectors/discord/client"),
        import("../../../src/server/connectors/discord/fake/data"),
        import("../../../src/server/connectors/discord/store"),
        import("../../../src/server/connectors/discord/sync"),
      ]);
      const ctx = { client: discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId }), store: prismaDiscordStore };
      const { channels } = await refreshChannels(ctx);
      await prisma.discordChannel.updateMany({ where: { id: { in: SYNCED.map((key) => FAKE_CHANNELS[key]) } }, data: { synced: true } });
      const messages = await syncMessages(ctx, { backfillDays: 60 });
      const again = await rescan(ctx);
      const members = await syncMembers(ctx);
      await prisma.connectorState.upsert({ where: { id: "discord" }, update: { enabled: true }, create: { id: "discord", enabled: true } });
      if (messages.problems.length || again.problems.length) log(`Couldn't read: ${[...messages.problems, ...again.problems].map((p) => p.channel).join(", ")}`);
      return `${channels.filter((c) => !c.parentId).length} channels, ${messages.added} new messages, ${members.memberCount} members; discord switched on in the eval copy`;
    },
  },
];
