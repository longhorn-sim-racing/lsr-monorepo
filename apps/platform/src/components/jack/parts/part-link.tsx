import Link from "next/link"
import type { ReactNode } from "react"
import { ExternalLink } from "lucide-react"
import { partLink } from "@/lib/jack/links"
import { cn } from "@/lib/utils"

export const PART_LINK_CLASS = "font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"

/**
 * A link inside a part (#188). Site pages open in place with next/link; web links open in a new tab
 * and always show their host beside them. A URL that isn't safe to link shows as plain text.
 * `file`: a site path that serves a file rather than a page (the room file route), opened in a new tab
 * with a plain link, so next/link never prefetches it.
 */
export function PartLink({ url, children, file = false, className }: { url: string; children: ReactNode; file?: boolean; className?: string }) {
  const link = partLink(url)
  if (!link) return <span className={cn("font-medium", className)}>{children}</span>
  if (link.internal && !file)
    return (
      <Link href={link.href} className={cn(PART_LINK_CLASS, className)}>
        {children}
      </Link>
    )
  return (
    <span className="inline">
      <a href={link.href} target="_blank" rel="noreferrer" className={cn(PART_LINK_CLASS, className)}>
        {children}
      </a>
      {!link.internal && <LinkHost host={link.host} />}
    </span>
  )
}

/** Where an outside link goes, after it */
export function LinkHost({ host }: { host: string }) {
  return (
    <span className="ml-1.5 inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-normal text-admin-subtle">
      <ExternalLink aria-hidden className="size-3" />
      <span className="sr-only">opens </span>
      {host}
    </span>
  )
}
