import { describe, expect, it } from "vitest"
import { EVENTSUB_HEADERS, eventSubSignature, parseEventSubBody, parseEventSubTimestamp, verifyEventSub } from "./eventsub"

// Twitch's stream.online example (EventSub reference), signed per the docs: HMAC-SHA256 over
// message id + timestamp + raw body, "sha256=" + lowercase hex. The expected value was computed apart
// from this code (openssl dgst -sha256 -hmac), so it pins the scheme, not just our own round trip
const SECRET = "s3cRe7-for-the-test"
const MESSAGE_ID = "e76c6bd4-55c9-4987-8304-da1588d8988b"
const TIMESTAMP = "2019-11-16T10:11:12.634234626Z"
const BODY =
  '{"subscription":{"id":"f1c2a387-161a-49f9-a165-0f21d7a4e1c4","type":"stream.online","version":"1","status":"enabled","cost":0,"condition":{"broadcaster_user_id":"1337"},"transport":{"method":"webhook","callback":"https://example.com/webhooks/callback"},"created_at":"2019-11-16T10:11:12.634234626Z"},"event":{"id":"9001","broadcaster_user_id":"1337","broadcaster_user_login":"cool_user","broadcaster_user_name":"Cool_User","type":"live","started_at":"2020-10-11T10:11:12.123Z"}}'
const EXPECTED = "sha256=1099dee4f8180cc9a89c4049091aa1d700dc0fe494e78d52cd70216ceaaf9d7a"
const SENT_AT = Date.parse("2019-11-16T10:11:12.634Z")

function headers(overrides: Record<string, string | null> = {}) {
  const base: Record<string, string | null> = {
    [EVENTSUB_HEADERS.id]: MESSAGE_ID,
    [EVENTSUB_HEADERS.timestamp]: TIMESTAMP,
    [EVENTSUB_HEADERS.signature]: EXPECTED,
    [EVENTSUB_HEADERS.type]: "notification",
    [EVENTSUB_HEADERS.retry]: "0",
    ...overrides,
  }
  const result = new Headers()
  for (const [name, value] of Object.entries(base)) if (value !== null) result.set(name, value)
  return result
}

