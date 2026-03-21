import Link from "next/link"
import Image from "next/image"
import SectionReveal from "./SectionReveal"

const goldSponsors = [
  {
    name: "Race Club Austin",
    logo: "/sponsors/raceclub.png",
    href: "https://www.raceclubsim.com/",
  },
  {
    name: "Driven to Care",
    logo: "/sponsors/driventocare.png",
    href: "https://www.driventocare.org/",
  },
]

export default function SponsorStrip({ index }: { index: number }) {
  return (
    <SectionReveal index={index} className="mx-auto max-w-6xl mt-10 md:mt-14" clipClass="rounded-none">
      <div className="bg-lsr-charcoal border border-white/5 p-8 md:p-12 relative overflow-hidden">
        {/* Background accent */}
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-lsr-orange to-transparent opacity-50" />
        <div className="absolute -bottom-20 -right-20 w-56 h-56 bg-lsr-orange/5 rounded-full blur-[100px]" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
          <div>
            <h2 className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal">
              The <span className="text-lsr-orange">Partners</span>
            </h2>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-2">Support from the industry</p>
          </div>
          <Link href="/sponsors" className="group flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-lsr-orange hover:text-white transition-colors">
            Become a Partner
            <div className="h-px w-8 bg-lsr-orange/30 group-hover:bg-white group-hover:w-12 transition-all" />
          </Link>
        </div>

        <div className="relative z-10 flex flex-col sm:flex-row items-center justify-center gap-10 md:gap-16">
          {goldSponsors.map((sponsor) => (
            <Link
              key={sponsor.name}
              href={sponsor.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative h-20 w-56 md:h-24 md:w-64 shrink-0 hover:scale-105 transition-transform duration-300"
            >
              <Image
                src={sponsor.logo}
                alt={sponsor.name}
                fill
                className="object-contain"
              />
            </Link>
          ))}
        </div>
      </div>
    </SectionReveal>
  )
}
