import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resend = vi.hoisted(() => ({ send: vi.fn(), batchSend: vi.fn() }))
const settings = vi.hoisted(() => ({ isEmailEnabled: vi.fn(), getEmailFromAddress: vi.fn() }))

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resend.send }
    batch = { send: resend.batchSend }
  },
}))
vi.mock("@/lib/email/settings", () => settings)

import { MAX_BATCH_EMAILS, RETRY_DELAYS_MS, sendBatchEmails, sendEmail } from "./resend"

const email = (n: number) => ({ to: `member${n}@utexas.edu`, subject: `Hello ${n}`, html: "<p>Hi</p>", text: "Hi" })
const failure = (name: string, message = name) => ({ data: null, error: { name, message }, headers: null })

/** Everything written to the console during a test, as one string */
function captureLogs() {
  const lines: string[] = []
  const record = (...args: unknown[]) => lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
  vi.spyOn(console, "log").mockImplementation(record)
  vi.spyOn(console, "error").mockImplementation(record)
  return () => lines.join("\n")
}

/** Runs a call that may wait between retries */
async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  const pending = run()
  await vi.runAllTimersAsync()
  return pending
}

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test")
  settings.isEmailEnabled.mockResolvedValue(true)
  settings.getEmailFromAddress.mockResolvedValue("Longhorn Sim Racing <noreply@notify.longhornsimracing.org>")
})
afterEach(() => {
  vi.useRealTimers()
})

describe("sendEmail", () => {
  it("sends with the idempotency key and returns the message id, without logging the recipient", async () => {
    const logs = captureLogs()
    resend.send.mockResolvedValue({ data: { id: "msg_1" }, error: null, headers: null })

    await expect(sendEmail(email(1), { idempotencyKey: "notifications-abc" })).resolves.toEqual({ success: true, messageId: "msg_1" })
    expect(resend.send).toHaveBeenCalledWith(expect.objectContaining({ to: "member1@utexas.edu" }), { idempotencyKey: "notifications-abc" })
    expect(logs()).not.toContain("member1@utexas.edu")
  })

  it("skips when email is turned off, without logging the recipient", async () => {
    const logs = captureLogs()
    settings.isEmailEnabled.mockResolvedValue(false)

    await expect(sendEmail(email(1))).resolves.toMatchObject({ success: false, error: "Email system disabled" })
    expect(resend.send).not.toHaveBeenCalled()
    expect(logs()).not.toContain("@utexas.edu")
  })

  it("skips when there's no API key", async () => {
    captureLogs()
    vi.stubEnv("RESEND_API_KEY", "")
    await expect(sendEmail(email(1))).resolves.toMatchObject({ success: false })
    expect(resend.send).not.toHaveBeenCalled()
  })

  it("redacts addresses that Resend quotes in an error", async () => {
    const logs = captureLogs()
    resend.send.mockResolvedValue(failure("validation_error", "Invalid `to` field: member1@utexas.edu"))

    await expect(sendEmail(email(1))).resolves.toMatchObject({ success: false })
    expect(logs()).toContain("<address>")
    expect(logs()).not.toContain("member1@utexas.edu")
  })

  it("retries a transient failure with the same key", async () => {
    captureLogs()
    resend.send.mockResolvedValueOnce(failure("internal_server_error")).mockResolvedValueOnce({ data: { id: "msg_2" }, error: null, headers: null })

    const result = await withFakeTimers(() => sendEmail(email(1), { idempotencyKey: "k1" }))

    expect(result).toEqual({ success: true, messageId: "msg_2" })
    expect(resend.send).toHaveBeenCalledTimes(2)
    expect(resend.send.mock.calls.map((call) => call[1])).toEqual([{ idempotencyKey: "k1" }, { idempotencyKey: "k1" }])
  })

  it("treats a thrown network error as transient", async () => {
    captureLogs()
    resend.send.mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValueOnce({ data: { id: "msg_3" }, error: null, headers: null })
    await expect(withFakeTimers(() => sendEmail(email(1)))).resolves.toEqual({ success: true, messageId: "msg_3" })
  })

  it("gives up after the last retry", async () => {
    captureLogs()
    resend.send.mockResolvedValue(failure("rate_limit_exceeded", "Too many requests"))
    const result = await withFakeTimers(() => sendEmail(email(1)))
    expect(result).toEqual({ success: false, error: "Too many requests" })
    expect(resend.send).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1)
  })

  it("doesn't retry errors that won't clear, like the daily quota", async () => {
    captureLogs()
    resend.send.mockResolvedValue(failure("daily_quota_exceeded", "You have reached your daily email sending quota"))
    await expect(sendEmail(email(1))).resolves.toMatchObject({ success: false })
    expect(resend.send).toHaveBeenCalledTimes(1)
  })
})

