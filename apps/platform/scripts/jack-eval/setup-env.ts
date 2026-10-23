/**
 * The eval's environment, imported first by scripts/jack-eval.ts so it's in place before any other
 * module loads: reads apps/platform/.env.local and .env, quiets Prisma's query log, and applies --db (the
 * eval copy on the same local server, for both connections). Static imports run before a script's own
 * code, and src/server/db.ts builds its client from DATABASE_URL when it's first imported (a track's
 * question file may import a server module that reaches it), so this can't wait for the script body.
 */
import { evalCopyUrl, withDatabaseName } from "../../src/server/jack/eval-support";
import { loadAppEnv } from "./env";

loadAppEnv();
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const db = process.argv.slice(2).find((a) => a.startsWith("--db="))?.slice("--db=".length);
if (db !== undefined) {
  const copy = evalCopyUrl(process.env.DATABASE_URL, db);
  if (!copy.ok) {
    console.error(copy.error);
    process.exit(1);
  }
  process.env.DATABASE_URL = copy.url;
  process.env.DIRECT_URL = copy.url;
  if (process.env.JACK_DATABASE_URL) process.env.JACK_DATABASE_URL = withDatabaseName(process.env.JACK_DATABASE_URL, db) ?? process.env.JACK_DATABASE_URL;
}
