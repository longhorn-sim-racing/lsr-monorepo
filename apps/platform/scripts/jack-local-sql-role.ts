/**
 * LOCAL ONLY: lets Jack's read-only role log in on the local Supabase database, with a fresh random
 * password, and prints the JACK_DATABASE_URL line to add to apps/platform/.env.local (#161).
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-local-sql-role.ts
 *
 * The role itself comes from the 20261013180000_jack_sql_role migration (created NOLOGIN). In
 * production an officer sets the password by hand; this script refuses to touch anything but a
 * database on 127.0.0.1 or localhost. Running it again replaces the password.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

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

const LOCAL_HOSTS = ["127.0.0.1", "localhost"];

async function main() {
  let url: URL;
  try {
    url = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    console.error("DATABASE_URL isn't set (or isn't a URL). Point it at the local Supabase database.");
    process.exit(1);
  }
  if (!LOCAL_HOSTS.includes(url.hostname)) {
    console.error(`Refusing to run: DATABASE_URL points at "${url.hostname}", not the local database.`);
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    const [role] = await prisma.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') AS "exists"`;
    if (!role?.exists) {
      console.error("No jack_readonly role yet. Apply the migrations first: pnpm prisma migrate deploy");
      process.exit(1);
    }

    // base64url: letters, digits, - and _, so it's safe both in the SQL literal and in a URL
    const password = randomBytes(24).toString("base64url");
    await prisma.$executeRawUnsafe(`ALTER ROLE jack_readonly LOGIN PASSWORD '${password}'`);

    const jackUrl = new URL(url.toString());
    jackUrl.username = "jack_readonly";
    jackUrl.password = password;
    jackUrl.search = "";
    console.log("jack_readonly can log in locally now. Add this line to apps/platform/.env.local:\n");
    console.log(`JACK_DATABASE_URL=${jackUrl.toString()}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
