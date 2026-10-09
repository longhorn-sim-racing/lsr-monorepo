import { CloudinaryImage } from "@/components/cloudinary-image"

/**
 * The 404, 403 and error screens: a big status code over an optional photo, a headline and the way
 * out. Works from server pages and from client error boundaries.
 */
export function StatusScreen({
  code,
  kicker,
  title,
  children,
  actions,
  photo,
}: {
  code: string
  kicker: string
  title: React.ReactNode
  children: React.ReactNode
  actions: React.ReactNode
  /** Cloudinary public id for the backdrop */
  photo?: string
}) {
  return (
    <div className="relative flex min-h-[calc(100svh-5rem)] items-center overflow-hidden bg-lsr-charcoal text-white">
      {photo && (
        <div className="absolute inset-0 z-0">
          <CloudinaryImage publicId={photo} alt="" fill preload sizes="100vw" className="object-cover opacity-75" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal via-lsr-charcoal/65 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal via-transparent to-transparent" />
        </div>
      )}
      <div className="absolute inset-0 z-0 opacity-[0.04] [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />

      <div className="relative z-10 mx-auto w-full max-w-6xl px-6 py-16 md:px-8 md:py-24">
        <p
          aria-hidden
          className="select-none font-display font-black italic text-[7rem] leading-[0.8] text-transparent [-webkit-text-stroke:2px_rgba(255,255,255,0.22)] md:text-[13rem]"
        >
          {code}
        </p>
        <p className="mt-6 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">{kicker}</p>
        <h1 className="mt-3 max-w-2xl font-display font-black italic text-5xl uppercase leading-[0.9] md:text-7xl">{title}</h1>
        <div className="mt-6 max-w-xl font-sans text-base leading-relaxed text-white/75 md:text-lg">{children}</div>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{actions}</div>
      </div>
    </div>
  )
}

export const statusPrimary =
  "inline-flex h-12 items-center justify-center bg-lsr-orange px-8 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal"
export const statusSecondary =
  "inline-flex h-12 items-center justify-center border border-white/25 px-8 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal"
