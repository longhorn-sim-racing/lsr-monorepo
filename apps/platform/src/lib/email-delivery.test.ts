import { describe, expect, it } from "vitest"
import { deliveryStatus, isUndelivered } from "./email-delivery"

describe("deliveryStatus", () => {
  it("works from every event, not the last to arrive", () => {
    // Opened can land before delivered; delivered can land after a bounce report on a retried delivery
    expect(deliveryStatus(["email.opened", "email.sent", "email.delivered"])).toBe("opened")
    expect(deliveryStatus(["email.bounced", "email.sent"])).toBe("bounced")
    expect(deliveryStatus(["email.sent", "email.delivery_delayed"])).toBe("delayed")
    expect(deliveryStatus(["email.delivery_delayed", "email.bounced", "email.sent"])).toBe("bounced")
    expect(deliveryStatus(["email.sent"])).toBe("sent")
  })

  it("puts a complaint above everything, and a click above an open", () => {
    expect(deliveryStatus(["email.sent", "email.delivered", "email.clicked", "email.complained"])).toBe("complained")
    expect(deliveryStatus(["email.delivered", "email.opened", "email.clicked"])).toBe("clicked")
    expect(deliveryStatus(["email.failed", "email.suppressed"])).toBe("failed")
  })

  it("is null without events, and ignores types it doesn't know", () => {
    expect(deliveryStatus([])).toBeNull()
    expect(deliveryStatus(["contact.created"])).toBeNull()
  })

  it("tells undelivered statuses apart", () => {
    expect(["bounced", "complained", "failed", "suppressed"].every((s) => isUndelivered(s as never))).toBe(true)
    expect(["delivered", "delayed", "sent", "opened"].some((s) => isUndelivered(s as never))).toBe(false)
    expect(isUndelivered(null)).toBe(false)
  })
})
