"use client"

import { useState } from "react"
import Link from "next/link"
import type { EventSeries } from "@prisma/client"
import { Button, Field, FormActions, Input, Panel, PanelBody, PanelFooter } from "@/components/admin/kit"
import { createSeries, updateSeries } from "@/app/admin/series/actions"
import { useAction } from "@/app/admin/events/_components/use-action"
import { slugify } from "@/lib/slug"

export function SeriesForm({ series }: { series?: EventSeries }) {
  const [slug, setSlug] = useState(series?.slug ?? "")
  const [slugTouched, setSlugTouched] = useState(!!series)
  const { run, pending } = useAction()

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    // Both actions go back to the list when they finish
    run(() => (series ? updateSeries(series.id, formData) : createSeries(formData)), {
      success: series ? "Series saved" : "Series created",
      error: "Couldn't save the series",
    })
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl">
      <Panel>
        <PanelBody className="flex flex-col gap-3">
          <Field label="Title" htmlFor="title" required>
            <Input
              id="title"
              name="title"
              defaultValue={series?.title}
              required
              placeholder="Lone Star Cup"
              onChange={(e) => {
                if (!slugTouched) setSlug(slugify(e.target.value))
              }}
            />
          </Field>
          <Field label="Slug" htmlFor="slug" required hint="A short, unique name for links. Lowercase letters, numbers and hyphens.">
            <Input
              id="slug"
              name="slug"
              value={slug}
              required
              placeholder="lone-star-cup"
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value)
              }}
            />
          </Field>
        </PanelBody>
        <PanelFooter>
          <FormActions className="w-full">
            <Button asChild variant="ghost">
              <Link href="/admin/series">Cancel</Link>
            </Button>
            <Button type="submit" variant="primary" pending={pending}>
              {series ? "Save series" : "Create series"}
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </form>
  )
}
