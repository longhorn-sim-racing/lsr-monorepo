import Image from "next/image"
import Link from "next/link"
import { Metadata } from "next"
import { ArrowRight, ArrowUpRight, Check, Download, FileText, Instagram, Mail, Minus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CloudinaryImage } from "@/components/cloudinary-image"
import { LogoTile } from "@/components/logo-tile"
import { SPONSORS, GOLD_SPONSORS, sponsorHref, type Sponsor } from "@/lib/sponsors"
import { getClubStats } from "@/server/queries/club-stats"
import { COMPARE, TIERS, tierIndex, type TierId } from "./tiers"

export const metadata: Metadata = {
  title: "Sponsors",
  description: "Partner with Longhorn Sim Racing to support student engineering and motorsport excellence at UT Austin.",
  alternates: {
    canonical: "/sponsors",
  },
};

const SITE_URL = "https://www.longhornsimracing.org"
const OUTREACH_EMAIL = "outreach@longhornsimracing.org"
const PACKET_URL = "/SPONSOR_BENEFITS.pdf"
const VENMO_URL = "https://www.paypal.com/qrcodes/venmocs/e3fd69ab-c345-4b53-add6-4f8037a4760d?created=1767404952.8381681&printed=1"

function mailto(subject?: string) {
  return `mailto:${OUTREACH_EMAIL}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`
}

const partnerListJsonLd = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "Longhorn Sim Racing Partners",
  numberOfItems: SPONSORS.length,
  itemListElement: SPONSORS.map((p, i) => ({
    "@type": "ListItem",
    position: i + 1,
    item: {
      "@type": "Organization",
      name: p.name,
      logo: `${SITE_URL}${p.lightLogo ?? p.logo}`,
      ...(p.url ? { url: p.url } : {}),
      ...(p.description ? { description: p.description } : {}),
    },
  })),
}

// The Business team's pitch
const VALUES = [
  {
    title: "Return on Investment",
    body: "LSR sponsors should expect to be able to see the impact of their contribution, so our board of directors takes care that your impact is well documented.",
  },
  {
    title: "University of Texas Excellence",
    body: "As students at UT, we strive to be the best and the brightest. By sponsoring LSR, you’re empowering students who are dedicated to greatness.",
  },
  {
    title: "Motorsports Democratization",
    body: "Since its inception, racing has never been an affordable endeavor; however, the excessive price of entry and enjoyment has fragmented the enthusiast community. Sponsoring LSR reduces the gap between the audience and the track through meaningful volunteering and industry exposure.",
  },
]

// Recent events, each linking to its gallery album
const OUT_THERE = [
  {
    title: "WEC at COTA",
    date: "Sep 2025",
    body: "A weekend in the paddock at the FIA World Endurance Championship.",
    album: "wec-at-cota-2025",
    photo: "gallery/wec-at-cota-2025/dsc09724",
  },
  {
    title: "F1 Weekend Fan Zone",
    date: "Oct 2025",
    body: "Our sim rigs at a fan zone during US Grand Prix weekend.",
    album: "f1-weekend-fan-zone",
    photo: "gallery/f1-weekend-fan-zone/img-1771",
  },
  {
    title: "Race Club Austin",
    date: "Nov 2025",
    body: "Seat time on the rigs at Race Club Austin.",
    album: "race-club-austin",
    photo: "gallery/race-club-austin/00000362",
  },
  {
    title: "COTA Track Day",
    date: "Feb 2026",
    body: "A day in the paddock and pit lane at Circuit of the Americas.",
    album: "cota-track-day",
    photo: "gallery/cota-track-day/img-1049",
  },
]

const STEPS = [
  { title: "Conversation", body: "We discuss your goals and alignment with our mission." },
  { title: "Selection", body: "Choose a partnership level." },
  { title: "Agreement", body: "Tax documentation and formal contract." },
  { title: "Engagement", body: "Branding integration and sponsorship activation." },
]

function fromLabel(id: TierId) {
  return id === "friend" ? "Every level" : id === "platinum" ? "Platinum" : `${TIERS[tierIndex(id)].short} and up`
}

