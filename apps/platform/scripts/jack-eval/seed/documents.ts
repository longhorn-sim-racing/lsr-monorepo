import { generateKeyPairSync } from "node:crypto";
import type { EvalSeeder } from "./types";

/**
 * Fills the eval copy with the documents track's fake data (pnpm jack:eval:prepare, JACK_FAKES=all, with
 * `pnpm jack:fakes` running): the Drive fake's folder, the Graph fake's SharePoint library and Teams
 * channels, synced by the real sync code. Each run starts over (a full walk, a fresh enumeration, the
 * channels listed again), since the fakes server's change positions reset whenever it restarts; the
 * reconcile at the end removes what the fake no longer has. Then it switches google-drive, sharepoint
 * and teams on in the eval copy only, so search and read see them. Only fixture data ("Fixture …").
 */

const SYNC_BUDGET_MS = 120_000;

async function switchOn(prisma: Parameters<EvalSeeder["run"]>[0]["prisma"], ...ids: string[]) {
  for (const id of ids) await prisma.connectorState.upsert({ where: { id }, update: { enabled: true }, create: { id, enabled: true } });
}

/** A fetch error from the fakes server not running reads better as what to do */
function fakesHint(error: unknown): Error {
  const text = error instanceof Error ? `${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}` : String(error);
  return new Error(/ECONNREFUSED|fetch failed/i.test(text) ? `The fakes server isn't answering: start it with pnpm jack:fakes. (${text})` : text);
}

export const SEEDERS: EvalSeeder[] = [
  {
    name: "documents: the Google Drive folder (fake)",
    run: async ({ prisma, log }) => {
      const [{ driveClient }, { syncDrive }, { prismaDocumentStore }, { DRIVE_FAKE_ROOT_ID, DRIVE_FAKE_SA_EMAIL }, { recordConnectorSync }] = await Promise.all([
        import("../../../src/server/connectors/google-drive/client"),
        import("../../../src/server/connectors/google-drive/sync"),
        import("../../../src/server/connectors/documents/store"),
        import("../../../src/server/connectors/google-drive/fake/fixtures"),
        import("../../../src/server/connectors/state"),
      ]);
      // The fake checks the JWT's claims, not its key: any key signs for the fake account
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
      try {
        const result = await syncDrive({
          client: driveClient({ email: DRIVE_FAKE_SA_EMAIL, privateKey }),
          rootId: DRIVE_FAKE_ROOT_ID,
          store: prismaDocumentStore("drive"),
          cursor: null,
          signal: AbortSignal.timeout(SYNC_BUDGET_MS),
          deadline: Date.now() + SYNC_BUDGET_MS,
          log,
        });
        if (result.more || result.rootMissing) throw new Error("The Drive walk didn't finish");
        await recordConnectorSync("google-drive", { cursor: result.cursor });
        await switchOn(prisma, "google-drive");
        return `${result.counts.indexed + result.counts.unchanged} documents, google-drive switched on`;
      } catch (error) {
        throw fakesHint(error);
      }
    },
  },
  {
    name: "documents: SharePoint and Teams (fake Graph)",
    run: async ({ prisma, log }) => {
      const [{ graphClient }, { syncSharePoint }, { syncTeams }, { prismaDocumentStore }, { prismaTeamsStore }, { GRAPH_FAKE }, { recordConnectorSync }] = await Promise.all([
        import("../../../src/server/connectors/microsoft/graph"),
        import("../../../src/server/connectors/sharepoint/sync"),
        import("../../../src/server/connectors/teams/sync"),
        import("../../../src/server/connectors/documents/store"),
        import("../../../src/server/connectors/teams/store"),
        import("../../../src/server/connectors/microsoft/fake/fixtures"),
        import("../../../src/server/connectors/state"),
      ]);
      const graph = graphClient({ tenantId: GRAPH_FAKE.tenantId, clientId: GRAPH_FAKE.clientId, clientSecret: GRAPH_FAKE.clientSecret });
      const channelIds = Object.values(GRAPH_FAKE.channels);
      try {
        const library = await syncSharePoint({ graph, driveId: GRAPH_FAKE.driveId, store: prismaDocumentStore("sharepoint"), cursor: null, signal: AbortSignal.timeout(SYNC_BUDGET_MS), deadline: Date.now() + SYNC_BUDGET_MS, log });
        if (library.more) throw new Error("The SharePoint enumeration didn't finish");
        await recordConnectorSync("sharepoint", { cursor: library.cursor });
        // A stored delta link points into an earlier fakes server's history: list the channels again
        await prisma.teamsChannel.updateMany({ where: { id: { in: channelIds } }, data: { deltaLink: null } });
        const teams = await syncTeams({ graph, teamId: GRAPH_FAKE.teamId, channelIds, store: prismaTeamsStore(), cursor: null, signal: AbortSignal.timeout(SYNC_BUDGET_MS), deadline: Date.now() + SYNC_BUDGET_MS, channelIntervalMs: 0, log });
        if (teams.more) throw new Error("The Teams sync didn't finish");
        await recordConnectorSync("teams", { cursor: teams.cursor });
        await switchOn(prisma, "sharepoint", "teams");
        return `${library.counts.indexed + library.counts.unchanged} SharePoint documents, ${teams.counts.messages} Teams messages; sharepoint and teams switched on`;
      } catch (error) {
        throw fakesHint(error);
      }
    },
  },
];
