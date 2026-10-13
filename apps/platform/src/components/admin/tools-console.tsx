"use client"

import { useState } from "react"
import { Bot } from "lucide-react"
import { EmptyState, Panel, SearchInput, SwitchField, Toolbar } from "@/components/admin/kit"
import { setLeorgeGawrenceEnforcementUnitStatus } from "@/app/admin/tools/actions"

type Tool = {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  /** The tool's control, shown on the right of its row */
  control: React.ReactNode
}

export function ToolsConsole({ leorgeEnabled: initialLeorgeEnabled }: { leorgeEnabled: boolean }) {
  const [search, setSearch] = useState("")
  const [leorgeEnabled, setLeorgeEnabled] = useState(initialLeorgeEnabled)

  const handleToggle = async (checked: boolean) => {
    setLeorgeEnabled(checked) // Optimistic
    try {
      await setLeorgeGawrenceEnforcementUnitStatus(checked)

      // The Leorge Gawrence Enforcement Unit cannot be stopped.
      if (!checked) {
        setTimeout(() => {
          handleToggle(true)
        }, 1000)
      }
    } catch (err) {
      console.error(err)
      setLeorgeEnabled(!checked) // Revert
    }
  }

  const tools: Tool[] = [
    {
      id: "leorge-gawrence-enforcement-unit",
      name: "Leorge Gawrence Enforcement Unit",
      description: "Antagonize George",
      icon: <Bot className="size-4" aria-hidden />,
      control: (
        <SwitchField
          label={leorgeEnabled ? "On" : "Off"}
          aria-label="Leorge Gawrence Enforcement Unit"
          checked={leorgeEnabled}
          onCheckedChange={handleToggle}
          className="items-center"
        />
      ),
    },
  ]

  const q = search.trim().toLowerCase()
  const visible = q ? tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) : tools

  return (
    <>
      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search tools" />
      </Toolbar>
      <Panel>
        {visible.length === 0 ? (
          <EmptyState title="No tools match" description="Try a different search." />
        ) : (
          <ul>
            {visible.map((tool) => (
              <li key={tool.id} className="flex flex-wrap items-center gap-3 border-b border-admin-row px-4 py-3 last:border-b-0">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-admin-surface text-muted-foreground">{tool.icon}</span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] font-semibold">{tool.name}</span>
                  <span className="text-xs text-admin-subtle">{tool.description}</span>
                </div>
                <div className="ml-auto shrink-0">{tool.control}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  )
}
