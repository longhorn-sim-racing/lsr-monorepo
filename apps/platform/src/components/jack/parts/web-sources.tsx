import { Globe, Search } from "lucide-react"
import type { JackWebSourcesDisplay } from "@/lib/jack/parts"
import { PartLink } from "./part-link"

/** What a web search looked for and the pages the answer cites (#188, design §7.4), each with its host */
export function WebSourcesView({ display }: { display: JackWebSourcesDisplay }) {
  if (!display.queries.length && !display.sources.length) return null
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {display.queries.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Search aria-hidden className="mt-px size-3.5 shrink-0 text-admin-subtle" />
          <span className="min-w-0 break-words">
            Searched the web for {display.queries.map((query, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <q className="font-medium text-foreground">{query}</q>
              </span>
            ))}
          </span>
        </p>
      )}
      {display.sources.length > 0 && (
        <ol className="flex flex-col gap-1">
          {display.sources.map((source, i) => (
            <li key={i} className="flex min-w-0 items-start gap-1.5">
              <Globe aria-hidden className="mt-0.5 size-3.5 shrink-0 text-admin-subtle" />
              <span className="min-w-0 break-words">
                <PartLink url={source.url}>{source.title || source.url}</PartLink>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
