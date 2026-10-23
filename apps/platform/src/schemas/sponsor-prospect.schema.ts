import { z } from "zod"
import { ACTIVITY_TYPES, PROSPECT_STAGES, TIER_IDS } from "@/lib/sponsor-prospects"

/**
 * A sponsor prospect's fields, checked the same way from the Sponsors page, Jack's proposals and the
 * import target (#188). Blank text clears a field.
 */

export const PROSPECT_LIMITS = {
  companyMax: 120,
  websiteMax: 300,
  nameMax: 120,
  emailMax: 254,
  roleMax: 120,
  nextStepMax: 300,
  notesMax: 4_000,
  activityMax: 1_000,
} as const

const blankToNull = (value: unknown) => (typeof value === "string" && !value.trim() ? null : value)

/** "acme.com" → "https://acme.com"; null when it isn't a web address */
export function normalizeWebsite(value: string): string | null {
  const raw = value.trim()
  if (!raw || /\s/.test(raw)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (!url.hostname.includes(".") || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

const optionalText = (max: number, what: string) =>
  z.preprocess(blankToNull, z.string().trim().max(max, `Keep ${what} to ${max.toLocaleString("en-US")} characters.`).nullable())

export const prospectWebsiteSchema = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .max(PROSPECT_LIMITS.websiteMax, "That website link is too long.")
    .transform((value, ctx) => {
      const url = normalizeWebsite(value)
      if (!url) {
        ctx.addIssue({ code: "custom", message: "The website must be a web address, like acme.com or https://acme.com." })
        return z.NEVER
      }
      return url
    })
    .nullable(),
)

export const prospectEmailSchema = z.preprocess(
  blankToNull,
  z.string().trim().toLowerCase().max(PROSPECT_LIMITS.emailMax).pipe(z.email("The contact email doesn't look like an email address.")).nullable(),
)

/** Every field of a prospect, as the service stores them */
export const prospectFieldsSchema = z.object({
  company: z.string().trim().min(1, "Give the company's name.").max(PROSPECT_LIMITS.companyMax, `Keep the company name to ${PROSPECT_LIMITS.companyMax} characters.`),
  website: prospectWebsiteSchema.default(null),
  contactName: optionalText(PROSPECT_LIMITS.nameMax, "the contact's name").default(null),
  contactEmail: prospectEmailSchema.default(null),
  contactRole: optionalText(PROSPECT_LIMITS.roleMax, "the contact's role").default(null),
  stage: z.enum(PROSPECT_STAGES).default("idea"),
  tierInterest: z.preprocess(blankToNull, z.enum(TIER_IDS).nullable()).default(null),
  ownerId: z.preprocess(blankToNull, z.string().min(1).nullable()).default(null),
  nextStep: optionalText(PROSPECT_LIMITS.nextStepMax, "the next step").default(null),
  nextStepDue: z.date().nullable().default(null),
  notes: optionalText(PROSPECT_LIMITS.notesMax, "the notes").default(null),
})

export type ProspectFields = z.output<typeof prospectFieldsSchema>
export type ProspectFieldKey = keyof ProspectFields

/** A change to a prospect: only the fields given change */
export const prospectChangesSchema = z.object({
  company: prospectFieldsSchema.shape.company.optional(),
  website: prospectWebsiteSchema.optional(),
  contactName: optionalText(PROSPECT_LIMITS.nameMax, "the contact's name").optional(),
  contactEmail: prospectEmailSchema.optional(),
  contactRole: optionalText(PROSPECT_LIMITS.roleMax, "the contact's role").optional(),
  stage: z.enum(PROSPECT_STAGES).optional(),
  tierInterest: z.preprocess(blankToNull, z.enum(TIER_IDS).nullable()).optional(),
  ownerId: z.preprocess(blankToNull, z.string().min(1).nullable()).optional(),
  nextStep: optionalText(PROSPECT_LIMITS.nextStepMax, "the next step").optional(),
  nextStepDue: z.date().nullable().optional(),
  notes: optionalText(PROSPECT_LIMITS.notesMax, "the notes").optional(),
})

export type ProspectChanges = z.output<typeof prospectChangesSchema>

/** What officers call each field (diffs, audit summaries) */
export const PROSPECT_FIELD_LABEL: Record<ProspectFieldKey, string> = {
  company: "Company",
  website: "Website",
  contactName: "Contact",
  contactEmail: "Contact email",
  contactRole: "Contact's role",
  stage: "Stage",
  tierInterest: "Tier interest",
  ownerId: "Owner",
  nextStep: "Next step",
  nextStepDue: "Next step due",
  notes: "Notes",
}

/**
 * Fields that can hold a person's details (a next step often names or addresses the contact): never
 * copied into the audit log, which still names them as changed, so deleting a prospect removes them
 */
export const PROSPECT_PERSONAL_FIELDS: readonly ProspectFieldKey[] = ["contactName", "contactEmail", "contactRole", "nextStep", "notes"]

/** One activity an officer logs */
export const activitySchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  summary: z.string().trim().min(1, "Say what happened.").max(PROSPECT_LIMITS.activityMax, `Keep it to ${PROSPECT_LIMITS.activityMax.toLocaleString("en-US")} characters.`),
  occurredAt: z.date(),
})

export type ActivityInput = z.output<typeof activitySchema>
