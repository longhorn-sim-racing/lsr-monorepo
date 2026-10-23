/**
 * Reads apps/platform/.env.local and .env (found from this file, not the working directory) into
 * process.env, without overriding what's already set. The eval's scripts call it before they load
 * anything that reads the environment.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** apps/platform */
export const APP_DIR = resolve(__dirname, "..", "..");

export function loadAppEnv(dir = APP_DIR) {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(dir, file);
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
}
