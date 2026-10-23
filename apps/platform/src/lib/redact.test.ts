import { describe, expect, it } from "vitest"
import { findSecret, looksLikeSecret, REDACT_MAX_CHARS, redactSecrets, SECRET_ENV_VARS } from "./redact"

// Fake secrets in the shapes the real ones take (none of these is real). Each is put together from
// pieces, so GitHub's secret scanning doesn't take the source for a leaked key
const fake = (...pieces: string[]) => pieces.join("")
const STRIPE = fake("sk_", "live_", "51HxQ2bL7aZpK9mN3vR8tY4wE6uI0oP2aS5dF7gH9jK1lZ3xC5vB7nM9qW1eR3tY5")
const RESTRICTED = fake("rk_", "live_", "51HxQ2bL7aZpK9mN3vR8tY4wE6uI0oP2aS5dF7gH9jK1")
const WEBHOOK_SECRET = fake("whsec_", "9fK2mN4pQ6rS8tU0vW2xY4zA6bC8dE0f")
const RESEND = fake("re_", "Ab12Cd34_EfGh5678IjKl9012MnOp3456")
const ANTHROPIC = fake("sk-", "ant-api03-", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe-Dc_Ba98765432")
const VERCEL = fake("vcp_", "4Fh8Jk2Lm6Np0Qr4St8Vw2Xy6Za0Bc4De8")
const DISCORD_BOT = fake("MTE5ODc2NTQzMjEwOTg3NjU0Mw", ".GaBcDe.", "Xy9Zw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa")
const JWT = fake("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ", ".c2lnbmF0dXJlLWZvci10ZXN0cy1vbmx5")
const PEM = fake("-----BEGIN PRIVATE ", "KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nabcDEF123\n-----END PRIVATE KEY-----")
const BASE64 = "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFiQ2RFZkdoSWpLbE1uT3BRcg=="
const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
const GOOGLE_TOKEN = fake("ya29", ".a0AfH6SMBx1")
const DISCORD_WEBHOOK = fake("https://discord.com/api/", "webhooks/1198765432109876543/", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")

describe("redactSecrets", () => {
  const env = {}

  it("leaves ordinary text alone", () => {
    for (const text of [
      "GM 2 is on Mon, Oct 19 at 7:00 PM CT in the Alienware lounge.",
      "Room 123e4567-e89b-12d3-a456-426614174000 has 3 unanswered messages",
      "Bearer authentication failed for the Twitch API",
      "ENOENT: no such file at apps/platform/src/server/jack/tools/run-sql.ts",
      "risk_assessment and task_list are column names; token: expired",
      'Invalid `prisma.event.findMany()` invocation: column "Event.nope" does not exist',
      "Discord channel 1198765432109876543 has 42 messages",
    ]) {
      expect(redactSecrets(text, { env }), text).toBe(text)
    }
  })

  it("strips query strings and fragments from links, keeping the sentence's punctuation", () => {
    expect(redactSecrets("Fetch failed: https://api.twitch.tv/helix/streams?user_id=1&token=abc#top.", { env })).toBe("Fetch failed: https://api.twitch.tv/helix/streams.")
    expect(redactSecrets("[the doc](https://docs.google.com/document/d/abc/edit?usp=sharing)", { env })).toBe("[the doc](https://docs.google.com/document/d/abc/edit)")
    expect(redactSecrets('{"next":"https://graph.microsoft.com/v1.0/teams/x/channels/y/messages/delta?$deltatoken=abc"}', { env })).toBe(
      '{"next":"https://graph.microsoft.com/v1.0/teams/x/channels/y/messages/delta"}',
    )
  })

  it("masks a password in a link", () => {
    expect(redactSecrets("Can't reach postgresql://postgres.abcd:hunter2-pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true", { env })).toBe(
      "Can't reach postgresql://[redacted]@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    )
  })

  it("masks keys and tokens by their shape", () => {
    const cases: [string, string][] = [
      [`key ${STRIPE} was rejected`, "key [redacted] was rejected"],
      [`key ${RESTRICTED}`, "key [redacted]"],
      [`signing secret ${WEBHOOK_SECRET}`, "signing secret [redacted]"],
      [`resend ${RESEND} invalid`, "resend [redacted] invalid"],
      [`x-api-key: ${ANTHROPIC}`, "x-api-key: [redacted]"],
      [`token ${VERCEL}`, "token [redacted]"],
      [`Authorization: Bot ${DISCORD_BOT}`, "Authorization: Bot [redacted]"],
      [`raw ${DISCORD_BOT}`, "raw [redacted]"],
      [`Authorization: Bearer ${GOOGLE_TOKEN}`, "Authorization: Bearer [redacted]"],
      [`apikey ${JWT}`, "apikey [redacted]"],
      [`key:\n${PEM}\nend`, "key:\n[redacted]\nend"],
      ["half a key -----BEGIN RSA PRIVATE KEY-----\nMIIEow", "half a key [redacted]"],
      [`blob ${BASE64} end`, "blob [redacted] end"],
      [`sha ${HEX}`, "sha [redacted]"],
      [`POST ${DISCORD_WEBHOOK}`, "POST https://discord.com/api/webhooks/1198765432109876543/[redacted]"],
    ]
    for (const [text, expected] of cases) expect(redactSecrets(text, { env }), text).toBe(expected)
  })

  it("masks secret-named assignments, keeping JSON quotes", () => {
    expect(redactSecrets("CRON_SECRET=abcdef123456 DISCORD_BOT_TOKEN=plainbottoken", { env })).toBe("CRON_SECRET=[redacted] DISCORD_BOT_TOKEN=[redacted]")
    expect(redactSecrets('{"access_token":"ya29abcdefgh","refresh_token":"1//0gAbCdEf","expires_in":3599}', { env })).toBe(
      '{"access_token":"[redacted]","refresh_token":"[redacted]","expires_in":3599}',
    )
    expect(redactSecrets("host=db.local user=jack password=s3cret-pass dbname=postgres", { env })).toBe("host=db.local user=jack password=[redacted] dbname=postgres")
    // Short values and prose stay
    expect(redactSecrets("tokens=5 secret=no", { env })).toBe("tokens=5 secret=no")
  })

  it("masks the values of secret env vars, in the forms they show up in", () => {
    const env = {
      STRIPE_SECRET_KEY: "plain-value-without-a-prefix",
      CRON_SECRET: "a b&c=d/e",
      DATABASE_URL: "postgresql://postgres:p%40ss-w0rd!@127.0.0.1:54322/postgres",
      DISCORD_BOT_TOKEN: "dev",
    }
    expect(redactSecrets("key plain-value-without-a-prefix failed", { env })).toBe("key [redacted STRIPE_SECRET_KEY] failed")
    expect(redactSecrets("cron a b&c=d/e and a%20b%26c%3Dd%2Fe", { env })).toBe("cron [redacted CRON_SECRET] and [redacted CRON_SECRET]")
    expect(redactSecrets("password authentication failed: p@ss-w0rd!", { env })).toBe("password authentication failed: [redacted DATABASE_URL]")
    // Too short to mask without masking ordinary words
    expect(redactSecrets("dev build", { env })).toBe("dev build")
    // Only the vars it's told about
    expect(redactSecrets("key plain-value-without-a-prefix", { env, envVars: ["CRON_SECRET"] })).toBe("key plain-value-without-a-prefix")
  })

  it("lists the secret env vars from the design", () => {
    for (const name of ["ANTHROPIC_API_KEY", "STRIPE_READONLY_KEY", "SCHEDULER_SIGNING_SECRET", "DISCORD_BOT_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON", "TEAMS_WEBHOOK_URL", "JACK_DATABASE_URL", "DIRECT_URL"]) {
      expect(SECRET_ENV_VARS).toContain(name)
    }
  })

  it("cuts to the max length after redacting, so a secret at the cut doesn't leave half of itself", () => {
    const long = "word ".repeat(1_000)
    const cut = redactSecrets(long, { env })
    expect(cut).toHaveLength(REDACT_MAX_CHARS)
    expect(cut.endsWith("…")).toBe(true)
    const text = `${"a".repeat(40)} ${STRIPE} and more`
    const short = redactSecrets(text, { env, maxLength: 50 })
    expect(short.length).toBeLessThanOrEqual(50)
    expect(short).not.toContain("sk_live")
    expect(short).not.toContain("51Hx")
    // Far past the cut, text is dropped before redacting; nothing of a key there can come back
    const far = redactSecrets(`${"x ".repeat(20_000)}${STRIPE}`, { env, maxLength: 100 })
    expect(far).not.toContain("sk_")
  })
})

describe("looksLikeSecret", () => {
  const env = {}

  it("finds keys, tokens, private keys and secret env values", () => {
    const cases: [string, string][] = [
      [`The Stripe key is ${STRIPE}`, "a Stripe key"],
      [`whsec ${WEBHOOK_SECRET}`, "a webhook signing secret"],
      [`Resend: ${RESEND}`, "a Resend key"],
      [`Claude key ${ANTHROPIC}`, "an API key"],
      [`Vercel ${VERCEL}`, "a Vercel token"],
      [`Bot ${DISCORD_BOT}`, "a bot token"],
      [`service role ${JWT}`, "a JWT"],
      [PEM, "a private key"],
      [`the backup passphrase ${BASE64}`, "a long random-looking string"],
      ["DB: postgresql://postgres:hunter2@db.example.com/postgres", "a password in a link"],
      [`Webhook: ${DISCORD_WEBHOOK}`, "a Discord webhook link"],
      ["Teams: https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=Q2xZ7wA1bC3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY", "a long random-looking string"],
      ["wifi password=lsrRacing2026", "a password or token"],
    ]
    for (const [text, kind] of cases) {
      expect(findSecret(text, { env }), text).toBe(kind)
      expect(looksLikeSecret(text, { env }), text).toBe(true)
    }
    expect(findSecret("the cron secret is a-long-cron-secret-value", { env: { CRON_SECRET: "a-long-cron-secret-value" } })).toBe("the value of CRON_SECRET")
  })

  it("lets ordinary club knowledge through, links to shared docs included", () => {
    for (const text of [
      "GM 1 is the second Monday of the semester, 6-8pm in the Alienware lounge. Dylan books the room.",
      "The sponsor packet lives at https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit?usp=sharing",
      "Instagram token: renew it monthly in Admin -> Instagram. Only Gray has the Stripe dashboard password.",
      "Use Bearer authentication for the Twitch API.",
      "LSC entry is $10 for UT students and $5 for others.",
    ]) {
      expect(findSecret(text, { env }), text).toBeNull()
    }
  })
})
