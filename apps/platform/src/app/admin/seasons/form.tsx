"use client"

import { useState } from "react"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { toast } from "sonner"
import { formatInTimeZone } from "date-fns-tz"
import type { EventSeries, Season } from "@prisma/client"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { slugify } from "@/lib/slug"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import { useFormAction } from "@/components/admin/use-form-action"
import { Button, Field, FieldGrid, FormActions, FormSection, Input, Notice, Panel, PanelBody, PanelFooter, Select } from "@/components/admin/kit"
import { createSeason, updateSeason } from "./actions"

/** Season dates are Central-time days (the action reads them that way) */
const toDateInput = (date: Date | null | undefined) => (date ? formatInTimeZone(new Date(date), DEFAULT_TIMEZONE, "yyyy-MM-dd") : "")

/** A server action's redirect arrives as a rejected promise carrying Next's redirect digest */
const isRedirect = (error: unknown) =>
  typeof error === "object" && error !== null && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")

export function SeasonForm({
  initialData,
  seriesList,
  leagues,
}: {
  initialData?: Season | null
  seriesList: EventSeries[]
  leagues: { id: string; name: string }[]
}) {
  const isEditing = !!initialData
  const [name, setName] = useState(initialData?.name ?? "")
  const [slug, setSlug] = useState(initialData?.slug ?? "")
  // A new season's slug follows its name until someone edits the slug
  const [slugEdited, setSlugEdited] = useState(isEditing)

  // createSeason and updateSeason redirect to the list when they succeed, and throw when they don't
  const save = async (formData: FormData): Promise<ActionResult | void> => {
    try {
      await (initialData ? updateSeason(initialData.id, formData) : createSeason(formData))
    } catch (error) {
      if (isRedirect(error)) toast.success(isEditing ? "Season saved" : "Season created")
      unstable_rethrow(error)
      console.error(error)
      return { ok: false, error: unexpectedError(error, "Couldn't save the season. Check that the slug isn't already used by another season") }
    }
  }
  const { onSubmit, error, pending } = useFormAction(save)

  const defaultPointsRule = (initialData?.pointsRule as { system?: string } | null | undefined)?.system || "F1"

  return (
    <form onSubmit={onSubmit}>
      <Panel>
        <PanelBody className="flex flex-col gap-6">
          <FormSection title="Basics">
            <Field label="Name" htmlFor="name" required>
              <Input
                id="name"
                name="name"
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (!slugEdited) setSlug(slugify(e.target.value))
                }}
                placeholder="Lone Star Cup | Season 4"
              />
            </Field>
            <FieldGrid>
              <Field label="Slug" htmlFor="slug" required hint="Used in links, so keep it short and unique">
                <Input
                  id="slug"
                  name="slug"
                  required
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value)
                    setSlugEdited(true)
                  }}
                  placeholder="lone-star-cup-s4"
                />
              </Field>
              <Field label="Year" htmlFor="year" required>
                <Input id="year" name="year" type="number" min={2000} required defaultValue={initialData?.year ?? new Date().getFullYear()} />
              </Field>
            </FieldGrid>
            <FieldGrid>
              <Field label="Series" htmlFor="seriesId" hint="Standings count this series' events within the season's dates">
                <Select id="seriesId" name="seriesId" defaultValue={initialData?.seriesId ?? ""}>
                  <option value="">No series</option>
                  {seriesList.map((series) => (
                    <option key={series.id} value={series.id}>
                      {series.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="League" htmlFor="leagueId" hint="The league page shows linked seasons, and its entry fee buys the next one that hasn't ended">
                <Select id="leagueId" name="leagueId" defaultValue={initialData?.leagueId ?? ""}>
                  <option value="">No league</option>
                  {leagues.map((league) => (
                    <option key={league.id} value={league.id}>
                      {league.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </FieldGrid>
          </FormSection>

          <FormSection title="Dates" description="Central time. The season runs through the end of its last day.">
            <FieldGrid>
              <Field label="First day" htmlFor="startAt">
                <Input id="startAt" name="startAt" type="date" defaultValue={toDateInput(initialData?.startAt)} />
              </Field>
              <Field label="Last day" htmlFor="endAt">
                <Input id="endAt" name="endAt" type="date" defaultValue={toDateInput(initialData?.endAt)} />
              </Field>
            </FieldGrid>
          </FormSection>

          <FormSection title="Points">
            <Field
              label="Default points ruleset"
              htmlFor="pointsRule"
              hint="Saved with the season for reference. Points are awarded by the ruleset picked on each results upload."
            >
              <Select id="pointsRule" name="pointsRule" defaultValue={defaultPointsRule} className="sm:max-w-xs">
                <option value="F1">F1 (25, 18, 15…)</option>
                <option value="HALF">Half points</option>
                <option value="NONE">No points</option>
              </Select>
            </Field>
          </FormSection>

          {error && (
            <Notice tone="danger" title="Not saved">
              {error}
            </Notice>
          )}
        </PanelBody>
        <PanelFooter>
          <FormActions className="w-full" note={isEditing ? "Saving returns you to the seasons list." : undefined}>
            <Button asChild>
              <Link href="/admin/seasons">Cancel</Link>
            </Button>
            <Button type="submit" variant="primary" pending={pending}>
              {isEditing ? "Save season" : "Create season"}
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </form>
  )
}
