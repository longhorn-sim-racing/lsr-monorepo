"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Copy, NotebookPen } from "lucide-react"
import { Badge, Button, DetailList } from "@/components/admin/kit"
import type { JackTextDraftDisplay } from "@/lib/jack/parts"

const DRAFT_LABEL: Record<JackTextDraftDisplay["draftKind"], string> = {
  email: "Email draft",
  agenda: "Agenda",
  caption: "Caption",
  text: "Draft",
}

/** How long "Copied" shows before the button goes back */
const COPIED_MS = 2_000

/**
 * A draft for an officer to send themselves (#188, `draft_text`): the subject and recipient for an
 * email, the body as written, and a Copy button. Jack never sends it. Where the clipboard isn't
 * available (an insecure page, a browser that refuses), Copy selects the text instead.
 */
export function TextDraft({ display }: { display: JackTextDraftDisplay }) {
  const body = useRef<HTMLDivElement>(null)
  const [copy, setCopy] = useState<"idle" | "copied" | "selected">("idle")

  useEffect(() => {
    if (copy !== "copied") return
    const timer = setTimeout(() => setCopy("idle"), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copy])

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(display.body)
      setCopy("copied")
    } catch {
      selectContents(body.current)
      setCopy("selected")
    }
  }

  const details = [
    display.to ? { label: "To", value: display.to } : null,
    display.subject ? { label: "Subject", value: <span className="font-medium">{display.subject}</span> } : null,
  ].filter((item) => item !== null)

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border bg-admin-surface p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <NotebookPen aria-hidden className="size-4 shrink-0 text-admin-subtle" />
        <span className="font-semibold">{DRAFT_LABEL[display.draftKind] ?? "Draft"}</span>
        <Badge tone="neutral">Not sent</Badge>
        <Button size="sm" className="ml-auto" onClick={() => void copyBody()}>
          {copy === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copy === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      {details.length > 0 && <DetailList items={details} />}
      <div ref={body} className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-card p-2.5 leading-relaxed">
        {display.body}
      </div>
      <p role="status" aria-live="polite" className={copy === "selected" ? "text-xs text-muted-foreground" : "sr-only"}>
        {copy === "selected" ? "Couldn't reach the clipboard, so the text is selected: press Ctrl+C (⌘C on a Mac) to copy it." : copy === "copied" ? "Copied" : ""}
      </p>
    </div>
  )
}

/** Selects an element's text, for copying by hand */
function selectContents(element: HTMLElement | null) {
  const selection = typeof window === "undefined" ? null : window.getSelection()
  if (!element || !selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
}