function SectionHeading({ kicker, children, id }: { kicker: string; children: React.ReactNode; id?: string }) {
  return (
    <div id={id} className="scroll-mt-24">
      <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-3">{kicker}</p>
      <h2 className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal leading-[0.95]">
        {children}
      </h2>
    </div>
  )
}

/** One skewed bar per tier, filled up to this one. */
function TierBars({ rank }: { rank: number }) {
  return (
    <div aria-hidden className="flex gap-1">
      {TIERS.map((tier, i) => (
        <span key={tier.id} className={`h-3 w-2 -skew-x-[20deg] ${i <= rank ? "bg-lsr-orange" : "bg-white/10"}`} />
      ))}
    </div>
  )
}

function FeaturedPartner({ sponsor }: { sponsor: Sponsor }) {
  const body = (
    <>
      <div className="relative flex items-center justify-center border-b md:border-b-0 md:border-r border-white/10 bg-black/20 p-10 md:p-12">
        <div className="relative h-20 md:h-28 w-full max-w-xs">
          <Image
            src={sponsor.logo}
            alt=""
            fill
            sizes="(min-width: 768px) 320px, 80vw"
            className="object-contain transition-transform duration-300 group-hover:scale-105"
          />
        </div>
      </div>
      <div className="flex flex-col justify-center p-6 md:p-10">
        {sponsor.title && (
          <p className="font-sans font-black text-[10px] uppercase tracking-[0.25em] text-lsr-orange">{sponsor.title}</p>
        )}
        <h3 className="mt-3 font-display font-black italic text-3xl md:text-4xl text-white uppercase tracking-normal">
          {sponsor.name}
        </h3>
        {sponsor.description && (
          <p className="mt-4 font-sans text-sm md:text-base text-white/60 leading-relaxed">{sponsor.description}</p>
        )}
        {sponsor.url && (
          <span className="mt-6 inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white group-hover:text-lsr-orange transition-colors">
            Visit {sponsor.name}
            <ArrowUpRight className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </>
  )
  const className =
    "group relative grid md:grid-cols-[2fr_3fr] overflow-hidden border border-white/10 bg-white/[0.02] transition-colors"

  if (!sponsor.url) return <div className={className}>{body}</div>

  return (
    <a
      href={sponsorHref(sponsor.url, "sponsor-page")}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} hover:border-lsr-orange/50`}
    >
      <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange transition-all duration-300 group-hover:w-full" />
      {body}
    </a>
  )
}

/** A miniature of the homepage partner strip, with an open slot. */
function HomepageMock() {
  return (
    <div className="flex h-full flex-col bg-black/40 p-3 md:p-4">
      <div className="flex items-center gap-1.5 mb-3">
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="ml-2 flex-1 truncate border border-white/10 bg-white/[0.03] px-2 py-0.5 font-sans text-[9px] text-white/40">
          longhornsimracing.org
        </span>
      </div>
      <div className="flex flex-1 flex-col justify-center border border-white/10 bg-lsr-charcoal px-4 md:px-6 py-4">
        <div className="h-0.5 w-full bg-gradient-to-r from-transparent via-lsr-orange/60 to-transparent" />
        <p className="mt-4 font-display font-black italic text-lg md:text-2xl text-white uppercase leading-none">
          The <span className="text-lsr-orange">Partners</span>
        </p>
        <p className="mt-1 font-sans font-bold text-[7px] md:text-[8px] uppercase tracking-[0.3em] text-white/40">Support from the industry</p>
        <div className="mt-4 md:mt-6 grid grid-cols-2 items-center gap-x-4 gap-y-3 md:gap-y-4">
          {GOLD_SPONSORS.slice(0, 3).map((sponsor) => (
            <div key={sponsor.name} className="relative h-8 md:h-11">
              <Image src={sponsor.logo} alt="" fill sizes="160px" className="object-contain" />
            </div>
          ))}
          <div className="flex h-8 md:h-11 items-center justify-center border border-dashed border-lsr-orange/70 bg-lsr-orange/[0.06] font-sans font-black text-[8px] md:text-[9px] uppercase tracking-[0.2em] text-lsr-orange">
            Your logo here
          </div>
        </div>
      </div>
    </div>
  )
}

const PLACEMENTS: { from: TierId; kicker: string; title: string; body: string; visual: React.ReactNode }[] = [
  {
    from: "silver",
    kicker: "On the cars",
    title: "Team livery",
    body: "Your logo on Longhorn Sim Racing’s livery.",
    visual: (
      <Image
        src="/images/liveries/watkins-glen-turn-5.webp"
        alt="LSR's two team cars through Turn 5 at Watkins Glen"
        fill
        sizes="(min-width: 768px) 50vw, 100vw"
        className="object-cover transition-transform duration-500 group-hover:scale-105"
      />
    ),
  },
  {
    from: "silver",
    kicker: "Online",
    title: "Our website",
    body: "Your name on this page from Silver. From Gold, your logo on the homepage with a clickable link.",
    visual: <HomepageMock />,
  },
  {
    from: "platinum",
    kicker: "In person",
    title: "Tabling and press",
    body: "Your logo on the team banner we display at tabling and press events.",
    visual: (
      <CloudinaryImage
        publicId="gallery/tabling-with-longhorn-car-club/dsc09970"
        alt="An LSR sim rig set up on campus between two race cars"
        fill
        sizes="(min-width: 768px) 50vw, 100vw"
        className="object-cover transition-transform duration-500 group-hover:scale-105"
      />
    ),
  },
  {
    from: "friend",
    kicker: "On social",
    title: "Shout-outs",
    body: "A shout-out for your business on our social media.",
    visual: (
      <>
        <CloudinaryImage
          publicId="gallery/merch-shoot/img-1345"
          alt="Members in the LSR team kit"
          fill
          sizes="(min-width: 768px) 50vw, 100vw"
          className="object-cover transition-transform duration-500 group-hover:scale-105"
        />
        <span className="absolute bottom-3 left-3 inline-flex items-center gap-2 bg-lsr-charcoal/85 px-3 py-1.5 font-sans font-bold text-[10px] uppercase tracking-[0.15em] text-white">
          <Instagram className="h-3.5 w-3.5 text-lsr-orange" />
          @longhorn_sim_racing
        </span>
      </>
    ),
  },
]

export default async function SponsorsPage() {
  const stats = await getClubStats()
  const [featured, ...others] = [
    ...SPONSORS.filter((sponsor) => sponsor.tier === "gold" && sponsor.description),
    ...SPONSORS.filter((sponsor) => !(sponsor.tier === "gold" && sponsor.description)),
  ]

  const statItems = [
    { value: "2024", label: "Founded" },
    { value: stats ? stats.members.toLocaleString("en-US") : "—", label: "Members" },
    { value: stats ? stats.eventsHosted.toLocaleString("en-US") : "—", label: "Events hosted" },
    { value: "S3", label: "Lone Star Cup season" },
  ]

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(partnerListJsonLd) }}
      />

      {/* Hero */}
      <div className="relative border-b border-white/10 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <Image
            src="/images/liveries/daytona-grid-pair.webp"
            alt=""
            fill
            sizes="100vw"
            preload
            className="object-cover object-[center_60%] opacity-80"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/70 via-lsr-charcoal/20 to-lsr-charcoal" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal/90 via-lsr-charcoal/40 to-transparent" />
        </div>
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />

        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 pt-24 pb-16 md:pt-40 md:pb-24">
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-4">Sponsor LSR</p>
          <h1 className="max-w-3xl font-display font-black italic text-5xl md:text-8xl text-white uppercase tracking-normal leading-[0.9]">
            Put your brand <span className="text-lsr-orange">on the grid</span>
          </h1>
          <p className="mt-6 max-w-xl font-sans text-base md:text-xl font-bold text-white/80 leading-relaxed">
            Collaborate with UT Austin&apos;s premier collegiate motorsport organization to drive innovation and engineering excellence.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-3">
            <Button
              asChild
              className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12 px-8 transition-all"
            >
              <a href={mailto("Sponsoring Longhorn Sim Racing")}>
                <Mail className="w-3.5 h-3.5 mr-2" />
                Start a conversation
              </a>
            </Button>
            <Button
              asChild
              className="rounded-none border border-white/20 bg-lsr-charcoal/40 text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12 px-8 transition-all"
            >
              <a href={PACKET_URL} target="_blank" download>
                <Download className="w-3.5 h-3.5 mr-2" />
                Sponsor packet (PDF)
              </a>
            </Button>
          </div>
          <p className="mt-8 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/50">
            501(c)(3) nonprofit · Tax-deductible · W-9 on request
          </p>
        </div>
      </div>

      {/* Stats */}
      <section aria-label="LSR at a glance" className="border-b border-white/10 bg-black/20">
        <dl className="mx-auto max-w-6xl grid grid-cols-2 md:grid-cols-4">
          {statItems.map((stat, i) => (
            <div
              key={stat.label}
              className={`flex flex-col px-6 md:px-8 py-8 md:py-10 border-white/10 ${i % 2 === 0 ? "border-r" : ""} ${i < 2 ? "border-b md:border-b-0" : ""} ${i === 1 ? "md:border-r" : ""}`}
            >
              <dt className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/40 order-2 mt-3">{stat.label}</dt>
              <dd className="font-display font-black italic text-3xl sm:text-4xl md:text-6xl text-white leading-none order-1">{stat.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-16 md:py-24 space-y-24 md:space-y-32">
        {/* Current partners */}
        <section>
          <div className="mb-10 md:mb-12">
            <SectionHeading kicker="Backed by">
              Current <span className="text-lsr-orange">partners</span>
            </SectionHeading>
          </div>
          <div className="space-y-3 md:space-y-4">
            {featured && <FeaturedPartner sponsor={featured} />}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
              {others.map((sponsor) => (
                <LogoTile
                  key={sponsor.name}
                  name={sponsor.name}
                  logo={sponsor.logo}
                  title={sponsor.title}
                  detail={sponsor.description}
                  sizes="(min-width: 640px) 30vw, 85vw"
                  href={sponsor.url ? sponsorHref(sponsor.url, "sponsor-page") : undefined}
                />
              ))}
            </div>
          </div>
        </section>

        {/* Why LSR */}
        <section>
          <div className="grid gap-12 lg:grid-cols-[3fr_2fr] lg:gap-16">
            <div>
              <SectionHeading kicker="Why LSR">
                Worth your <span className="text-lsr-orange">investment</span>
              </SectionHeading>
              <div className="mt-10 space-y-8">
                <div>
                  <h3 className="font-sans font-black text-xs uppercase tracking-[0.25em] text-white mb-3">Ethos</h3>
                  <p className="font-sans text-white/65 leading-relaxed">
                    Longhorn Sim Racing is more than a competitive team; we are a professional, student-run, non-profit dedicated to creating opportunities for career engagement for every one of our members. By drawing talent from our disparate campus community - engineering, business, media, graphic design, and communications - our members apply classroom lectures to the demanding reality of motorsports. By contributing to LSR, you align your brand with a passionate talent pipeline while supporting the practical application of creative, technical, and entrepreneurial principles.
                  </p>
                </div>
                <div>
                  <h3 className="font-sans font-black text-xs uppercase tracking-[0.25em] text-white mb-3">Our Promise</h3>
                  <p className="font-sans text-white/65 leading-relaxed">
                    We deliver through action and we measure our success through the achievements of our students. As a student organization, LSR’s success is a function of how well we can help our members develop their major-specific skillset and pursue meaningful opportunities. If we were at any other school, this would seem a lofty task, but we’re at the University of Texas at Austin, and the Circuit of the Americas is in our back yard. Both directly and indirectly through our industry connections, students have achieved internships, sat in pitlane at international competitions, driven at autocross events, and competed against other university sim racing drivers.
                  </p>
                </div>
              </div>
            </div>
            <ol className="grid gap-3 md:gap-4 self-end">
              {VALUES.map((value, i) => (
                <li key={value.title} className="relative border border-white/10 bg-white/[0.02] p-6 md:p-7">
                  <div className="absolute top-0 left-0 h-1 w-10 bg-lsr-orange" />
                  <div className="flex items-baseline gap-3">
                    <span className="font-display font-black italic text-2xl text-lsr-orange">0{i + 1}</span>
                    <h3 className="font-sans font-black text-sm uppercase tracking-[0.15em] text-white">{value.title}</h3>
                  </div>
                  <p className="mt-3 font-sans text-sm text-white/55 leading-relaxed">{value.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Where sponsors show up */}
        <section>
          <div className="grid gap-6 md:grid-cols-[1fr_1fr] md:items-end mb-10 md:mb-12">
            <SectionHeading kicker="Visibility">
              Where your brand <span className="text-lsr-orange">shows up</span>
            </SectionHeading>
            <p className="font-sans text-white/60 text-base md:text-lg leading-relaxed">
              From the cars to campus, here&apos;s where partners appear. The packages below spell out what each level includes.
            </p>
          </div>
          <div className="grid gap-4 md:gap-6 md:grid-cols-2">
            {PLACEMENTS.map((placement) => (
              <article key={placement.title} className="group flex flex-col overflow-hidden border border-white/10 bg-white/[0.02]">
                <div className="relative aspect-video overflow-hidden border-b border-white/10 bg-black/30">
                  {placement.visual}
                  <span className="absolute top-3 right-3 bg-lsr-orange px-2 py-1 font-sans font-black text-[9px] uppercase tracking-[0.2em] text-white">
                    {fromLabel(placement.from)}
                  </span>
                </div>
                <div className="p-6 md:p-7">
                  <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/40">{placement.kicker}</p>
                  <h3 className="mt-2 font-display font-black italic text-2xl md:text-3xl text-white uppercase tracking-normal">
                    {placement.title}
                  </h3>
                  <p className="mt-2 font-sans text-sm md:text-base text-white/60 leading-relaxed">{placement.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* Out there */}
        <section>
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-10 md:mb-12">
            <SectionHeading kicker="On the ground">
              Where we&apos;ve <span className="text-lsr-orange">been</span>
            </SectionHeading>
            <Link
              href="/gallery"
              className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white transition-colors"
            >
              The full gallery
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
            {OUT_THERE.map((item) => (
              <Link
                key={item.album}
                href={`/gallery?album=${item.album}`}
                className="group relative flex aspect-[4/3] sm:aspect-[4/5] flex-col justify-end overflow-hidden border border-white/10 transition-colors hover:border-lsr-orange/50"
              >
                <CloudinaryImage
                  publicId={item.photo}
                  alt=""
                  fill
                  sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
                  className="object-cover opacity-80 transition-all duration-500 group-hover:scale-105 group-hover:opacity-100"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal via-lsr-charcoal/80 via-40% to-transparent" />
                <div className="relative p-5">
                  <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">{item.date}</p>
                  <h3 className="mt-2 font-display font-black italic text-2xl text-white uppercase tracking-normal leading-tight">
                    {item.title}
                  </h3>
                  <p className="mt-2 font-sans text-xs text-white/65 leading-relaxed">{item.body}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Packages */}
        <section>
          <div className="grid gap-6 md:grid-cols-[1fr_1fr] md:items-end mb-10 md:mb-12">
            <SectionHeading kicker="Packages" id="packages">
              Pick your <span className="text-lsr-orange">level</span>
            </SectionHeading>
            <p className="font-sans text-white/60 text-base md:text-lg leading-relaxed">
              Sponsorship at any level includes all items up through that level.
            </p>
          </div>

          <div className="grid gap-3 md:gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {TIERS.map((tier, i) => {
              const top = i === TIERS.length - 1
              return (
                <article
                  key={tier.id}
                  className={`relative flex flex-col border p-6 md:p-7 ${
                    top ? "border-lsr-orange/60 bg-lsr-orange/[0.07]" : "border-white/10 bg-white/[0.02]"
                  }`}
                >
                  {top && <div className="absolute top-0 left-0 h-1 w-full bg-lsr-orange" />}
                  <TierBars rank={i} />
                  <h3 className="mt-5 font-sans font-black text-sm uppercase tracking-[0.15em] text-white">{tier.name}</h3>
                  <p className="mt-2 font-display font-black italic text-3xl text-white leading-none whitespace-nowrap">{tier.price}</p>
                  <div className="mt-6 pt-6 border-t border-white/10 flex-1">
                    {i > 0 && (
                      <p className="mb-4 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/40">
                        Everything in {TIERS[i - 1].short}, plus
                      </p>
                    )}
                    <ul className="space-y-3">
                      {tier.benefits.map((benefit) => (
                        <li key={benefit} className="flex items-start gap-3 font-sans text-sm text-white/80 leading-snug">
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-lsr-orange" />
                          <span>{benefit}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Button
                    asChild
                    className={`mt-8 w-full rounded-none font-bold uppercase tracking-widest text-[10px] h-11 transition-all ${
                      top
                        ? "bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal"
                        : "border border-white/15 bg-transparent text-white hover:bg-white hover:text-lsr-charcoal"
                    }`}
                  >
                    <a href={mailto(`Discussion: ${tier.name}`)}>Talk about {tier.short}</a>
                  </Button>
                </article>
              )
            })}
          </div>

          {/* Comparison */}
          <div className="mt-12 md:mt-16">
            <h3 className="font-display font-black italic text-2xl md:text-3xl text-white uppercase tracking-normal mb-6">
              Compare <span className="text-lsr-orange">benefits</span>
            </h3>
            <div className="overflow-x-auto border border-white/10 bg-white/[0.02]">
              <table className="w-full text-left">
                <thead className="bg-white/[0.04] font-sans font-black text-[10px] uppercase tracking-[0.15em] text-white/60">
                  <tr>
                    <th scope="col" className="p-3 sm:p-4">Benefit</th>
                    {TIERS.map((tier) => (
                      <th key={tier.id} scope="col" className="px-1 py-3 sm:p-4 text-center w-[12%] sm:w-[16%]">
                        <span aria-hidden className="sm:hidden">{tier.short[0]}</span>
                        <span className="sr-only sm:not-sr-only">{tier.short}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-sans text-xs md:text-sm text-white/80">
                  {COMPARE.map((row) => (
                    <tr key={row.label} className="hover:bg-white/[0.02]">
                      <th scope="row" className="p-3 sm:p-4 font-bold text-left">{row.label}</th>
                      {TIERS.map((tier, i) => (
                        <td key={tier.id} className="px-1 py-3 sm:p-4 text-center">
                          {i >= tierIndex(row.from) ? (
                            <>
                              <Check aria-hidden className="h-4 w-4 mx-auto text-lsr-orange" />
                              <span className="sr-only">Included</span>
                            </>
                          ) : (
                            <>
                              <Minus aria-hidden className="h-4 w-4 mx-auto text-white/15" />
                              <span className="sr-only">Not included</span>
                            </>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section>
          <div className="mb-10 md:mb-12">
            <SectionHeading kicker="The process">
              How it <span className="text-lsr-orange">works</span>
            </SectionHeading>
          </div>
          <ol className="grid gap-px bg-white/10 border border-white/10 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="bg-lsr-charcoal p-6 md:p-8">
                <span className="font-display font-black italic text-5xl md:text-6xl text-white/10 leading-none">0{i + 1}</span>
                <h3 className="mt-4 font-sans font-black text-sm uppercase tracking-[0.2em] text-white">{step.title}</h3>
                <p className="mt-2 font-sans text-sm text-white/55 leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* The details */}
        <section>
          <div className="mb-10 md:mb-12">
            <SectionHeading kicker="The details">
              Good to <span className="text-lsr-orange">know</span>
            </SectionHeading>
          </div>
          <div className="grid gap-3 md:gap-4 lg:grid-cols-3">
            <div className="flex flex-col border border-white/10 bg-white/[0.02] p-6 md:p-8">
              <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal">
                Tax <span className="text-lsr-orange">exemption</span>
              </h3>
              <p className="mt-4 font-sans text-sm text-white/65 leading-relaxed flex-1">
                W-9 available upon request. All donors will receive a receipt for tax exemption as we are a 501(c)3 nonprofit organization.
              </p>
              <a
                href={mailto("W-9 Request")}
                className="mt-6 inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white transition-colors"
              >
                <FileText className="h-3.5 w-3.5" />
                Request a W-9
              </a>
            </div>

            <div className="flex flex-col border border-white/10 bg-white/[0.02] p-6 md:p-8">
              <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal">
                Deadlines & <span className="text-lsr-orange">specs</span>
              </h3>
              <dl className="mt-4 space-y-4 font-sans text-sm">
                <div>
                  <dt className="font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange">Pledge by July 31</dt>
                  <dd className="mt-1 text-white/65 leading-relaxed">To meet printing deadlines, please pledge by this date.</dd>
                </div>
                <div>
                  <dt className="font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange">Logo format</dt>
                  <dd className="mt-1 text-white/65 leading-relaxed">
                    Logos must be submitted in <span className="text-white font-bold">PNG</span> or <span className="text-white font-bold">JPG</span> format and be a high resolution image. If we can’t work with your logo, we may not be able to include it.
                  </dd>
                </div>
                <div>
                  <dt className="font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange">Send logos to</dt>
                  <dd className="mt-1">
                    <a href={mailto("Sponsor logo")} className="text-white font-bold break-all hover:text-lsr-orange transition-colors">
                      {OUTREACH_EMAIL}
                    </a>
                  </dd>
                </div>
              </dl>
            </div>

            <div className="flex flex-col border border-white/10 bg-white/[0.02] p-6 md:p-8">
              <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal">
                To <span className="text-lsr-orange">donate</span>
              </h3>
              <p className="mt-4 font-sans text-sm text-white/65 leading-relaxed flex-1">
                Please make a donation through Venmo or make a check payable to:{" "}
                <span className="text-white font-bold">Longhorn Sim Racing</span>
              </p>
              <Button
                asChild
                className="mt-6 w-full sm:w-fit rounded-none border border-white/15 bg-transparent text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-11 px-6 transition-all"
              >
                <a href={VENMO_URL} target="_blank" rel="noopener noreferrer">
                  Donate via Venmo
                  <ArrowUpRight className="w-3.5 h-3.5 ml-2" />
                </a>
              </Button>
            </div>
          </div>
        </section>
      </div>

      {/* Closing CTA */}
      <section className="relative overflow-hidden border-t border-white/10">
        <div className="absolute inset-0 z-0">
          <Image
            src="/images/liveries/le-mans-amg-pit-exit.webp"
            alt=""
            fill
            sizes="100vw"
            className="object-cover opacity-60"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal via-lsr-charcoal/80 to-lsr-charcoal/20" />
          <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal/80 to-transparent" />
        </div>
        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 py-20 md:py-32">
          <div className="max-w-xl">
            <h2 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9]">
              Let&apos;s <span className="text-lsr-orange">talk</span>
            </h2>
            <p className="mt-5 font-sans text-base md:text-lg text-white/70 leading-relaxed">
              A partnership with Longhorn Sim Racing provides many business opportunities from helping with the company’s community awareness to raising future employees.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              <Button
                asChild
                className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12 px-8 transition-all"
              >
                <a href={mailto("Sponsoring Longhorn Sim Racing")}>
                  <Mail className="w-3.5 h-3.5 mr-2" />
                  Email our outreach team
                </a>
              </Button>
              <Button
                asChild
                className="rounded-none border border-white/20 bg-lsr-charcoal/40 text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12 px-8 transition-all"
              >
                <a href={PACKET_URL} target="_blank" download>
                  <Download className="w-3.5 h-3.5 mr-2" />
                  Sponsor packet (PDF)
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
