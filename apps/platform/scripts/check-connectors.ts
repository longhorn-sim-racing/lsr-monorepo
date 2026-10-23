/**
 * LOCAL ONLY: checks the connector helpers (Jack 2.0 G2, src/server/connectors) against the local
 * database, where the unit tests only see a mocked Prisma: the switch and its audit entries, the
 * cursor stored as is (JSON in, the same JSON out, SQL NULL when cleared), redacted errors, statuses,
 * and the Connections page's rows and last smoke test.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-connectors.ts
 *
 * Refuses unless DATABASE_URL points at 127.0.0.1 or localhost. It works on its own throwaway
 * connector id and deletes that ConnectorState row and its audit entries at the end, pass or fail.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
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

async function main() {
  const { localDatabaseProblem } = await import("../src/server/jack/eval-support");
  const problem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL);
  if (problem) {
    console.error(`Refusing to run: ${problem}`);
    process.exit(1);
  }

  const { prisma } = await import("../src/server/db");
  const state = await import("../src/server/connectors/state");
  const { defineConnector } = await import("../src/server/connectors/define");
  const { connectorStatus, listConnections, SMOKE_ACTION } = await import("../src/server/connectors/status");

  const id = `check-connectors-${randomBytes(4).toString("hex")}`;
  const envName = `CHECK_CONNECTORS_${randomBytes(3).toString("hex").toUpperCase()}`;
  const actor = await prisma.user.findFirst({ where: { roles: { some: { role: { key: "admin" } } } }, select: { id: true } });

  try {
    check("a connector with no row is off", (await state.connectorEnabled(id)) === false);

    const cursor = { deltaLink: "https://graph.microsoft.com/v1.0/sites/x/drive/root/delta?token=aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5z", pages: [1, 2] };
    await state.recordConnectorSync(id, { cursor });
    let row = await state.readConnectorState(id);
    check("recording a sync creates the row, switched off", row?.enabled === false && row.lastSyncAt instanceof Date);
    // jsonb reorders keys, so compare by value
    check("the cursor comes back exactly as stored (a delta link's token too)", isDeepStrictEqual(row?.cursor, cursor), JSON.stringify(row?.cursor));

    await state.recordConnectorSync(id);
    row = await state.readConnectorState(id);
    check("a sync without a cursor keeps the stored one", isDeepStrictEqual(row?.cursor, cursor), JSON.stringify(row?.cursor));

    await state.recordConnectorSync(id, { cursor: null });
    const [nulls] = await prisma.$queryRaw<{ cleared: boolean }[]>`SELECT cursor IS NULL AS cleared FROM "ConnectorState" WHERE id = ${id}`;
    check("a null cursor clears it to SQL NULL", nulls?.cleared === true);

    const key = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";
    await new Promise((r) => setTimeout(r, 5));
    const stored = await state.recordConnectorError(id, new Error(`Invalid API Key provided: ${key}`));
    row = await state.readConnectorState(id);
    check("a stored error is redacted", row?.lastError === "Invalid API Key provided: [redacted]" && !row.lastError.includes(key), row?.lastError ?? "");
    check("recordConnectorError returns what it stored", stored === row?.lastError);

    const planned = await connectorStatus(id);
    check("a row without code reads as not set up", planned?.state === "not_configured" && planned.configured === false);

    const connector = defineConnector({ id, label: "Check connector", requiredEnv: [envName], createClient: () => ({ ok: true }) });
    check("no client while its env is missing", (await connector.client()) === null);
    process.env[envName] = "set";
    check("no client while switched off", (await connector.client()) === null);

    if (actor) {
      const on = await state.setConnectorEnabled(id, true, { userId: actor.id, label: "Check connector" });
      const again = await state.setConnectorEnabled(id, true, { userId: actor.id, label: "Check connector" });
      const audits = await prisma.auditLog.findMany({ where: { entityType: state.CONNECTOR_ENTITY, entityId: id }, orderBy: { createdAt: "asc" } });
      check("switching on audits once", on.changed && !again.changed && audits.length === 1 && audits[0].actionType === "ENABLE", JSON.stringify(audits.map((a) => a.actionType)));
    } else {
      console.log("SKIP  audit checks: no admin user in this database");
      await prisma.connectorState.update({ where: { id }, data: { enabled: true } });
    }

    check("a client once configured and switched on", JSON.stringify(await connector.client()) === JSON.stringify({ ok: true }));
    check("failing while the last error is newer than the last sync", (await connector.status()).state === "error");
    await new Promise((r) => setTimeout(r, 5));
    await state.recordConnectorSync(id);
    check("connected after a sync that worked", (await connector.status()).state === "connected");

    if (actor) {
      await prisma.auditLog.create({
        data: { actorUserId: actor.id, actionType: SMOKE_ACTION, entityType: state.CONNECTOR_ENTITY, entityId: id, summary: "check", metadata: { ok: true, summary: "Read 3 things", ms: 12 } },
      });
      const rows = await listConnections();
      const mine = rows.find((r) => r.id === id);
      check("the Connections page lists the row, with its last smoke test", mine?.registered === false && mine.lastSmoke?.ok === true && mine.lastSmoke.summary === "Read 3 things", JSON.stringify(mine));

      await state.setConnectorEnabled(id, false, { userId: actor.id });
      check("switching off works and is audited", (await state.connectorEnabled(id)) === false && (await prisma.auditLog.count({ where: { entityId: id, actionType: "DISABLE" } })) === 1);
    }
  } finally {
    delete process.env[envName];
    await prisma.auditLog.deleteMany({ where: { entityType: "CONNECTOR", entityId: id } });
    await prisma.connectorState.deleteMany({ where: { id } });
    const left = (await prisma.connectorState.count({ where: { id } })) + (await prisma.auditLog.count({ where: { entityId: id } }));
    check("cleaned up its rows", left === 0);
    await prisma.$disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