describe("sendBatchEmails", () => {
  it("sends with permissive validation and the idempotency key, and maps results back in order", async () => {
    const logs = captureLogs()
    resend.batchSend.mockResolvedValue({
      data: { data: [{ id: "a" }, { id: "c" }], errors: [{ index: 1, message: "Invalid `to` field: member2@utexas.edu" }] },
      error: null,
      headers: null,
    })

    const results = await sendBatchEmails([email(1), email(2), email(3)], { idempotencyKey: "batch-1" })

    expect(resend.batchSend).toHaveBeenCalledWith(expect.any(Array), { batchValidation: "permissive", idempotencyKey: "batch-1" })
    expect(resend.batchSend.mock.calls[0][0]).toHaveLength(3)
    expect(results).toEqual([
      { success: true, messageId: "a" },
      { success: false, error: "Invalid `to` field: member2@utexas.edu" },
      { success: true, messageId: "c" },
    ])
    expect(logs()).not.toContain("@utexas.edu")
  })

  it("treats a missing errors list as no rejections", async () => {
    captureLogs()
    resend.batchSend.mockResolvedValue({ data: { data: [{ id: "a" }, { id: "b" }] }, error: null, headers: null })
    await expect(sendBatchEmails([email(1), email(2)])).resolves.toEqual([
      { success: true, messageId: "a" },
      { success: true, messageId: "b" },
    ])
  })

  it("logs when Resend returns the wrong number of ids", async () => {
    const logs = captureLogs()
    resend.batchSend.mockResolvedValue({ data: { data: [{ id: "a" }], errors: [] }, error: null, headers: null })
    const results = await sendBatchEmails([email(1), email(2)])
    expect(results[1]).toEqual({ success: true, messageId: undefined })
    expect(logs()).toContain("Batch returned 1 ids for 2 accepted emails")
  })

  it("fails every email when the quota is used up, without retrying", async () => {
    captureLogs()
    resend.batchSend.mockResolvedValue(failure("daily_quota_exceeded", "You have reached your daily email sending quota"))

    const results = await sendBatchEmails([email(1), email(2)])
    expect(results.every((r) => !r.success && r.error?.includes("daily email sending quota"))).toBe(true)
    expect(resend.batchSend).toHaveBeenCalledTimes(1)
  })

  it("retries a transient batch failure with the same key", async () => {
    captureLogs()
    resend.batchSend
      .mockResolvedValueOnce(failure("application_error", "Unable to fetch data"))
      .mockResolvedValueOnce({ data: { data: [{ id: "a" }, { id: "b" }], errors: [] }, error: null, headers: null })

    const results = await withFakeTimers(() => sendBatchEmails([email(1), email(2)], { idempotencyKey: "batch-2" }))

    expect(results.every((r) => r.success)).toBe(true)
    expect(resend.batchSend.mock.calls.map((call) => call[1].idempotencyKey)).toEqual(["batch-2", "batch-2"])
  })

  it("skips the call when email is turned off", async () => {
    captureLogs()
    settings.isEmailEnabled.mockResolvedValue(false)
    const results = await sendBatchEmails([email(1), email(2)])
    expect(results).toHaveLength(2)
    expect(resend.batchSend).not.toHaveBeenCalled()
  })

  it("refuses more than Resend's batch limit", async () => {
    const emails = Array.from({ length: MAX_BATCH_EMAILS + 1 }, (_, i) => email(i))
    await expect(sendBatchEmails(emails)).rejects.toThrow(/at most 100/)
    expect(resend.batchSend).not.toHaveBeenCalled()
  })
})
