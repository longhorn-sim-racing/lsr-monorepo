"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import type { FeaturedVideo } from "@/lib/email/settings"
import { Panel, PanelBody, Segmented } from "@/components/admin/kit"
import { setFeaturedVideo } from "./actions"

/** Which video the home page shows. Switching saves right away; both videos stay saved. */
export function FeaturedSwitch({ show, hasClip }: { show: FeaturedVideo; hasClip: boolean }) {
  const [value, setValue] = useState(show)
  const [, startTransition] = useTransition()

  function choose(next: FeaturedVideo) {
    if (next === value) return
    if (next === "clip" && !hasClip) {
      toast.error("Save a competition clip below first.")
      return
    }
    setValue(next)
    startTransition(async () => {
      const result = await setFeaturedVideo(next)
      if (!result.ok) {
        setValue(value)
        toast.error(result.error)
      } else {
        toast.success(next === "clip" ? "The home page shows the competition clip" : "The home page shows the hotlap of the week")
      }
    })
  }

  return (
    <Panel>
      <PanelBody className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-semibold">On the home page</h2>
          <p className="text-xs text-muted-foreground">Both stay saved, so you can switch back any time.</p>
        </div>
        <Segmented
          label="Video on the home page"
          value={value}
          onChange={choose}
          options={[
            { value: "hotlap", label: "Hotlap of the week" },
            { value: "clip", label: "Competition clip" },
          ]}
        />
      </PanelBody>
    </Panel>
  )
}
