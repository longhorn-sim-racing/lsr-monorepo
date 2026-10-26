import { describe, expect, it } from "vitest"
import { activitySchema, normalizeWebsite, prospectChangesSchema, prospectFieldsSchema } from "./sponsor-prospect.schema"

describe("normalizeWebsite", () => {
  it("adds https to a bare domain and keeps full links", () => {
    expect(normalizeWebsite("acme.com")).toBe("https://acme.com/")
    expect(normalizeWebsite("http://acme.com/sponsor")).toBe("http://acme.com/sponsor")
  })

  it("refuses what isn't a web address", () => {
    for (const bad of ["javascript:alert(1)", "mailto:a@b.com", "not a site", "localhost", "https://user:pass@acme.com", ""]) expect(normalizeWebsite(bad), bad).toBeNull()
  })
})

describe("prospectFieldsSchema", () => {
  it("fills defaults and turns blank text into nothing", () => {
    expect(prospectFieldsSchema.parse({ company: " Acme ", website: "", contactEmail: "  " })).toEqual({
      company: "Acme",
      website: null,
      contactName: null,
      contactEmail: null,
      contactRole: null,
      stage: "idea",
      tierInterest: null,
      ownerId: null,
      nextStep: null,
      nextStepDue: null,
      notes: null,
    })
  })

  it("normalizes the website and email", () => {
    const parsed = prospectFieldsSchema.parse({ company: "Acme", website: "acme.com", contactEmail: "Jordan@Acme.example" })
    expect(parsed.website).toBe("https://acme.com/")
    expect(parsed.contactEmail).toBe("jordan@acme.example")
  })

  it("refuses a missing company, a bad email or website, and unknown stages and tiers", () => {
    expect(prospectFieldsSchema.safeParse({ company: "" }).success).toBe(false)
    expect(prospectFieldsSchema.safeParse({ company: "Acme", contactEmail: "jordan at acme" }).success).toBe(false)
    expect(prospectFieldsSchema.safeParse({ company: "Acme", website: "javascript:alert(1)" }).success).toBe(false)
    expect(prospectFieldsSchema.safeParse({ company: "Acme", stage: "maybe" }).success).toBe(false)
    expect(prospectFieldsSchema.safeParse({ company: "Acme", tierInterest: "diamond" }).success).toBe(false)
  })
})

describe("prospectChangesSchema", () => {
  it("keeps only what's given; blank clears", () => {
    expect(prospectChangesSchema.parse({ stage: "talking" })).toEqual({ stage: "talking" })
    expect(prospectChangesSchema.parse({ nextStep: "", tierInterest: "" })).toEqual({ nextStep: null, tierInterest: null })
  })
})

it("needs an activity's type, text and time", () => {
  expect(activitySchema.safeParse({ type: "call", summary: "Talked budgets", occurredAt: new Date() }).success).toBe(true)
  expect(activitySchema.safeParse({ type: "stage_change", summary: "x", occurredAt: new Date() }).success).toBe(false)
  expect(activitySchema.safeParse({ type: "call", summary: " ", occurredAt: new Date() }).success).toBe(false)
})
