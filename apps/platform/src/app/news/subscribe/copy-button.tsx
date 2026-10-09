"use client"

import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Copies the feed URL, falling back to a hidden input where the clipboard API is blocked. */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      const el = document.createElement("input")
      el.value = value
      document.body.appendChild(el)
      el.select()
      document.execCommand("copy")
      document.body.removeChild(el)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Button
      type="button"
      onClick={copy}
      aria-label="Copy the RSS feed URL"
      className="h-11 w-full shrink-0 rounded-none bg-lsr-orange px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal md:w-auto"
    >
      {copied ? <Check className="mr-2 h-3.5 w-3.5" /> : <Copy className="mr-2 h-3.5 w-3.5" />}
      <span aria-live="polite">{copied ? "Copied" : "Copy URL"}</span>
    </Button>
  )
}
