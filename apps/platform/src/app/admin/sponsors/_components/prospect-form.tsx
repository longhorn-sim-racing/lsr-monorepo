"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button, Field, FieldGrid, FormActions, FormSection, Input, Notice, Panel, PanelBody, PanelFooter, Select, Textarea } from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { PROSPECT_STAGE_LABEL, PROSPECT_STAGES, prospectPath, TIER_IDS, TIER_LABEL } from "@/lib/sponsor-prospects"
import { PROSPECT_LIMITS } from "@/schemas/sponsor-prospect.schema"
import { saveProspect, type ProspectFormInput, type SaveProspectResult } from "../actions"

/** The fields an edit sends: only the ones the officer changed, so a save can't undo someone else's change to the rest */
function changedFields(form: ProspectFormInput, initial: ProspectFormInput): Partial<ProspectFormInput> {
  return Object.fromEntries(Object.entries(form).filter(([key, value]) => value !== initial[key as keyof ProspectFormInput]))
}

/** Adds a prospect, or edits one (sending only what changed). A company that's already a prospect links to it instead */
export function ProspectForm({ id, initial, owners, compact = false }: { id: string | null; initial: ProspectFormInput; owners: { id: string; displayName: string }[]; compact?: boolean }) {
  const router = useRouter()
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [duplicateId, setDuplicateId] = useState<string | null>(null)

  const set = (key: keyof ProspectFormInput) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: event.target.value }))

  async function save() {
    setSaving(true)
    let result: SaveProspectResult
    try {
      result = await saveProspect(id, id ? changedFields(form, initial) : form)
    } catch (error) {
      result = { ok: false, error: unexpectedError(error, "Couldn't save the prospect") }
    } finally {
      setSaving(false)
    }
    if (!result.ok) {
      setDuplicateId(result.duplicateId ?? null)
      if (!result.duplicateId) toast.error(result.error)
      return
    }
    setDuplicateId(null)
    toast.success(id ? "Saved" : "Prospect added")
    if (!id) router.replace(prospectPath(result.id))
    else router.refresh()
  }

  // In a side panel the fields stack, whatever the screen width
  const grid = compact ? "sm:grid-cols-1" : undefined
  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <Panel>
        <PanelBody className="flex flex-col gap-5">
          {duplicateId && (
            <Notice
              tone="warning"
              title="That company is already a prospect"
              action={
                <Button size="sm" asChild>
                  <Link href={prospectPath(duplicateId)}>Open it</Link>
                </Button>
              }
            >
              Update the one that&apos;s there instead of adding it twice.
            </Notice>
          )}
          <FormSection title="Company">
            <FieldGrid className={grid}>
              <Field label="Company" htmlFor="prospect-company" required>
                <Input id="prospect-company" value={form.company} maxLength={PROSPECT_LIMITS.companyMax} onChange={set("company")} />
              </Field>
              <Field label="Website" htmlFor="prospect-website" hint="acme.com or a full link">
                <Input id="prospect-website" value={form.website} maxLength={PROSPECT_LIMITS.websiteMax} onChange={set("website")} />
              </Field>
              <Field label="Stage" htmlFor="prospect-stage">
                <Select id="prospect-stage" value={form.stage} onChange={set("stage")}>
                  {PROSPECT_STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {PROSPECT_STAGE_LABEL[stage]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tier interest" htmlFor="prospect-tier" hint="The package they're considering">
                <Select id="prospect-tier" value={form.tierInterest} onChange={set("tierInterest")}>
                  <option value="">Not known</option>
                  {TIER_IDS.map((tier) => (
                    <option key={tier} value={tier}>
                      {TIER_LABEL[tier]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Owner" htmlFor="prospect-owner" hint="The officer handling it" className={compact ? undefined : "sm:col-span-2"}>
                <Select id="prospect-owner" value={form.ownerId} onChange={set("ownerId")}>
                  <option value="">No owner</option>
                  {owners.map((owner) => (
                    <option key={owner.id} value={owner.id}>
                      {owner.displayName}
                    </option>
                  ))}
                </Select>
              </Field>
            </FieldGrid>
          </FormSection>

          <hr className="border-admin-row" />

          <FormSection title="Contact" description="Who the club talks to there.">
            <FieldGrid className={grid}>
              <Field label="Name" htmlFor="prospect-contact-name">
                <Input id="prospect-contact-name" value={form.contactName} maxLength={PROSPECT_LIMITS.nameMax} onChange={set("contactName")} autoComplete="off" />
              </Field>
              <Field label="Role" htmlFor="prospect-contact-role" hint="e.g. Marketing manager">
                <Input id="prospect-contact-role" value={form.contactRole} maxLength={PROSPECT_LIMITS.roleMax} onChange={set("contactRole")} autoComplete="off" />
              </Field>
              <Field label="Email" htmlFor="prospect-contact-email" className={compact ? undefined : "sm:col-span-2"}>
                <Input id="prospect-contact-email" type="email" value={form.contactEmail} maxLength={PROSPECT_LIMITS.emailMax} onChange={set("contactEmail")} autoComplete="off" />
              </Field>
            </FieldGrid>
          </FormSection>

          <hr className="border-admin-row" />

          <FormSection title="Next step">
            <FieldGrid className={grid}>
              <Field label="Next step" htmlFor="prospect-next-step" hint="e.g. Send the sponsor packet">
                <Input id="prospect-next-step" value={form.nextStep} maxLength={PROSPECT_LIMITS.nextStepMax} onChange={set("nextStep")} />
              </Field>
              <Field label="Due" htmlFor="prospect-next-step-due">
                <Input id="prospect-next-step-due" type="date" value={form.nextStepDue} onChange={set("nextStepDue")} />
              </Field>
              <Field label="Notes" htmlFor="prospect-notes" className={compact ? undefined : "sm:col-span-2"}>
                <Textarea id="prospect-notes" rows={compact ? 4 : 5} value={form.notes} maxLength={PROSPECT_LIMITS.notesMax} onChange={set("notes")} />
              </Field>
            </FieldGrid>
          </FormSection>
        </PanelBody>
        <PanelFooter>
          <FormActions className="w-full" note={id ? "Changing the stage adds it to the activity log." : undefined}>
            <Button type="submit" variant="primary" pending={saving}>
              {id ? "Save" : "Add prospect"}
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </form>
  )
}
