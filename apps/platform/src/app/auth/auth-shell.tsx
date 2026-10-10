import { Check } from "lucide-react"
import { CloudinaryImage } from "@/components/cloudinary-image"

const PERKS = [
  "Your own driver page, with every result you score",
  "Register for races, sim nights and socials in one tap",
  "Enter the Lone Star Cup and get on the standings",
]

/**
 * The frame for the sign-in, password and auth-error pages: a photo panel with what an account gets
 * you on desktop, a short photo band on phones, and the page's own content in a card.
 */
export function AuthShell({
  kicker,
  title,
  intro,
  children,
}: {
  kicker: string
  title: React.ReactNode
  intro?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="bg-lsr-charcoal text-white lg:grid lg:min-h-[calc(100svh-5rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* Photo panel (desktop) / band (phones) */}
      <div className="relative h-32 overflow-hidden border-b border-white/10 lg:h-auto lg:border-b-0 lg:border-r">
        <CloudinaryImage
          publicId="gallery/wec-at-cota-2025/dsc09842"
          alt=""
          fill
          preload
          sizes="(min-width: 1024px) 50vw, 100vw"
          className="object-cover object-[center_40%] opacity-60"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal via-lsr-charcoal/40 to-lsr-charcoal/20" />
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />
        <div className="absolute inset-x-0 bottom-0 hidden p-10 xl:p-14 lg:block">
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Longhorn Sim Racing</p>
          <p className="mt-3 font-display font-black italic text-5xl xl:text-6xl uppercase leading-[0.9]">
            Join the <span className="text-lsr-orange">grid</span>
          </p>
          <ul className="mt-6 space-y-2.5">
            {PERKS.map((perk) => (
              <li key={perk} className="flex items-start gap-3 font-sans text-sm text-white/80">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-lsr-orange" aria-hidden />
                {perk}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Content */}
      <div className="flex items-center justify-center px-6 py-12 md:px-8 md:py-16">
        <div className="w-full max-w-md">
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">{kicker}</p>
          <h1 className="mt-3 font-display font-black italic text-4xl md:text-5xl uppercase leading-[0.95] text-white">{title}</h1>
          {intro && <p className="mt-4 font-sans text-sm md:text-base leading-relaxed text-white/65">{intro}</p>}
          <div className="mt-8">{children}</div>
        </div>
      </div>
    </div>
  )
}
