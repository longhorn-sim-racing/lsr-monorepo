"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import type { FeaturedVideoKind } from "@/lib/email/settings"
import { unexpectedError } from "@/lib/action-result"
import { Panel, PanelHeader, Segmented } from "@/components/admin/kit"
import { setFeaturedVideo } from "./actions"

/** Which video the home page shows. Switching saves right away; both videos stay saved. */
export function FeaturedSwitch({ show, hasClip }: { show: FeaturedVideoKind; hasClip: boolean }) {
  const [value, setValue] = useState(show)
  const [pending, startTransition] = useTransition()

  function choose(next: FeaturedVideoKind) {
    if (next === value || pending) return
    if (next === "clip" && !hasClip) {
      toast.error("Save a competition clip below first.")
      return
    }
    const previous = value
    setValue(next)
    startTransition(async () => {
      try {
        const result = await setFeaturedVideo(next)
        if (!result.ok) {
          setValue(previous)
          toast.error(result.error)
        } else {
          toast.success(next === "clip" ? "The home page shows the competition clip" : "The home page shows the hotlap of the week")
        }
      } catch (error) {
        setValue(previous)
        toast.error(unexpectedError(error, "Couldn't switch the video"))
      }
    })
  }

  return (
    <Panel aria-busy={pending || undefined}>
      <PanelHeader
        title="On the home page"
        description="Both stay saved, so you can switch back any time."
        className="items-center border-b-0"
        actions={
          <Segmented
            label="Video on the home page"
            value={value}
            onChange={choose}
            options={[
              { value: "hotlap", label: "Hotlap of the week" },
              { value: "clip", label: "Competition clip" },
            ]}
          />
        }
      />
    </Panel>
  )
}
