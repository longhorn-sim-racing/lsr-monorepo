"use client"

import { useEffect, useState, useTransition } from "react"
import type { GalleryAlbum } from "@prisma/client"
import { formatInTimeZone } from "date-fns-tz"
import { toast } from "sonner"
import { Button, Dialog, Field, FieldGrid, FormSection, Input, Select, Textarea, useConfirm } from "@/components/admin/kit"
import { createAlbum, deleteAlbum, setAlbumCredit, updateAlbum } from "@/app/admin/gallery/actions"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { unexpectedError } from "@/lib/action-result"

export type EventOption = { id: string; title: string; date: string }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export function AlbumDialog({
  album,
  events,
  photoCount,
  isOpen,
  onOpenChange,
  onSaved,
  onDeleted,
  onCreditApplied,
}: {
  /** Edit this album, or create a new one when null */
  album: GalleryAlbum | null
  events: EventOption[]
  /** Photos in the album, for the credit and delete wording */
  photoCount: number
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (album: GalleryAlbum) => void
  onDeleted: (id: string) => void
  onCreditApplied: (albumId: string, creditName: string | null, creditUrl: string | null) => void
}) {
  const confirm = useConfirm()
  const [title, setTitle] = useState("")
  const [date, setDate] = useState("")
  const [description, setDescription] = useState("")
  const [eventId, setEventId] = useState("")
  const [creditName, setCreditName] = useState("")
  const [creditUrl, setCreditUrl] = useState("")
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (!isOpen) return
    setTitle(album?.title ?? "")
    // Album dates are stored at noon UTC, so the UTC date is the date picked
    setDate(album?.date ? new Date(album.date).toISOString().slice(0, 10) : "")
    setDescription(album?.description ?? "")
    setEventId(album?.eventId ?? "")
    setCreditName("")
    setCreditUrl("")
  }, [isOpen, album])

  const input = () => ({ title, date: date || null, description: description || null, eventId: eventId || null })

  const save = () =>
    startTransition(async () => {
      try {
        const saved = album ? await updateAlbum(album.id, input()) : await createAlbum(input())
        toast.success(album ? "Album saved" : `Created "${saved.title}"`)
        onSaved(saved)
        onOpenChange(false)
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't save the album"))
      }
    })

  const applyCredit = async () => {
    if (!album) return
    const ok = await confirm({
      title: `Credit ${creditName.trim()} on every photo?`,
      description: `Sets the credit on all ${plural(photoCount, "photo")} in "${album.title}", replacing any credit they have now.`,
      confirmLabel: "Apply credit",
    })
    if (!ok) return
    startTransition(async () => {
      try {
        const name = creditName.trim() || null
        const url = creditUrl.trim() || null
        const count = await setAlbumCredit(album.id, name, url)
        onCreditApplied(album.id, name, url)
        toast.success(`Credit set on ${plural(count, "photo")}`)
        setCreditName("")
        setCreditUrl("")
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't set the credit"))
      }
    })
  }

  const remove = async () => {
    if (!album) return
    const ok = await confirm({
      tone: "danger",
      title: `Delete "${album.title}"?`,
      description:
        photoCount > 0
          ? `Its ${plural(photoCount, "photo")} stay in the gallery as unsorted. The album's link stops working.`
          : "The album is empty. Its link stops working.",
      confirmLabel: "Delete album",
    })
    if (!ok) return
    startTransition(async () => {
      try {
        await deleteAlbum(album.id)
        toast.success(`Deleted "${album.title}"`)
        onDeleted(album.id)
        onOpenChange(false)
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't delete the album"))
      }
    })
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={onOpenChange}
      title={album ? "Album settings" : "New album"}
      description="Albums group photos from one shoot or event. They show newest first on /gallery."
      footer={
        <>
          {album && (
            <Button variant="danger" onClick={remove} disabled={isPending} className="mr-auto">
              Delete album
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} pending={isPending} disabled={!title.trim()}>
            {album ? "Save" : "Create album"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Title" htmlFor="album-title" required>
          <Input id="album-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="LSC Season 3: Round 4" autoFocus />
        </Field>
        <FieldGrid>
          <Field label="Date taken" htmlFor="album-date" hint="Sets where it sorts on /gallery">
            <Input id="album-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Linked event" htmlFor="album-event" hint="Links the album to the event page">
            <Select id="album-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
              <option value="">None</option>
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {formatInTimeZone(event.date, DEFAULT_TIMEZONE, "MMM d, yyyy")} · {event.title}
                </option>
              ))}
            </Select>
          </Field>
        </FieldGrid>
        <Field label="Description" htmlFor="album-description" hint="Optional">
          <Textarea id="album-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
      </div>

      {album && (
        <div className="mt-5 border-t border-admin-row pt-4">
          <FormSection title="Photo credit for the whole album" description={`Sets the same credit on all ${plural(photoCount, "photo")} in this album.`}>
            <FieldGrid>
              <Field label="Photographer" htmlFor="album-credit-name">
                <Input id="album-credit-name" value={creditName} onChange={(e) => setCreditName(e.target.value)} placeholder="Name" />
              </Field>
              <Field label="Link" htmlFor="album-credit-url" hint="Optional">
                <Input id="album-credit-url" value={creditUrl} onChange={(e) => setCreditUrl(e.target.value)} placeholder="https://instagram.com/…" />
              </Field>
            </FieldGrid>
            <div>
              <Button onClick={applyCredit} disabled={isPending || !creditName.trim() || photoCount === 0}>
                Apply to all photos
              </Button>
            </div>
          </FormSection>
        </div>
      )}
    </Dialog>
  )
}