describe("EventSub signatures", () => {
  it("signs id + timestamp + raw body the way Twitch documents", () => {
    expect(eventSubSignature(SECRET, MESSAGE_ID, TIMESTAMP, BODY)).toBe(EXPECTED)
  })

  it("accepts a signed message inside the 10-minute window", () => {
    expect(verifyEventSub(headers(), BODY, { secret: SECRET, nowMs: SENT_AT + 9 * 60_000 })).toEqual({ ok: true, id: MESSAGE_ID, type: "notification", at: new Date(SENT_AT), retry: false })
    expect(verifyEventSub(headers({ [EVENTSUB_HEADERS.retry]: "2" }), BODY, { secret: SECRET, nowMs: SENT_AT })).toMatchObject({ ok: true, retry: true })
  })

  it("refuses a stale or far-future timestamp, even when signed", () => {
    expect(verifyEventSub(headers(), BODY, { secret: SECRET, nowMs: SENT_AT + 10 * 60_000 + 1 })).toEqual({ ok: false, reason: "stale_timestamp" })
    expect(verifyEventSub(headers(), BODY, { secret: SECRET, nowMs: SENT_AT - 11 * 60_000 })).toEqual({ ok: false, reason: "stale_timestamp" })
  })

  it("refuses a changed body, another secret, a bad header and an unsigned request", () => {
    const now = { secret: SECRET, nowMs: SENT_AT }
    expect(verifyEventSub(headers(), BODY.replace('"9001"', '"9002"'), now)).toEqual({ ok: false, reason: "bad_signature" })
    expect(verifyEventSub(headers(), `${BODY} `, now)).toEqual({ ok: false, reason: "bad_signature" })
    expect(verifyEventSub(headers(), BODY, { secret: "another-secret-entirely", nowMs: SENT_AT })).toEqual({ ok: false, reason: "bad_signature" })
    expect(verifyEventSub(headers({ [EVENTSUB_HEADERS.signature]: EXPECTED.toUpperCase() }), BODY, now)).toEqual({ ok: false, reason: "bad_signature" })
    expect(verifyEventSub(headers({ [EVENTSUB_HEADERS.signature]: "sha256=" }), BODY, now)).toEqual({ ok: false, reason: "bad_signature" })
    expect(verifyEventSub(headers({ [EVENTSUB_HEADERS.signature]: null }), BODY, now)).toEqual({ ok: false, reason: "missing_headers" })
    expect(verifyEventSub(headers({ [EVENTSUB_HEADERS.id]: null }), BODY, now)).toEqual({ ok: false, reason: "missing_headers" })
    expect(verifyEventSub(headers({ [EVENTSUB_HEADERS.timestamp]: "yesterday" }), BODY, now)).toEqual({ ok: false, reason: "bad_timestamp" })
  })

  it("fails closed without a secret", () => {
    expect(verifyEventSub(headers(), BODY, { secret: undefined, nowMs: SENT_AT })).toEqual({ ok: false, reason: "no_secret" })
    expect(verifyEventSub(headers(), BODY, { secret: "  ", nowMs: SENT_AT })).toEqual({ ok: false, reason: "no_secret" })
  })

  it("reads timestamps with 9 fractional digits, and nothing loose", () => {
    expect(parseEventSubTimestamp("2019-11-16T10:11:12.634234626Z")).toBe(SENT_AT)
    expect(parseEventSubTimestamp("2019-11-16T10:11:12Z")).toBe(Date.parse("2019-11-16T10:11:12Z"))
    expect(parseEventSubTimestamp("2019-11-16T04:11:12.5-06:00")).toBe(Date.parse("2019-11-16T10:11:12.500Z"))
    expect(parseEventSubTimestamp("1573899072")).toBeNaN()
    expect(parseEventSubTimestamp("2019-11-16 10:11:12")).toBeNaN()
  })
})

describe("EventSub bodies", () => {
  const subscription = { id: "s", type: "stream.online", version: "1", status: "enabled", condition: { broadcaster_user_id: "1337" } }

  it("reads stream.online, stream.offline, challenges and revocations", () => {
    expect(parseEventSubBody("notification", BODY)).toMatchObject({ kind: "online", event: { id: "9001", type: "live", broadcaster_user_id: "1337" } })
    const offline = JSON.stringify({ subscription: { ...subscription, type: "stream.offline" }, event: { broadcaster_user_id: "1337", broadcaster_user_login: "cool_user", broadcaster_user_name: "Cool_User" } })
    expect(parseEventSubBody("notification", offline)).toMatchObject({ kind: "offline", event: { broadcaster_user_id: "1337" } })
    expect(parseEventSubBody("webhook_callback_verification", JSON.stringify({ challenge: "pogchamp-kappa-360noscope-vohiyo", subscription }))).toEqual({ kind: "challenge", challenge: "pogchamp-kappa-360noscope-vohiyo", subscription })
    expect(parseEventSubBody("revocation", JSON.stringify({ subscription: { ...subscription, status: "authorization_revoked" } }))).toMatchObject({ kind: "revocation" })
  })

  it("passes over types it doesn't handle, and refuses what isn't the promised shape", () => {
    expect(parseEventSubBody("notification", JSON.stringify({ subscription: { ...subscription, type: "channel.update" }, event: {} }))).toMatchObject({ kind: "other" })
    expect(parseEventSubBody("notification", "not json")).toBeNull()
    expect(parseEventSubBody("notification", JSON.stringify({ event: {} }))).toBeNull()
    expect(parseEventSubBody("notification", JSON.stringify({ subscription, event: { id: "1", broadcaster_user_id: "1337", started_at: "never" } }))).toBeNull()
    expect(parseEventSubBody("webhook_callback_verification", JSON.stringify({ subscription }))).toBeNull()
  })
})
