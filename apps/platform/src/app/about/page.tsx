import Image from "next/image"
import Link from "next/link"
import { Metadata } from "next"
import { ArrowRight, ArrowUpRight, CalendarDays, MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LogoTile } from "@/components/logo-tile"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { getClubStats } from "@/server/queries/club-stats"
import { GOLD_SPONSORS, sponsorHref } from "@/lib/sponsors"
import { OFFICERS, TEAMS, type Officer, type Team } from "./roster"
import { CreateAccountButton } from "./create-account-button"

export const metadata: Metadata = {
  title: "About Us",
  description:
    "Longhorn Sim Racing is UT Austin's student-run sim racing club: the Lone Star Cup league, seat time on club rigs, community events and the officer teams that run it all.",
  alternates: {
    canonical: "/about",
  },
};

const DISCORD_URL = "https://discord.gg/5Uv9YwpnFz"

const PILLARS = [
  {
    kicker: "Race",
    title: "The Lone Star Cup",
    body: "Our in-house league, now in its third season. Ten Saturday rounds a semester with real race control and stewarding, open to every skill level.",
    href: "/lone-star-cup",
    cta: "See the championship",
    image: "/images/gal_03.jpeg",
  },
  {
    kicker: "Drive",
    title: "Seat Time",
    body: "Get behind the wheel on the club sim rig in the Longhorn Gaming lounge, join time trials and pick up racecraft from drivers who've been there.",
    href: "/events",
    cta: "Find a session",
    image: "/images/gal_08.jpeg",
  },
  {
    kicker: "Hang out",
    title: "Community",
    body: "Watch parties, sim nights and socials, plus days at the track volunteering at events around Austin.",
    href: "/events",
    cta: "Upcoming events",
    image: "/images/gal_11.jpg",
  },
  {
    kicker: "Build",
    title: "Run the Club",
    body: "Students run every part of LSR: the league, sponsorships, media and the software behind this site. Join a team and get real experience.",
    href: "#teams",
    cta: "Meet the teams",
    image: "/images/gal_05.JPG",
  },
]

// UT motorsport orgs we work with. Logos come from each org's own site or HornsLink page.
const CAMPUS_PARTNERS = [
  { name: "Longhorn Racing", detail: "Formula SAE & solar", logo: "/partners/longhorn-racing.png", href: "https://longhornracing.org/" },
  { name: "Longhorn Baja Racing", detail: "Baja SAE", logo: "/partners/longhorn-baja-racing.png", href: "https://www.instagram.com/longhornbaja/" },
  { name: "Longhorn Car Club", detail: "Car meets & culture", logo: "/partners/longhorn-car-club.png", href: "https://texaslcc.com/" },
  { name: "Orange Dames", detail: "Longhorn Lemons Racing", logo: "/partners/orange-dames.png", href: "https://sites.utexas.edu/orangedames/" },
]

const teamById = new Map(TEAMS.map((team) => [team.id, team]))

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

function SectionHeading({ kicker, children, id }: { kicker: string; children: React.ReactNode; id?: string }) {
  return (
    <div id={id} className="scroll-mt-24 mb-10 md:mb-12">
      <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-3">{kicker}</p>
      <h2 className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal leading-[0.95]">
        {children}
      </h2>
    </div>
  )
}

/** Board tile: the officer's photo, or an initials tile until one exists. */
function Portrait({ officer, team }: { officer: Officer; team: Team }) {
  return (
    <div className="group">
      <div className="relative aspect-[4/5] overflow-hidden border border-white/10 bg-gradient-to-br from-white/[0.07] via-white/[0.02] to-transparent transition-colors group-hover:border-lsr-orange/50">
        {officer.photo ? (
          <Image
            src={officer.photo}
            alt=""
            fill
            sizes="(min-width: 1024px) 25vw, 50vw"
            className="object-cover object-[center_25%]"
          />
        ) : (
          <>
            <div className="absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-lsr-orange/10 blur-3xl transition-opacity duration-300 group-hover:opacity-100 opacity-60" />
            <div className="absolute inset-0 opacity-[0.04] [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_12px)]" />
            <span
              aria-hidden
              className="absolute inset-0 flex items-center justify-center font-display font-black italic text-6xl md:text-8xl text-white/20 transition-colors duration-300 group-hover:text-lsr-orange/80"
            >
              {initials(officer.name)}
            </span>
          </>
        )}
        <span className="absolute top-3 left-3 bg-lsr-charcoal/80 px-2 py-1 font-sans font-black text-[9px] uppercase tracking-[0.2em] text-white/70">
          {team.code}
        </span>
        <div className="absolute bottom-0 left-0 h-1 w-10 bg-lsr-orange transition-all duration-300 group-hover:w-full" />
      </div>
      <h3 className="mt-4 font-display font-black italic text-lg md:text-2xl text-white uppercase tracking-normal leading-tight">
        {officer.name}
      </h3>
      <p className="mt-1 font-sans font-bold text-[10px] md:text-xs uppercase tracking-[0.2em] text-lsr-orange">
        {officer.title}
      </p>
    </div>
  )
}

