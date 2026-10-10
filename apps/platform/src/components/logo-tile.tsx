import Image from "next/image"
import { ArrowUpRight } from "lucide-react"

/** Linked logo card used for campus partners and sponsors on /about and /sponsors. */
export function LogoTile({
  name,
  logo,
  href,
  detail,
  title,
  sizes,
}: {
  name: string
  logo: string
  href?: string
  detail?: string
  title?: string
  sizes: string
}) {
  const body = (
    <>
      {href && <ArrowUpRight className="absolute top-4 right-4 h-4 w-4 text-white/20 transition-colors group-hover:text-lsr-orange" />}
      <span className="min-h-4 pr-6 font-sans font-black text-[9px] uppercase tracking-[0.2em] text-lsr-orange">{title}</span>
      <div className="relative my-5 h-20 md:h-24 w-full">
        <Image
          src={logo}
          alt=""
          fill
          sizes={sizes}
          className="object-contain transition-transform duration-300 group-hover:scale-105"
        />
      </div>
      <p className="font-sans font-bold text-xs md:text-sm uppercase tracking-wide text-white">{name}</p>
      {detail && <p className="mt-1 font-sans text-[11px] md:text-xs text-white/40">{detail}</p>}
    </>
  )
  const className = "group relative flex flex-col border border-white/10 bg-white/[0.02] p-5 md:p-6 transition-colors"

  if (!href) return <div className={className}>{body}</div>

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} hover:border-lsr-orange/50 hover:bg-white/[0.04]`}
    >
      {body}
    </a>
  )
}
