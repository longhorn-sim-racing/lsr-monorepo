"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/admin/kit"
import { NOTIFICATION_TABS, type NotificationTab } from "./format"

const LABELS: Record<NotificationTab, string> = {
  activity: "Activity",
  scheduled: "Scheduled",
  compose: "Compose",
  settings: "Settings",
  cleanup: "Cleanup",
}

/**
 * The notifications page's tabs. The open tab is kept in the URL (?tab=compose) so a reload or a shared
 * link opens it, and every tab stays mounted so a half-written message survives a look at Activity.
 */
export function NotificationTabs({
  initialTab,
  counts,
  panels,
}: {
  initialTab: NotificationTab
  counts: Partial<Record<NotificationTab, number>>
  panels: Record<NotificationTab, React.ReactNode>
}) {
  const [tab, setTab] = useState<NotificationTab>(initialTab)

  const change = (value: string) => {
    const next = value as NotificationTab
    setTab(next)
    const url = new URL(window.location.href)
    if (next === "activity") url.searchParams.delete("tab")
    else url.searchParams.set("tab", next)
    window.history.replaceState(null, "", url)
  }

  return (
    <Tabs value={tab} onValueChange={change}>
      <TabsList>
        {NOTIFICATION_TABS.map((value) => (
          <TabsTrigger key={value} value={value}>
            {LABELS[value]}
            {!!counts[value] && <span className="text-xs font-normal tabular-nums text-admin-subtle">{counts[value]}</span>}
          </TabsTrigger>
        ))}
      </TabsList>
      {NOTIFICATION_TABS.map((value) => (
        <TabsContent key={value} value={value} forceMount className="outline-none data-[state=inactive]:hidden">
          {panels[value]}
        </TabsContent>
      ))}
    </Tabs>
  )
}
