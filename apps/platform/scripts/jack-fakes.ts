/**
 * LOCAL ONLY: runs the HTTP fakes of Jack 2.0's outside services on one loopback port (design §12), so
 * the real clients run against them instead of Discord, Twitch, Stripe and the rest.
 *
 *   pnpm jack:fakes                  # every registered fake, on 127.0.0.1:3999
 *   pnpm jack:fakes --port 4000      # another port (then JACK_FAKES_URL=http://127.0.0.1:4000)
 *
 * Then, in .env.local for the dev server: JACK_FAKES=all (or a list such as discord,twitch). Each fake
 * is mounted under its id, using the real API's paths: http://127.0.0.1:3999/ lists them all.
 * Fakes are registered in src/server/connectors/fakes/slots/<track>.ts (docs/jack-2/tracks/groundwork.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read .env.local / .env without overriding what's already set, so a JACK_FAKES_URL there sets the port
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

function portArg(): number | null {
  const at = process.argv.indexOf("--port");
  if (at < 0) return null;
  const port = Number(process.argv[at + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("--port takes a number from 1 to 65535.");
    process.exit(1);
  }
  return port;
}

async function main() {
  const { DEFAULT_FAKES_URL, fakesOrigin } = await import("../src/server/connectors/base-url");
  const { FAKE_SERVICES } = await import("../src/server/connectors/fakes/registry");
  const { startFakeServer } = await import("../src/server/connectors/fakes/server");

  let configured: URL;
  try {
    configured = new URL(fakesOrigin());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const port = portArg() ?? Number(configured.port || 80);

  const server = await startFakeServer({
    services: FAKE_SERVICES,
    port,
    host: configured.hostname === "[::1]" ? "::1" : "127.0.0.1",
    log: (line) => console.log(`${new Date().toLocaleTimeString("en-US", { hour12: false })} ${line}`),
  });

  console.log(`Jack fakes on ${server.url}`);
  for (const service of FAKE_SERVICES) console.log(`  ${server.url}/${service.id}`);
  console.log(`\nIn .env.local: JACK_FAKES=all${server.url === DEFAULT_FAKES_URL ? "" : ` and JACK_FAKES_URL=${server.url}`}. Ctrl+C stops it.`);

  const stop = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
