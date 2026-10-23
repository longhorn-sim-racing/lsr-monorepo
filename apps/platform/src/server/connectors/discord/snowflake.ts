/**
 * Discord snowflakes (research §3): 64-bit ids whose top 42 bits are milliseconds since Discord's epoch.
 * They stay strings everywhere (a JS number loses the low bits); BigInt does the arithmetic.
 */

/** 2015-01-01T00:00:00Z, Discord's epoch */
export const DISCORD_EPOCH_MS = 1_420_070_400_000

const SHIFT = BigInt(22)

/** Whether a string is a snowflake: digits only, 17 to 20 of them */
export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/.test(value)
}

/** When a snowflake was made */
export function snowflakeTime(id: string): Date {
  return new Date(Number(BigInt(id) >> SHIFT) + DISCORD_EPOCH_MS)
}

/**
 * The smallest snowflake at an instant (with `after=` it starts a scan "from date X"). Before Discord's
 * epoch it's "0"
 */
export function snowflakeAt(date: Date): string {
  const ms = Math.max(0, Math.floor(date.getTime()) - DISCORD_EPOCH_MS)
  return (BigInt(ms) << SHIFT).toString()
}

/** Orders snowflakes by value: negative when a is older */
export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** The newer of two snowflakes; null counts as older than any */
export function maxSnowflake(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return compareSnowflakes(a, b) >= 0 ? a : b
}
