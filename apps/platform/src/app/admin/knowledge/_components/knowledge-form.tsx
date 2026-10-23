"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Button,
  CheckboxField,
  Field,
  FieldGrid,
  FormActions,
  FormSection,
  Input,
  Notice,
  Panel,
  PanelBody,
  PanelFooter,
  Select,
  Textarea,
} from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { KNOWLEDGE_LIMITS, knowledgeEntryPath } from "@/lib/jack/knowledge"
import { saveKnowledgeEntry, type KnowledgeFormInput, type SaveKnowledgeResult } from "../actions"

const MARKDOWN_HINT = "Markdown: ## Section, - bullet, 1. numbered, **bold**, [link](https://…). One topic per entry; Jack quotes it when he cites it."

/** The fields an edit sends: only the ones the officer changed, so a save can't undo someone else's change to the rest */
function changedFields(form: KnowledgeFormInput, initial: KnowledgeFormInput): Partial<KnowledgeFormInput> {
  return Object.fromEntries(Object.entries(form).filter(([key, value]) => value !== initial[key as keyof KnowledgeFormInput]))
}

/**
 * Writes a new entry or edits one. An edit carries the version it was opened at, so saving over
 * someone else's newer text is refused instead of losing it (the page remounts this form on every new
 * version), and sends only the fields that changed. A new entry that looks like an existing one asks first.
 */
export function KnowledgeForm({
  id,
  baseVersionId,
  initial,
  owners,
  reviewed,
}: {
  id: string | null
  baseVersionId: string | null
  initial: KnowledgeFormInput
  owners: { id: string; displayName: string }[]
  /** Whether the entry is reviewed and fresh already (then "Mark reviewed" starts unticked) */
  reviewed: boolean
}) {
  const router = useRouter()
  const [form, setForm] = useState(initial)
  const [markReviewed, setMarkReviewed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [duplicates, setDuplicates] = useState<{ id: string; title: string }[] | null>(null)
  const [conflict, setConflict] = useState(false)

  const set = (key: keyof KnowledgeFormInput) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: event.target.value }))

  async function save(notDuplicateOf?: string[]) {
    setSaving(true)
    let result: SaveKnowledgeResult
    try {
      result = await saveKnowledgeEntry(id, id ? changedFields(form, initial) : form, { baseVersionId, notDuplicateOf, markReviewed })
    } catch (error) {
      result = { ok: false, error: unexpectedError(error, "Couldn't save the entry") }
    } finally {
      setSaving(false)
    }
    if (!result.ok) {
      if (result.duplicates?.length) return setDuplicates(result.duplicates)
      if (result.conflict) return setConflict(true)
      return toast.error(result.error)
    }
    setDuplicates(null)
    toast.success(id ? "Saved" : "Entry saved")
    if (!id) router.replace(knowledgeEntryPath(result.id))
    else router.refresh()
  }

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
          {conflict && (
            <Notice
              tone="danger"
              title="Someone changed this entry since you opened it"
              action={
                <Button size="sm" onClick={() => router.refresh()}>
                  Load the latest
                </Button>
              }
            >
              Saving now would overwrite their change. Copy what you changed, load the latest version, and make your change again.
            </Notice>
          )}
          {duplicates && (
            <Notice
              tone="warning"
              title="Similar entries already exist"
              action={
                <Button size="sm" pending={saving} onClick={() => void save(duplicates.map((d) => d.id))}>
                  Save anyway
                </Button>
              }
            >
              <span className="flex flex-col gap-1">
                <span>Update one of these instead if it covers the same thing:</span>
                {duplicates.map((d) => (
                  <Link key={d.id} href={knowledgeEntryPath(d.id)} target="_blank" className="font-medium text-foreground hover:underline">
                    {d.title}
                  </Link>
                ))}
              </span>
            </Notice>
          )}

          <FormSection title="Entry">
            <Field label="Title" htmlFor="knowledge-title" required hint="Specific enough to find: “LSC entry fee for Season 3”, not “Fees”.">
              <Input id="knowledge-title" value={form.title} maxLength={KNOWLEDGE_LIMITS.titleMax} onChange={set("title")} />
            </Field>
            <Field label="Text" htmlFor="knowledge-body" required hint={MARKDOWN_HINT}>
              <Textarea id="knowledge-body" rows={16} value={form.body} maxLength={KNOWLEDGE_LIMITS.bodyMax} onChange={set("body")} className="font-mono text-xs" />
            </Field>
            <FieldGrid>
              <Field label="Tags" htmlFor="knowledge-tags" hint="Comma-separated, e.g. dues, policy. A decision gets “decision”.">
                <Input id="knowledge-tags" value={form.tags} onChange={set("tags")} />
              </Field>
              <Field label="Owner" htmlFor="knowledge-owner" hint="The officer who keeps it current.">
                <Select id="knowledge-owner" value={form.ownerId} onChange={set("ownerId")}>
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

          <FormSection title="Source" description="Where it came from and when it was true. The age badge counts from the review date, then the source date.">
            <FieldGrid>
              <Field label="Source note" htmlFor="knowledge-source-note" hint="e.g. “Dylan, exec meeting”">
                <Input id="knowledge-source-note" value={form.sourceNote} maxLength={KNOWLEDGE_LIMITS.sourceNoteMax} onChange={set("sourceNote")} />
              </Field>
              <Field label="Source date" htmlFor="knowledge-source-date">
                <Input id="knowledge-source-date" type="date" value={form.sourceDate} onChange={set("sourceDate")} />
              </Field>
              <Field label="Source link" htmlFor="knowledge-source-url" hint="A page of this site (/…) or a web link." className="sm:col-span-2">
                <Input id="knowledge-source-url" value={form.sourceUrl} maxLength={KNOWLEDGE_LIMITS.sourceUrlMax} onChange={set("sourceUrl")} placeholder="https://…" />
              </Field>
            </FieldGrid>
          </FormSection>
        </PanelBody>
        <PanelFooter>
          <FormActions className="w-full" note={id ? "Every save keeps a version in the history." : "Jack can find it as soon as it's saved."}>
            <CheckboxField
              label="Mark reviewed"
              description={reviewed ? "It's reviewed; tick to restart its age today." : "You checked it's still true."}
              checked={markReviewed}
              onChange={(event) => setMarkReviewed(event.target.checked)}
            />
            <Button type="submit" variant="primary" pending={saving} disabled={conflict}>
              {id ? "Save" : "Save entry"}
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </form>
  )
}
