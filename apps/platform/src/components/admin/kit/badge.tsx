import { cn } from "@/lib/utils"

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "accent"

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-tone-neutral text-tone-neutral-foreground",
  success: "bg-tone-success text-tone-success-foreground",
  warning: "bg-tone-warning text-tone-warning-foreground",
  danger: "bg-tone-danger text-tone-danger-foreground",
  info: "bg-tone-info text-tone-info-foreground",
  accent: "bg-tone-accent text-tone-accent-foreground",
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-admin-subtle",
  success: "text-tone-success-foreground",
  warning: "text-tone-warning-foreground",
  danger: "text-tone-danger-foreground",
  info: "text-tone-info-foreground",
  accent: "text-tone-accent-foreground",
}

/** A status pill. Pick the tone by meaning: success = live/done, warning = needs attention, danger = failed/blocked. */
export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-px text-xs font-semibold", TONE_CLASSES[tone], className)}>
      {children}
    </span>
  )
}

/** Plain colored text for a status inside dense rows, where a pill would be too loud. */
export function ToneText({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: React.ReactNode }) {
  return <span className={cn("text-xs font-semibold", TONE_TEXT[tone], className)}>{children}</span>
}
