import { beforeEach, describe, expect, it, vi } from "vitest"

const resend = vi.hoisted(() => ({ send: vi.fn(), batchSend: vi.fn() }))
const settings = vi.hoisted(() => ({ isEmailEnabled: vi.fn(), getEmailFromAddress: vi.fn() }))

vi.mock("resend", () => ({
  Resend: vi.fn(function () {
    return { emails: { send: resend.send }, batch: { send: resend.batchSend } }
  }),
}))
vi.mock("@/lib/email/settings", () => settings)

import { MAX_BATCH_EMAILS, sendBatchEmails, sendEmail } from "./resend"

const email = (n: number) => ({ to: `member${n}@utexas.edu`, subject: `Hello ${n}`, html: "<p>Hi</p>", text: "Hi" })

/** Everything written to the console during a test, as one string */
function captureLogs() {
  const lines: string[] = []
  const record = (...args: unknown[]) => lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
  vi.spyOn(console, "log").mockImplementation(record)
  vi.spyOn(console, "error").mockImplementation(record)
  return () => lines.join("\n")
}

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test")
  settings.isEmailEnabled.mockResolvedValue(true)
  settings.getEmailFromAddress.mockResolvedValue("Longhorn Sim Racing <noreply@notify.longhornsimracing.org>")
})

describe("sendEmail", () => {
  it("sends and returns the message id without logging the recipient", async () => {
    const logs = captureLogs()
    resend.send.mockResolvedValue({ data: { id: "msg_1" }, error: null })

    await expect(sendEmail(email(1))).resolves.toEqual({ success: true, messageId: "msg_1" })
    expect(resend.send).toHaveBeenCalledWith(expect.objectContaining({ to: "member1@utexas.edu", subject: "Hello 1" }))
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
    resend.send.mockResolvedValue({ data: null, error: { message: "Invalid `to` field: member1@utexas.edu", name: "validation_error" } })

    await expect(sendEmail(email(1))).resolves.toMatchObject({ success: false })
    expect(logs()).toContain("<address>")
    expect(logs()).not.toContain("member1@utexas.edu")
  })
})

describe("sendBatchEmails", () => {
  it("sends with permissive validation and maps results back in order", async () => {
    const logs = captureLogs()
    resend.batchSend.mockResolvedValue({
      data: { data: [{ id: "a" }, { id: "c" }], errors: [{ index: 1, message: "Invalid `to` field: member2@utexas.edu" }] },
      error: null,
    })

    const results = await sendBatchEmails([email(1), email(2), email(3)])

    expect(resend.batchSend).toHaveBeenCalledWith(expect.any(Array), { batchValidation: "permissive" })
    expect(resend.batchSend.mock.calls[0][0]).toHaveLength(3)
    expect(results).toEqual([
      { success: true, messageId: "a" },
      { success: false, error: "Invalid `to` field: member2@utexas.edu" },
      { success: true, messageId: "c" },
    ])
    expect(logs()).not.toContain("@utexas.edu")
  })

  it("fails every email when the whole call fails", async () => {
    captureLogs()
    resend.batchSend.mockResolvedValue({ data: null, error: { message: "Daily quota exceeded", name: "rate_limit_exceeded" } })

    const results = await sendBatchEmails([email(1), email(2)])
    expect(results).toEqual([
      { success: false, error: "Daily quota exceeded" },
      { success: false, error: "Daily quota exceeded" },
    ])
  })

  it("fails every email when the call throws", async () => {
    captureLogs()
    resend.batchSend.mockRejectedValue(new Error("socket hang up"))
    const results = await sendBatchEmails([email(1), email(2)])
    expect(results.every((r) => !r.success)).toBe(true)
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
