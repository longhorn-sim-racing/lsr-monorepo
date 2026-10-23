import { describe, expect, it } from "vitest"
import { FIND_SECRET_MAX_CHARS, findSecret, looksLikeSecret, REDACT_MAX_CHARS, redactSecrets, SECRET_ENV_VARS } from "./redact"

// Fake secrets in the shapes the real ones take (none of these is real). Each is put together from
// pieces, so GitHub's secret scanning doesn't take the source for a leaked key
const fake = (...pieces: string[]) => pieces.join("")
const STRIPE = fake("sk_", "live_", "51HxQ2bL7aZpK9mN3vR8tY4wE6uI0oP2aS5dF7gH9jK1lZ3xC5vB7nM9qW1eR3tY5")
const RESTRICTED = fake("rk_", "live_", "51HxQ2bL7aZpK9mN3vR8tY4wE6uI0oP2aS5dF7gH9jK1")
const WEBHOOK_SECRET = fake("whsec_", "9fK2mN4pQ6rS8tU0vW2xY4zA6bC8dE0f")
const RESEND = fake("re_", "Ab12Cd34_EfGh5678IjKl9012MnOp3456")
const ANTHROPIC = fake("sk-", "ant-api03-", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe-Dc_Ba98765432")
const VERCEL = fake("vcp_", "4Fh8Jk2Lm6Np0Qr4St8Vw2Xy6Za0Bc4De8")
const GOOGLE_KEY = fake("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q")
const DISCORD_BOT = fake("MTE5ODc2NTQzMjEwOTg3NjU0Mw", ".GaBcDe.", "Xy9Zw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa")
const JWT = fake("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ", ".c2lnbmF0dXJlLWZvci10ZXN0cy1vbmx5")
const PEM = fake("-----BEGIN PRIVATE ", "KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nabcDEF123\n-----END PRIVATE KEY-----")
const BASE64 = "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFiQ2RFZkdoSWpLbE1uT3BRcg=="
const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
const HEX_32 = "5f2b9c7e1a4d8e6f3b0c9a7d2e5f8a1b"
const TWITCH = fake("q6batx0epp608", "isickayubi39itsr7")
const BASIC = fake("dXNlcjpwYXNz", "d29yZDEyMw==")
const GOOGLE_TOKEN = fake("ya29", ".a0AfH6SMBx1")
const DISCORD_WEBHOOK = fake("https://discord.com/api/", "webhooks/1198765432109876543/", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")
const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd"
const DRIVE_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"

/** Milliseconds a call takes */
function timed(fn: () => unknown): number {
  const started = performance.now()
  fn()
  return performance.now() - started
}

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
      "Uploaded LSR-Sponsor-Packet-Fall-2026-v3-FINAL-Draft.pdf to Sponsors/2026-2027/Packets/LSR_Sponsorship_Packet_v2",
      "Basic Membership-Benefits-Overview-2026 and re_registration_open_flag_until",
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

  it("masks random-looking segments of a link's path one at a time, keeping the host", () => {
    expect(redactSecrets(`Couldn't export https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`, { env })).toBe(
      "Couldn't export https://docs.google.com/document/d/[redacted]/edit",
    )
    expect(redactSecrets(`GET https://api.example.com/v1/files/${HEX_32}/content`, { env })).toBe("GET https://api.example.com/v1/files/[redacted]/content")
    expect(redactSecrets("GET https://res.cloudinary.com/lsr/image/upload/v1729000000/gallery/LSR-Sponsor-Packet-Fall-2026-v3-FINAL-Draft.jpg", { env })).toBe(
      "GET https://res.cloudinary.com/lsr/image/upload/v1729000000/gallery/LSR-Sponsor-Packet-Fall-2026-v3-FINAL-Draft.jpg",
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
      [`maps ${GOOGLE_KEY} denied`, "maps [redacted] denied"],
      [`Authorization: Bot ${DISCORD_BOT}`, "Authorization: Bot [redacted]"],
      [`raw ${DISCORD_BOT}`, "raw [redacted]"],
      [`Authorization: Bearer ${GOOGLE_TOKEN}`, "Authorization: Bearer [redacted]"],
      [`Authorization: Basic ${BASIC}`, "Authorization: Basic [redacted]"],
      [`apikey ${JWT}`, "apikey [redacted]"],
      [`key:\n${PEM}\nend`, "key:\n[redacted]\nend"],
      ["half a key -----BEGIN RSA PRIVATE KEY-----\nMIIEow", "half a key [redacted]"],
      [`blob ${BASE64} end`, "blob [redacted] end"],
      // base64url with its - and _ in it is still one random-looking run
      ["blob Q2xZ7wA1bC3dE5fG7h-I9jK1lM3nO5pQ7rS9t_U1vW3xY end", "blob [redacted] end"],
      [`sha ${HEX}`, "sha [redacted]"],
      [`id ${HEX_32}`, "id [redacted]"],
      [`twitch client secret ${TWITCH}`, "twitch client secret [redacted]"],
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
    // After an unquoted "name:", only a token that mixes letters and digits
    expect(redactSecrets("wifi password: lsrRacing2026", { env })).toBe("wifi password: [redacted]")
    // Short values and prose stay
    expect(redactSecrets("tokens=5 secret=no token: expired", { env })).toBe("tokens=5 secret=no token: expired")
  })

  it("masks the values of secret env vars, in the forms they show up in", () => {
    const env = {
      STRIPE_SECRET_KEY: "plain-value-without-a-prefix",
      CRON_SECRET: "a b&c=d/e-local-1",
      JACK_DATABASE_URL: "postgresql://jack_readonly:p%40ss-w0rd-local!@127.0.0.1:54322/postgres",
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      DISCORD_BOT_TOKEN: "dev",
    }
    expect(redactSecrets("key plain-value-without-a-prefix failed", { env })).toBe("key [redacted STRIPE_SECRET_KEY] failed")
    expect(redactSecrets("cron a b&c=d/e-local-1 and a%20b%26c%3Dd%2Fe-local-1", { env })).toBe("cron [redacted CRON_SECRET] and [redacted CRON_SECRET]")
    expect(redactSecrets("password authentication failed: p@ss-w0rd-local!", { env })).toBe("password authentication failed: [redacted JACK_DATABASE_URL]")
    // Too short to mask without masking ordinary words: local Supabase's password is "postgres"
    expect(redactSecrets("dev build on database postgres", { env })).toBe("dev build on database postgres")
    // Only the vars it's told about
    expect(redactSecrets("key plain-value-without-a-prefix", { env, envVars: ["CRON_SECRET"] })).toBe("key plain-value-without-a-prefix")
  })

  it("lists the secret env vars from the design", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "STRIPE_READONLY_KEY",
      "STRIPE_TEST_SECRET_KEY",
      "SCHEDULER_SIGNING_SECRET",
      "DISCORD_BOT_TOKEN",
      "GOOGLE_SERVICE_ACCOUNT_JSON",
      "TEAMS_WEBHOOK_URL",
      "SHOPIFY_STOREFRONT_ACCESS_TOKEN",
      "JACK_DATABASE_URL",
      "DIRECT_URL",
    ]) {
      expect(SECRET_ENV_VARS).toContain(name)
    }
  })

  it("cuts to the max length after redacting, so a secret at the cut doesn't leave half of itself", () => {
    const long = "word ".repeat(1_000)
    const cut = redactSecrets(long, { env })
    expect(cut).toHaveLength(REDACT_MAX_CHARS)
    expect(cut.endsWith("…")).toBe(true)
    expect(redactSecrets(long, { env, maxLength: 0 })).toBe("")
    expect(redactSecrets(long, { env, maxLength: 1 })).toBe("…")
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
      [`Maps key ${GOOGLE_KEY}`, "a Google API key"],
      [`Bot ${DISCORD_BOT}`, "a bot token"],
      [`service role ${JWT}`, "a JWT"],
      [PEM, "a private key"],
      [`the backup passphrase ${BASE64}`, "a token"],
      [`the backup passphrase is ${DRIVE_ID}`, "a token"],
      // A random-looking run counts next to a secret-ish word, though the same id alone passes
      [`the old service credential, ${DRIVE_ID}`, "a long random-looking string"],
      [`Twitch client secret ${TWITCH}`, "a token"],
      [`webhook signing ${HEX_32}`, "a long random-looking string"],
      ["DB: postgresql://postgres:hunter2@db.example.com/postgres", "a password in a link"],
      [`Webhook: ${DISCORD_WEBHOOK}`, "a Discord webhook link"],
      ["Teams: https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=Q2xZ7wA1bC3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY", "a token in a link"],
      ["wifi password=lsrRacing2026", "a password or token"],
      ["wifi password: lsrRacing2026", "a password or token"],
      ["Twitch client secret: abcd1234efgh5678", "a password or token"],
      [`blob ${BASE64}${BASE64}`, "a long random-looking string"],
    ]
    for (const [text, kind] of cases) {
      expect(findSecret(text, { env }), text).toBe(kind)
      expect(looksLikeSecret(text, { env }), text).toBe(true)
    }
    expect(findSecret("the cron secret is a-long-cron-secret-value", { env: { CRON_SECRET: "a-long-cron-secret-value" } })).toBe("the value of CRON_SECRET")
    expect(findSecret("x ".repeat(FIND_SECRET_MAX_CHARS), { env })).toBe("text too long to check for secrets")
  })

  it("lets ordinary club knowledge through: links to shared docs, file names, ids and prose", () => {
    for (const text of [
      "GM 1 is the second Monday of the semester, 6-8pm in the Alienware lounge. Dylan books the room.",
      `The sponsor packet lives at https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`,
      "Instagram token: renew it monthly in Admin -> Instagram. Only Gray has the Stripe dashboard password.",
      "Use Bearer authentication for the Twitch API. The session token: expired.",
      "LSC entry is $10 for UT students and $5 for others.",
      "The packet is LSR-Sponsor-Packet-Fall-2026-v3-FINAL-Draft.pdf in Sponsors/2026-2027/Packets/LSR_Sponsorship_Packet_v2",
      `The budget sheet's Drive id is ${DRIVE_ID}`,
      "Basic Membership-Benefits-Overview-2026 lists what members get.",
      "The flag re_registration_open_flag_until closes sign-ups.",
    ]) {
      expect(findSecret(text, { env }), text).toBeNull()
    }
  })

  it("stays fast on long runs that could make a pattern backtrack", () => {
    for (const text of ["-eyJ".repeat(25_000), "a-".repeat(50_000), "x.".repeat(50_000), "key-".repeat(25_000), "Bearer ".repeat(14_000), "https://x.com/" + "a-".repeat(40_000)]) {
      expect(timed(() => findSecret(text, { env })), text.slice(0, 12)).toBeLessThan(1_000)
      expect(timed(() => redactSecrets(text, { env })), text.slice(0, 12)).toBeLessThan(1_000)
    }
  })
})
