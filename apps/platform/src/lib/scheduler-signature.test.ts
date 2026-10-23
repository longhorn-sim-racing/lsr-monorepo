import { describe, expect, it } from "vitest"
import {
  schedulerSecrets,
  schedulerSignature,
  signSchedulerRequest,
  tickBody,
  verifySchedulerRequest,
  verifySchedulerSignature,
  SCHEDULER_SIGNATURE_HEADER,
  SCHEDULER_TIMESTAMP_HEADER,
} from "./scheduler-signature"

const SECRET = "a".repeat(64)
const OLD_SECRET = "b".repeat(64)
const NOW = 1_792_692_060_000
const TS = String(NOW / 1000)
const BODY = tickBody(NOW / 1000, "5f0c2d6e-0000-4000-8000-000000000000")
const env = { SCHEDULER_SIGNING_SECRET: SECRET }

const verify = (overrides: Partial<Parameters<typeof verifySchedulerSignature>[0]> = {}) =>
  verifySchedulerSignature({ timestamp: TS, signature: schedulerSignature(SECRET, TS, BODY), rawBody: BODY, nowMs: NOW, env, ...overrides })

describe("scheduler signatures", () => {
  it("matches the research test vector, so the SQL and Node signers can't drift", () => {
    // key "k", message "1700000000.{}" (pgcrypto's hmac() gives the same hex)
    expect(schedulerSignature("k", "1700000000", "{}")).toBe("v1=c6ef4734033cee2367414a0939385eca0397754aa7a59716da7463a9298b5146")
  })

  it("writes the tick body in jsonb's text form, as pg_net sends it", () => {
    expect(tickBody(1792692060, "abc")).toBe('{"ts": 1792692060, "kind": "tick", "nonce": "abc"}')
  })

  it("accepts a fresh request signed with the current secret", () => {
    expect(verify()).toEqual({ ok: true })
  })

  it("accepts timestamps up to 300 seconds off either way, and refuses past that", () => {
    for (const offset of [-300, 300]) {
      const ts = String(NOW / 1000 + offset)
      expect(verify({ timestamp: ts, signature: schedulerSignature(SECRET, ts, BODY) })).toEqual({ ok: true })
    }
    for (const offset of [-301, 301, 3600]) {
      const ts = String(NOW / 1000 + offset)
      expect(verify({ timestamp: ts, signature: schedulerSignature(SECRET, ts, BODY) })).toEqual({ ok: false, reason: "stale_timestamp" })
    }
  })

  it("refuses timestamps that aren't whole seconds", () => {
    for (const ts of ["1792692060.5", "-1792692060", "1792692060000000", " 1792692060", "abc"]) {
      expect(verify({ timestamp: ts, signature: schedulerSignature(SECRET, ts, BODY) }), ts).toEqual({ ok: false, reason: "bad_timestamp" })
    }
  })

  it("accepts the previous secret while rotating, and nothing else", () => {
    const both = { SCHEDULER_SIGNING_SECRET: SECRET, SCHEDULER_SIGNING_SECRET_PREVIOUS: OLD_SECRET }
    expect(verify({ env: both, signature: schedulerSignature(OLD_SECRET, TS, BODY) })).toEqual({ ok: true })
    expect(verify({ env: both, signature: schedulerSignature(SECRET, TS, BODY) })).toEqual({ ok: true })
    expect(verify({ signature: schedulerSignature(OLD_SECRET, TS, BODY) })).toEqual({ ok: false, reason: "bad_signature" })
    expect(verify({ env: both, signature: schedulerSignature("c".repeat(64), TS, BODY) })).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("fails closed when no secret is set (or it's blank)", () => {
    for (const unset of [{}, { SCHEDULER_SIGNING_SECRET: "" }, { SCHEDULER_SIGNING_SECRET: "   " }, { SCHEDULER_SIGNING_SECRET_PREVIOUS: "" }]) {
      expect(verify({ env: unset })).toEqual({ ok: false, reason: "no_secret" })
    }
    // A request signed with an empty key gets nowhere either
    expect(verify({ env: { SCHEDULER_SIGNING_SECRET: "" }, signature: schedulerSignature("", TS, BODY) })).toEqual({ ok: false, reason: "no_secret" })
    expect(schedulerSecrets({})).toEqual([])
  })

  it("checks the raw text: the same JSON re-ordered or re-spaced fails", () => {
    const parsed = JSON.parse(BODY)
    for (const other of [JSON.stringify(parsed), JSON.stringify({ kind: parsed.kind, ts: parsed.ts, nonce: parsed.nonce }), BODY + " "]) {
      expect(verify({ rawBody: other })).toEqual({ ok: false, reason: "bad_signature" })
    }
  })

  it("refuses missing headers, a tampered timestamp and a signature in another form", () => {
    expect(verify({ timestamp: null })).toEqual({ ok: false, reason: "missing_headers" })
    expect(verify({ signature: "" })).toEqual({ ok: false, reason: "missing_headers" })
    const later = String(NOW / 1000 + 10)
    expect(verify({ timestamp: later })).toEqual({ ok: false, reason: "bad_signature" })
    const bare = schedulerSignature(SECRET, TS, BODY).slice(3)
    expect(verify({ signature: bare })).toEqual({ ok: false, reason: "bad_signature" })
    expect(verify({ signature: `v2=${bare}` })).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("keeps the two purposes apart: a tick signature doesn't verify as a hand-off, or the other way round", () => {
    const runSignature = schedulerSignature(SECRET, TS, BODY, "run")
    expect(runSignature).not.toBe(schedulerSignature(SECRET, TS, BODY))
    expect(verify({ purpose: "run" })).toEqual({ ok: false, reason: "bad_signature" })
    expect(verify({ purpose: "run", signature: runSignature })).toEqual({ ok: true })
    expect(verify({ signature: runSignature })).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("signs our own requests so the route's check passes, and refuses to sign without a secret", () => {
    const body = JSON.stringify({ jobId: "job-1" })
    const headers = new Headers(signSchedulerRequest(body, "run", { nowMs: NOW, env }))
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get(SCHEDULER_TIMESTAMP_HEADER)).toBe(TS)
    expect(headers.get(SCHEDULER_SIGNATURE_HEADER)).toMatch(/^v1=[0-9a-f]{64}$/)
    expect(verifySchedulerRequest(headers, body, "run", { nowMs: NOW + 1000, env })).toEqual({ ok: true })
    expect(verifySchedulerRequest(headers, body, "tick", { nowMs: NOW + 1000, env })).toEqual({ ok: false, reason: "bad_signature" })
    expect(() => signSchedulerRequest(body, "run", { env: {} })).toThrow(/SCHEDULER_SIGNING_SECRET/)
  })
})
