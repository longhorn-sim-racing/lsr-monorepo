import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { NotificationDelivery, type DeliveryTabData } from "./notification-delivery"

const zero = { complained: 0, bounced: 0, failed: 0, suppressed: 0, clicked: 0, opened: 0, delivered: 0, delayed: 0, sent: 0 }
const render = (data: DeliveryTabData) => renderToStaticMarkup(createElement(NotificationDelivery, { data }))

describe("the Delivery tab", () => {
  it("shows how email turned out and lists the addresses that bounced, linking members", () => {
    const html = render({
      configured: true,
      enabled: true,
      lastEventAt: "2026-10-21T23:00:00.000Z",
      counts: { emails: 40, byStatus: { ...zero, delivered: 36, opened: 1, bounced: 2, complained: 1 } },
      bounces: {
        total: 1,
        rows: [
          {
            recipient: "member@example.com",
            failed: 2,
            lastStatus: "bounced",
            lastAt: new Date("2026-10-21T23:00:00Z"),
            reason: "Permanent: No such user",
            deliveredSince: true,
            lastEmail: { kind: "notification", subject: "GM 2 is tonight", detail: null, link: "/admin/notifications" },
            member: { id: "u1", displayName: "Test Member" },
          },
        ],
      },
    })
    expect(html).toContain("92.5%")
    expect(html).toContain('href="/admin/users/u1/edit"')
    expect(html).toContain("GM 2 is tonight")
    expect(html).toContain("2 emails didn&#x27;t arrive")
    expect(html).toContain("Permanent: No such user")
    expect(html).toContain("A later email arrived")
    expect(html).not.toContain("Delivery tracking isn&#x27;t set up")
    expect(html).not.toContain("switched off")
  })

  it("says tracking isn't set up, with no bounces to show", () => {
    const html = render({ configured: false, enabled: false, lastEventAt: null, counts: { emails: 0, byStatus: zero }, bounces: { rows: [], total: 0 } })
    expect(html).toContain("Delivery tracking isn&#x27;t set up")
    expect(html).toContain("Nothing is reported until delivery tracking is set up.")
  })

  it("says when tracking is switched off, and doesn't call an empty list good news", () => {
    const html = render({ configured: true, enabled: false, lastEventAt: null, counts: { emails: 0, byStatus: zero }, bounces: { rows: [], total: 0 } })
    expect(html).toContain("Delivery tracking is switched off")
    expect(html).toContain("nothing new is kept while delivery tracking is switched off")
    expect(html).not.toContain("Every reported email")
  })

  it("shows a warning in place of the numbers when loading failed", () => {
    const html = render({ configured: true, failed: true })
    expect(html).toContain("Couldn&#x27;t load this part of the page")
    expect(html).not.toContain("No bounces")
    expect(html).not.toContain("Emails reported")
    expect(html).not.toContain("Every reported email")
  })
})
