"use client"

import { useEffect, useState, useTransition } from "react"
import type { GalleryImage } from "@prisma/client"
import { toast } from "sonner"
import { Button, Dialog, Field, Input } from "@/components/admin/kit"
import { updateImageCredit } from "@/app/admin/gallery/actions"
import { unexpectedError } from "@/lib/action-result"

interface CreditDialogProps {
  image: GalleryImage
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (id: string, creditName: string | null, creditUrl: string | null) => void
}

export function CreditDialog({ image, isOpen, onOpenChange, onSaved }: CreditDialogProps) {
  const [creditName, setCreditName] = useState(image.creditName ?? "")
  const [creditUrl, setCreditUrl] = useState(image.creditUrl ?? "")
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (isOpen) {
      setCreditName(image.creditName ?? "")
      setCreditUrl(image.creditUrl ?? "")
    }
  }, [isOpen, image])

  const handleSave = () => {
    startTransition(async () => {
      try {
        await updateImageCredit(image.id, creditName || null, creditUrl || null)
        onSaved(image.id, creditName || null, creditUrl || null)
        toast.success("Credit saved")
        onOpenChange(false)
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't save the credit"))
      }
    })
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={onOpenChange}
      size="sm"
      title="Photo credit"
      description="Shown with the photo on the public gallery. Leave both blank for no credit."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} pending={isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Photographer" htmlFor="credit-name">
          <Input id="credit-name" placeholder="Name" value={creditName} onChange={(e) => setCreditName(e.target.value)} autoFocus />
        </Field>
        <Field label="Link" htmlFor="credit-url" hint="Optional, e.g. their Instagram">
          <Input id="credit-url" placeholder="https://instagram.com/…" value={creditUrl} onChange={(e) => setCreditUrl(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  )
}
