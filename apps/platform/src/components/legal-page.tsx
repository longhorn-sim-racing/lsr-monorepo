import Link from "next/link"
import { ArrowRight, ChevronDown } from "lucide-react"

/**
 * The frame for the long legal pages (privacy, terms): a header band with the dates, the contents as
 * a sticky sidebar on desktop and a collapsible list on phones, and the text in a reading column.
 */
export function LegalPage({
  title,
  effective,
  updated,
  intro,
  toc,
  related,
  children,
}: {
  title: React.ReactNode
  effective: string
  updated: string
  intro?: React.ReactNode
  toc: { id: string; label: string }[]
  related: { href: string; label: string }
  children: React.ReactNode
}) {
  const list = (
    <ol className="space-y-0.5 font-sans text-sm">
      {toc.map((entry) => (
        <li key={entry.id}>
          <a href={`#${entry.id}`} className="block py-1.5 leading-snug text-white/60 transition-colors hover:text-lsr-orange">
            {entry.label}
          </a>
        </li>
      ))}
    </ol>
  )

  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      <div className="relative overflow-hidden border-b border-white/10 bg-black/25">
        <div className="absolute inset-0 opacity-[0.04] [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />
        <div className="relative mx-auto max-w-6xl px-6 md:px-8 pt-14 pb-12 md:pt-20 md:pb-14">
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Legal</p>
          <h1 className="mt-3 font-display font-black italic text-5xl md:text-7xl uppercase leading-[0.9]">{title}</h1>
          <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-1 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white/45">
            <div className="flex gap-2">
              <dt>Effective</dt>
              <dd className="text-white/75">{effective}</dd>
            </div>
            <div className="flex gap-2">
              <dt>Last updated</dt>
              <dd className="text-white/75">{updated}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-10 md:py-14">
        <div className="grid gap-10 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-14">
          <nav aria-label="Contents" className="lg:sticky lg:top-24 lg:max-h-[calc(100svh-7rem)] lg:self-start lg:overflow-y-auto">
            <details className="group border border-white/10 bg-white/[0.02] lg:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 font-sans font-bold text-[11px] uppercase tracking-[0.2em] text-white [&::-webkit-details-marker]:hidden">
                Contents
                <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="border-t border-white/10 px-4 py-3">{list}</div>
            </details>
            <div className="hidden lg:block">
              <p className="mb-3 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Contents</p>
              {list}
            </div>
          </nav>

          <div className="min-w-0 max-w-3xl">
            {intro && <div className="mb-12 border-l-4 border-lsr-orange bg-white/[0.02] p-6 md:p-7">{intro}</div>}
            {children}
            <div className="mt-20 flex flex-col gap-3 border-t border-white/10 pt-8 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white/45 sm:flex-row sm:items-center sm:justify-between">
              <span>
                Last updated <span className="text-white/75">{updated}</span>
              </span>
              <Link href={related.href} className="group inline-flex items-center gap-2 text-lsr-orange hover:text-white">
                {related.label}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
