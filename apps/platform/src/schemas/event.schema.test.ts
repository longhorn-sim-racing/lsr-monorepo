import { describe, expect, it } from "vitest"
import { slugify } from "@/lib/slug"
import { parseEventForm, parseRegistrationConfigForm } from "./event.schema"

const BASE: Record<string, string> = {
  title: "Sim Night",
  slug: "sim-night-oct",
  timezone: "America/Chicago",
  seriesId: "",
  venueId: "",
  startsAtUtc: "2026-10-20T19:00",
  endsAtUtc: "2026-10-20T22:00",
  summary: "Open sims",
  description: "",
  heroImageUrl: "",
  streamUrl: "",
  registrationOpensAt: "",
  registrationClosesAt: "",
  registrationMax: "",
  registrationFeeCents: "",
  attendanceOpensAt: "",
  attendanceClosesAt: "",
}

function form(fields: Record<string, string> = {}) {
  const data = new FormData()
  for (const [key, value] of Object.entries({ ...BASE, ...fields })) data.set(key, value)
  return data
}

function errorOf(fields: Record<string, string>) {
  const result = parseEventForm(form(fields))
  if (result.ok) throw new Error("expected the form to be rejected")
  return result.error
}

describe("parseEventForm", () => {
  it("accepts a valid event and reads times in its zone", () => {
    const result = parseEventForm(form())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.startsAtUtc.toISOString()).toBe("2026-10-21T00:00:00.000Z")
    expect(result.data.endsAtUtc.toISOString()).toBe("2026-10-21T03:00:00.000Z")
    expect(result.data).toMatchObject({
      seriesId: null,
      venueId: null,
      heroImageUrl: null,
      registrationMax: null,
      registrationFeeCents: null,
      registrationEnabled: false,
      attendanceEnabled: false,
    })
  })

  it("reads the switches", () => {
    const result = parseEventForm(form({ registrationEnabled: "on", attendanceEnabled: "on", registrationWaitlistEnabled: "on" }))
    expect(result.ok && result.data).toMatchObject({ registrationEnabled: true, attendanceEnabled: true, registrationWaitlistEnabled: true })
  })

  describe("fee", () => {
    it("converts dollars to cents", () => {
      const result = parseEventForm(form({ registrationFeeCents: "12.50" }))
      expect(result.ok && result.data.registrationFeeCents).toBe(1250)
    })

    it("treats 0 or empty as free", () => {
      for (const fee of ["0", "0.00", ""]) {
        const result = parseEventForm(form({ registrationFeeCents: fee }))
        expect(result.ok && result.data.registrationFeeCents).toBeNull()
      }
    })

    it("rejects amounts under Stripe's minimum and non-amounts", () => {
      expect(errorOf({ registrationFeeCents: "0.25" })).toMatch(/at least \$0\.50/)
      expect(errorOf({ registrationFeeCents: "abc" })).toMatch(/in dollars/)
      expect(errorOf({ registrationFeeCents: "10.555" })).toMatch(/in dollars/)
    })
  })

  describe("capacity", () => {
    it("treats empty or -1 as unlimited", () => {
      for (const max of ["", "-1"]) {
        const result = parseEventForm(form({ registrationMax: max }))
        expect(result.ok && result.data.registrationMax).toBeNull()
      }
    })

    it("needs a whole number of at least 1", () => {
      expect(parseEventForm(form({ registrationMax: "20" }))).toMatchObject({ ok: true, data: { registrationMax: 20 } })
      for (const max of ["0", "2.5", "abc", "-3"]) {
        expect(errorOf({ registrationMax: max })).toMatch(/whole number/)
      }
    })
  })

  describe("times", () => {
    it("allows an event that ends when it starts, not before", () => {
      expect(parseEventForm(form({ endsAtUtc: BASE.startsAtUtc })).ok).toBe(true)
      expect(errorOf({ endsAtUtc: "2026-10-20T18:00" })).toMatch(/can't end before it starts/)
    })

    it("needs start and end", () => {
      expect(errorOf({ startsAtUtc: "" })).toMatch(/when the event starts/)
      expect(errorOf({ endsAtUtc: "" })).toMatch(/when the event ends/)
    })

    it("needs registration and check-in windows to close after they open", () => {
      expect(errorOf({ registrationOpensAt: "2026-10-10T10:00", registrationClosesAt: "2026-10-09T10:00" })).toMatch(
        /Registration must close after it opens/
      )
      expect(errorOf({ attendanceOpensAt: "2026-10-20T19:00", attendanceClosesAt: "2026-10-20T19:00" })).toMatch(
        /Check-in must close after it opens/
      )
    })

    it("accepts an open-ended window", () => {
      const result = parseEventForm(form({ registrationOpensAt: "2026-10-10T10:00" }))
      expect(result.ok && result.data.registrationClosesAt).toBeNull()
    })

    it("rejects an unknown time zone", () => {
      expect(errorOf({ timezone: "Mars/Olympus_Mons" })).toMatch(/time zone/)
    })
  })

  describe("text fields", () => {
    it("needs a title", () => {
      expect(errorOf({ title: "   " })).toMatch(/title/)
    })

    it("needs full links", () => {
      expect(errorOf({ streamUrl: "twitch.tv/longhornsimracing" })).toMatch(/stream link/)
      expect(parseEventForm(form({ streamUrl: "https://twitch.tv/longhornsimracing" })).ok).toBe(true)
    })

    it("accepts every slug slugify() can produce, and rejects hand-typed ones it couldn't", () => {
      for (const title of ["General Meeting 1", "LSC S3 Round 7 @ Mount Panorama", "LSR x LCC Tabling: featuring DSC Racing", "sim_night"]) {
        expect(parseEventForm(form({ slug: slugify(title) })).ok).toBe(true)
      }
      for (const slug of ["GM1-Fall", "gm1--fall", "-gm1", "gm 1", ""]) {
        expect(errorOf({ slug })).toMatch(/slug/)
      }
    })
  })

  it("lists every problem at once", () => {
    const error = errorOf({ title: "", slug: "Bad Slug", streamUrl: "nope" })
    expect(error).toMatch(/title/)
    expect(error).toMatch(/slug/)
    expect(error).toMatch(/stream link/)
  })
})

describe("parseRegistrationConfigForm", () => {
  function config(fields: Record<string, string>) {
    const data = new FormData()
    for (const [key, value] of Object.entries({ registrationOpensAt: "", registrationClosesAt: "", registrationMax: "", registrationFeeCents: "", ...fields })) {
      data.set(key, value)
    }
    return parseRegistrationConfigForm(data, "America/Chicago")
  }

  it("reads the settings card", () => {
    expect(config({ registrationFeeCents: "5", registrationMax: "12", waitlistAutoPromote: "on", registrationEnabled: "on" })).toEqual({
      ok: true,
      data: {
        registrationEnabled: true,
        registrationOpensAt: null,
        registrationClosesAt: null,
        registrationMax: 12,
        registrationWaitlistEnabled: false,
        waitlistAutoPromote: true,
        registrationFeeCents: 500,
      },
    })
  })

  it("applies the same rules as the event form", () => {
    expect(config({ registrationFeeCents: "0.10" })).toMatchObject({ ok: false })
    expect(config({ registrationOpensAt: "2026-10-10T10:00", registrationClosesAt: "2026-10-01T10:00" })).toMatchObject({ ok: false })
  })
})
