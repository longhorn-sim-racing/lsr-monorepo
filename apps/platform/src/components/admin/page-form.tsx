"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { ExternalLink } from "lucide-react"
import { toast } from "sonner"
import {
  Badge,
  Button,
  Field,
  FieldGrid,
  FormActions,
  Input,
  PageHeader,
  Panel,
  PanelBody,
  PanelFooter,
  Textarea,
  useConfirm,
} from "@/components/admin/kit"
import { savePage, type PageInput } from "@/app/admin/pages/actions"
import { PAGE_PUBLIC_PATHS } from "@/app/admin/pages/_components/public-paths"

const MARKDOWN_HINT = "Markdown: # Heading, ## Section, - bullet, 1. numbered, **bold**, _italic_, [link](https://…), > callout. Plain Markdown only."

export function PageForm({ id, initial }: { id: string | null; initial: PageInput }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const publicPath = PAGE_PUBLIC_PATHS[form.slug]
  // The site links to these by slug, so the slug stays put (savePage refuses a change too).
  const slugLocked = !!id && !!PAGE_PUBLIC_PATHS[initial.slug]
  const isPublic = form.visibility === "public"

  async function save(visibility = form.visibility) {
    setSaving(true)
    let result: Awaited<ReturnType<typeof savePage>>
    try {
      result = await savePage(id, { ...form, visibility })
    } catch {
      result = { ok: false, error: "Couldn't reach the server. Your text is still here; try again." }
    } finally {
      setSaving(false)
    }
    if (!result.ok) return toast.error(result.error)
    setForm((f) => ({ ...f, visibility }))
    toast.success(visibility === "public" && form.visibility !== "public" ? "Published" : visibility !== "public" && form.visibility === "public" ? "Unpublished" : "Saved")
    if (!id) router.replace(`/admin/pages/${result.id}`)
    else router.refresh()
  }

  async function unpublish() {
    const ok = await confirm({
      title: `Unpublish ${form.title || "this page"}?`,
      description: "It disappears from the site until you publish it again. Officers can still see it.",
      confirmLabel: "Unpublish",
      tone: "danger",
    })
    if (ok) await save("officers")
  }

  return (
    <>
      <PageHeader
        back={{ href: "/admin/pages", label: "Pages" }}
        title={id ? initial.title || "Untitled page" : "New page"}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {isPublic ? <Badge tone="success">Public</Badge> : <Badge>Draft, officers only</Badge>}
            {publicPath ? `Shown at ${publicPath}` : "Not shown anywhere on the site yet"}
          </span>
        }
        actions={
          publicPath && id ? (
            <Button asChild>
              <a href={publicPath} target="_blank" rel="noreferrer">
                View page
                <ExternalLink aria-hidden />
              </a>
            </Button>
          ) : undefined
        }
      />

      <form
        className="max-w-4xl"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Panel>
          <PanelBody className="flex flex-col gap-4">
            <FieldGrid>
              <Field label="Title" htmlFor="page-title" required>
                <Input id="page-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </Field>
              <Field
                label="Slug"
                htmlFor="page-slug"
                hint={slugLocked ? "The site links to this page by its slug, so it can't change." : "Lowercase letters, numbers and dashes."}
              >
                <Input id="page-slug" value={form.slug} disabled={slugLocked} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
              </Field>
            </FieldGrid>
            <Field label="Content" htmlFor="page-body" hint={MARKDOWN_HINT}>
              <Textarea
                id="page-body"
                rows={28}
                value={form.bodyMd}
                onChange={(e) => setForm({ ...form, bodyMd: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>
          </PanelBody>
          <PanelFooter>
            <FormActions note={isPublic ? "Saving updates the live page." : "Drafts are only visible to officers."} className="w-full">
              {isPublic ? (
                <Button type="button" disabled={saving} onClick={unpublish}>
                  Unpublish
                </Button>
              ) : (
                <Button type="button" disabled={saving || !id} onClick={() => save("public")} title={id ? undefined : "Save it first"}>
                  Publish
                </Button>
              )}
              <Button type="submit" variant="primary" pending={saving}>
                Save
              </Button>
            </FormActions>
          </PanelFooter>
        </Panel>
      </form>
    </>
  )
}