/** Small square avatar for the team lists. */
function Avatar({ officer }: { officer: Officer }) {
  return (
    <div className="relative h-10 w-10 shrink-0 overflow-hidden border border-white/10 bg-white/[0.05]">
      {officer.photo ? (
        <Image src={officer.photo} alt="" fill sizes="40px" className="object-cover object-[center_20%]" />
      ) : (
        <span aria-hidden className="absolute inset-0 flex items-center justify-center font-display font-black italic text-sm text-white/40">
          {initials(officer.name)}
        </span>
      )}
    </div>
  )
}

export default async function AboutPage() {
  const [stats, { user: viewer }] = await Promise.all([getClubStats(), getCachedSessionUser()])
  const board = OFFICERS.filter((officer) => officer.board)

  const statItems = [
    { value: "2024", label: "Founded" },
    { value: stats ? stats.members.toLocaleString("en-US") : "—", label: "Members" },
    { value: stats ? stats.eventsHosted.toLocaleString("en-US") : "—", label: "Events hosted" },
    { value: "S3", label: "Lone Star Cup" },
  ]

  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      {/* Hero Section */}
      <div className="relative border-b border-white/10 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <Image
            src="/images/lsr-hero.webp"
            alt="Hero Background"
            fill
            className="object-cover opacity-40 grayscale-[0.5]"
            priority
            fetchPriority="high"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/80 via-lsr-charcoal/60 to-lsr-charcoal" />
        </div>
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />

        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 py-20 md:py-28">
          <div className="max-w-4xl">
            <h1 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9] mb-8">
              Who We <span className="text-lsr-orange">Are</span>
            </h1>
            <p className="font-sans text-lg md:text-2xl font-bold text-white/90 leading-relaxed">
              Longhorn Sim Racing is a student-led, interdisciplinary organization dedicated to uniting passions for simulation racing, e-sports, engineering, and motorsports. Our mission is to make the world of sim-racing and competitive motorsports more accessible to students who might not otherwise have the opportunity to engage with it.
            </p>
          </div>
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
              <dd className="font-display font-black italic text-4xl md:text-6xl text-white leading-none order-1">{stat.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-16 md:py-24 space-y-24 md:space-y-32">
        {/* What we do */}
        <section>
          <div className="grid gap-6 md:grid-cols-[1fr_1fr] md:items-end mb-10 md:mb-12">
            <SectionHeading kicker="What we do">
              On track and <span className="text-lsr-orange">off it</span>
            </SectionHeading>
            <p className="font-sans text-white/60 text-base md:text-lg leading-relaxed md:mb-12">
              Founded in 2024 and run entirely by students, LSR is a 501(c)(3) nonprofit open to every Longhorn,
              whether you&apos;ve never touched a wheel or you&apos;re chasing tenths.
            </p>
          </div>

          <div className="grid gap-4 md:gap-6 md:grid-cols-2">
            {PILLARS.map((pillar, i) => (
              <Link
                key={pillar.title}
                href={pillar.href}
                className="group relative flex min-h-[340px] md:min-h-[380px] flex-col justify-end overflow-hidden border border-white/10 transition-colors hover:border-lsr-orange/50"
              >
                <Image
                  src={pillar.image}
                  alt=""
                  fill
                  sizes="(min-width: 768px) 50vw, 100vw"
                  className="object-cover opacity-75 grayscale-[0.2] transition-all duration-500 group-hover:scale-105 group-hover:opacity-90"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal via-lsr-charcoal/75 via-45% to-transparent" />
                <div className="relative p-6 md:p-8">
                  <div className="flex items-baseline gap-3 mb-3">
                    <span className="font-display font-black italic text-2xl text-lsr-orange">0{i + 1}</span>
                    <span className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/50">{pillar.kicker}</span>
                  </div>
                  <h3 className="font-display font-black italic text-3xl md:text-4xl text-white uppercase tracking-normal mb-3">
                    {pillar.title}
                  </h3>
                  <p className="font-sans text-sm md:text-base text-white/70 leading-relaxed max-w-md">{pillar.body}</p>
                  <span className="mt-6 inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white group-hover:text-lsr-orange transition-colors">
                    {pillar.cta}
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Leadership */}
        <section>
          <SectionHeading kicker="Leadership">
            The <span className="text-lsr-orange">Board</span>
          </SectionHeading>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-10 md:gap-x-6">
            {board.map((officer) => (
              <Portrait key={officer.name} officer={officer} team={teamById.get(officer.team)!} />
            ))}
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex aspect-[4/5] flex-col justify-between border border-dashed border-white/15 p-5 md:p-6 transition-colors hover:border-lsr-orange hover:bg-lsr-orange/5"
            >
              <span className="font-sans font-black text-[9px] uppercase tracking-[0.2em] text-white/40">Open seat</span>
              <div>
                <p className="font-display font-black italic text-2xl md:text-3xl text-white uppercase leading-none">
                  Your name <span className="text-lsr-orange">here</span>
                </p>
                <p className="mt-3 font-sans text-xs md:text-sm text-white/50 leading-relaxed">
                  Every team takes new officers. Ask about open roles on Discord.
                </p>
                <ArrowUpRight className="mt-4 h-5 w-5 text-white/40 transition-colors group-hover:text-lsr-orange" />
              </div>
            </a>
          </div>
        </section>

        {/* Teams */}
        <section>
          <SectionHeading kicker="Who does what" id="teams">
            The <span className="text-lsr-orange">Teams</span>
          </SectionHeading>
          <div className="grid gap-4 md:gap-6 md:grid-cols-2 lg:grid-cols-3">
            {TEAMS.map((team) => {
              const members = OFFICERS.filter((officer) => officer.team === team.id)
              return (
                <article key={team.id} className="flex flex-col border border-white/10 bg-white/[0.02] p-6 md:p-7">
                  <div className="flex items-center justify-between mb-5">
                    <span className="font-sans font-black text-[9px] uppercase tracking-[0.2em] text-lsr-orange border border-lsr-orange/30 px-2 py-1">
                      {team.code}
                    </span>
                    <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/30">
                      {members.length} {members.length === 1 ? "officer" : "officers"}
                    </span>
                  </div>
                  <h3 className="font-display font-black italic text-3xl text-white uppercase tracking-normal">{team.name}</h3>
                  <p className="mt-2 font-sans text-sm text-white/55 leading-relaxed">{team.blurb}</p>
                  <ul className="mt-6 pt-6 border-t border-white/10 space-y-3">
                    {members.map((officer) => (
                      <li key={officer.name} className="flex items-center gap-3">
                        <Avatar officer={officer} />
                        <div className="min-w-0">
                          <p className="font-sans font-bold text-sm text-white truncate">{officer.name}</p>
                          <p
                            className={`font-sans font-bold text-[10px] uppercase tracking-[0.15em] ${
                              officer.title === "Officer" ? "text-white/35" : "text-lsr-orange"
                            }`}
                          >
                            {officer.title}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </article>
              )
            })}
          </div>
        </section>

        {/* Partners and sponsors */}
        <section className="space-y-16 md:space-y-20">
          <div>
            <div className="grid gap-6 md:grid-cols-[1fr_1fr] md:items-end mb-10 md:mb-12">
              <SectionHeading kicker="Around campus">
                Campus <span className="text-lsr-orange">partners</span>
              </SectionHeading>
              <p className="font-sans text-white/60 text-base md:text-lg leading-relaxed md:mb-12">
                We work alongside UT&apos;s other motorsport orgs on events, recruiting and sim-to-real projects.
              </p>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
              {CAMPUS_PARTNERS.map((partner) => (
                <LogoTile key={partner.name} {...partner} sizes="(min-width: 1024px) 240px, 45vw" />
              ))}
            </div>
          </div>

          <div>
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-10 md:mb-12">
              <SectionHeading kicker="Backed by">
                Our <span className="text-lsr-orange">sponsors</span>
              </SectionHeading>
              <Link
                href="/sponsors"
                className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white transition-colors md:mb-12"
              >
                Become a partner
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
              {GOLD_SPONSORS.map((sponsor) => (
                <LogoTile
                  key={sponsor.name}
                  name={sponsor.name}
                  logo={sponsor.logo}
                  title={sponsor.title}
                  sizes="(min-width: 640px) 30vw, 85vw"
                  href={sponsor.url ? sponsorHref(sponsor.url, "sponsor-about") : "/sponsors"}
                />
              ))}
            </div>
          </div>
        </section>

        {/* Join */}
        <section className="relative overflow-hidden border border-white/10 bg-white/[0.02] p-8 md:p-14">
          <div className="absolute top-0 left-0 h-1 w-full bg-gradient-to-r from-lsr-orange via-lsr-orange/40 to-transparent" />
          <div className="absolute -bottom-24 -right-24 h-64 w-64 rounded-full bg-lsr-orange/10 blur-[100px] pointer-events-none" />
          <div className="relative max-w-2xl">
            <h2 className="font-display font-black italic text-4xl md:text-6xl text-white uppercase tracking-normal leading-[0.95]">
              Get on the <span className="text-lsr-orange">grid</span>
            </h2>
            <p className="mt-5 font-sans text-white/60 text-base md:text-lg leading-relaxed">
              {viewer
                ? "You're already a member. Come say hi on Discord and grab a spot at the next event."
                : "Your account on this site is your LSR membership. Make one, join the Discord and come to an event."}
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              {!viewer && <CreateAccountButton />}
              <Button
                asChild
                className={`rounded-none font-bold uppercase tracking-widest text-[10px] h-12 px-8 transition-all ${
                  viewer
                    ? "bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal"
                    : "border border-white/15 bg-transparent text-white hover:bg-white hover:text-lsr-charcoal"
                }`}
              >
                <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
                  <MessageSquare className="w-3.5 h-3.5 mr-2" />
                  Join the Discord
                </a>
              </Button>
              <Button
                asChild
                className="rounded-none border border-white/15 bg-transparent text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12 px-8 transition-all"
              >
                <Link href="/events">
                  <CalendarDays className="w-3.5 h-3.5 mr-2" />
                  Upcoming events
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
