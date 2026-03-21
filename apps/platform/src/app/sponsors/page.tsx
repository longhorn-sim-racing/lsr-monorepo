import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import Image from "next/image"
import { Check, Download, ExternalLink, ArrowRight, Building2, Users, Trophy, Cpu } from "lucide-react"
import { Metadata } from "next"

type Partner = {
  name: string
  logo: string
  href?: string
  description?: string
}

const partners: Partner[] = [
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
  {
    name: "Yugo",
    logo: "/sponsors/yugo.png",
    description: "Yugo is a global student living brand and operator creating safe, supportive communities where students can connect and thrive.",
  },
]

function PartnerCard({ partner }: { partner: Partner }) {
  const content = (
    <>
      <div className="relative h-20 w-56 mb-6 group-hover:scale-105 transition-transform duration-300">
        <Image
          src={partner.logo}
          alt={partner.name}
          fill
          className="object-contain"
        />
      </div>
      <h3 className="font-sans font-black text-sm uppercase tracking-widest text-white mb-2">{partner.name}</h3>
      {partner.description && (
        <p className="font-sans text-sm text-white/60 leading-relaxed max-w-md">{partner.description}</p>
      )}
      {partner.href && (
        <span className="mt-4 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-lsr-orange group-hover:text-white transition-colors">
          Visit <ExternalLink className="h-3 w-3" />
        </span>
      )}
    </>
  )

  const className = "group border border-white/10 bg-white/[0.02] p-8 flex flex-col items-center text-center hover:border-white/20 transition-colors"

  if (partner.href) {
    return (
      <Link href={partner.href} target="_blank" rel="noopener noreferrer" className={className}>
        {content}
      </Link>
    )
  }

  return <div className={className}>{content}</div>
}

function CurrentPartners() {
  return (
    <section className="mb-20 pb-20 border-b border-white/5">
      <h2 className="font-display font-black italic text-3xl md:text-4xl text-white uppercase tracking-normal mb-10">
        Current <span className="text-lsr-orange">Partners</span>
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {partners.map((partner) => (
          <PartnerCard key={partner.name} partner={partner} />
        ))}
      </div>
    </section>
  )
}

export const metadata: Metadata = {
  title: "Sponsors",
  description: "Partner with Longhorn Sim Racing to support student engineering and motorsport excellence at UT Austin.",
  alternates: {
    canonical: "/sponsors",
  },
};

export default function SponsorsPage() {
  const outreachEmail = "outreach@longhornsimracing.org"

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      {/* Hero Section */}
      <div className="relative border-b border-white/10 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <Image 
            src="/images/lsr-hero2.webp" 
            alt="Hero Background" 
            fill 
            className="object-cover opacity-40 grayscale-[0.5]"
            priority
            fetchPriority="high"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/80 via-lsr-charcoal/60 to-lsr-charcoal" />
        </div>
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />
        
        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 py-20 md:py-32 text-center">
          <h1 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9] mb-6">
            Sponsor <span className="text-lsr-orange">our Organization</span>
          </h1>
          <p className="font-sans text-lg md:text-xl font-bold text-white/70 max-w-2xl mx-auto leading-relaxed">
            Collaborate with UT Austin&apos;s premier collegiate motorsport organization to drive innovation and engineering excellence.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row justify-center gap-6">
            <Button asChild size="lg" className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-black uppercase tracking-[0.2em] text-xs h-14 px-8 transition-all">
              <Link href={`mailto:${outreachEmail}`}>Start a Conversation</Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="rounded-none border-white/20 hover:bg-white/10 text-white font-black uppercase tracking-[0.2em] text-xs h-14 px-8 transition-all">
              <Link href="#partnership-options">View Options</Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">

        {/* Current Partners */}
        <CurrentPartners />

        {/* Why Partner With LSR? - Credibility Section */}
        <section className="mb-20">
          <div className="grid md:grid-cols-2 gap-12 items-start">
            <div>
              <h2 className="font-display font-black italic text-3xl md:text-4xl text-white uppercase tracking-normal mb-8">
                LSR is worth <span className="text-lsr-orange">your investment</span>
              </h2>
              <div className="space-y-8">
                <div>
                  <h3 className="font-sans font-black text-lg text-white uppercase tracking-tight mb-3">Ethos</h3>
                  <p className="font-sans text-white/70 leading-relaxed">
                    Longhorn Sim Racing is more than a competitive team; we are a professional, student-run, non-profit dedicated to creating opportunities for career engagement for every one of our members. By drawing talent from our disparate campus community - engineering, business, media, graphic design, and communications - our members apply classroom lectures to the demanding reality of motorsports. By contributing to LSR, you align your brand with a passionate talent pipeline while supporting the practical application of creative, technical, and entrepreneurial principles.
                  </p>
                </div>
                <div>
                  <h3 className="font-sans font-black text-lg text-white uppercase tracking-tight mb-3">Our Promise</h3>
                  <p className="font-sans text-white/70 leading-relaxed">
                    We deliver through action and we measure our success through the achievements of our students. As a student organization, LSR’s success is a function of how well we can help our members develop their major-specific skillset and pursue meaningful opportunities. If we were at any other school, this would seem a lofty task, but we’re at the University of Texas at Austin, and the Circuit of the Americas is in our back yard. Both directly and indirectly through our industry connections, students have achieved internships, sat in pitlane at international competitions, driven at autocross events, and competed against other university sim racing drivers.
                  </p>
                </div>
              </div>
            </div>
            <div className="grid gap-6">
              <div className="bg-white/[0.02] border border-white/10 p-8 flex flex-col h-full hover:border-white/20 transition-colors">
                <Trophy className="h-10 w-10 text-lsr-orange mb-6" />
                <h3 className="font-sans font-black text-xl uppercase tracking-widest text-white mb-4">Return on Investment</h3>
                <p className="text-sm text-white/60 leading-relaxed">
                  LSR sponsors should expect to be able to see the impact of their contribution, so our board of directors takes care that your impact is well documented.
                </p>
              </div>
              <div className="bg-white/[0.02] border border-white/10 p-8 flex flex-col h-full hover:border-white/20 transition-colors">
                <Building2 className="h-10 w-10 text-lsr-orange mb-6" />
                <h3 className="font-sans font-black text-xl uppercase tracking-widest text-white mb-4">University of Texas Excellence</h3>
                <p className="text-sm text-white/60 leading-relaxed">
                  As students at UT, we strive to be the best and the brightest. By sponsoring LSR, you’re empowering students who are dedicated to greatness.
                </p>
              </div>
              <div className="bg-white/[0.02] border border-white/10 p-8 flex flex-col h-full hover:border-white/20 transition-colors">
                <Users className="h-10 w-10 text-lsr-orange mb-6" />
                <h3 className="font-sans font-black text-xl uppercase tracking-widest text-white mb-4">Motorsports Democratization</h3>
                <p className="text-sm text-white/60 leading-relaxed">
                  Since its inception, racing has never been an affordable endeavor; however, the excessive price of entry and enjoyment has fragmented the enthusiast community. Sponsoring LSR reduces the gap between the audience and the track through meaningful volunteering and industry exposure.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* How Partnerships Work */}
        <section className="mb-20 border-t border-b border-white/5 py-12">
          <div className="max-w-4xl mx-auto">
            <h2 className="font-display font-black italic text-2xl text-white uppercase tracking-normal mb-10 text-center">
              How to <span className="text-lsr-orange">sponsor us</span>
            </h2>
            <div className="grid md:grid-cols-4 gap-8 relative">
              <div className="hidden md:block absolute top-4 left-0 w-full h-px bg-white/10 -z-10" />
              
              <div className="relative flex flex-col items-center text-center">
                <div className="w-8 h-8 rounded-full bg-lsr-charcoal border border-lsr-orange text-lsr-orange font-mono font-bold flex items-center justify-center text-sm mb-4 z-10">1</div>
                <h3 className="font-sans font-bold text-xs uppercase tracking-widest text-white mb-2">Conversation</h3>
                <p className="text-[10px] text-white/50 leading-relaxed">We discuss your goals and alignment with our mission.</p>
              </div>

              <div className="relative flex flex-col items-center text-center">
                <div className="w-8 h-8 rounded-full bg-lsr-charcoal border border-white/20 text-white/40 font-mono font-bold flex items-center justify-center text-sm mb-4 z-10">2</div>
                <h3 className="font-sans font-bold text-xs uppercase tracking-widest text-white mb-2">Selection</h3>
                <p className="text-[10px] text-white/50 leading-relaxed">Choose a partnership level.</p>
              </div>

              <div className="relative flex flex-col items-center text-center">
                <div className="w-8 h-8 rounded-full bg-lsr-charcoal border border-white/20 text-white/40 font-mono font-bold flex items-center justify-center text-sm mb-4 z-10">3</div>
                <h3 className="font-sans font-bold text-xs uppercase tracking-widest text-white mb-2">Agreement</h3>
                <p className="text-[10px] text-white/50 leading-relaxed">Tax documentation and formal contract.</p>
              </div>

              <div className="relative flex flex-col items-center text-center">
                <div className="w-8 h-8 rounded-full bg-lsr-charcoal border border-white/20 text-white/40 font-mono font-bold flex items-center justify-center text-sm mb-4 z-10">4</div>
                <h3 className="font-sans font-bold text-xs uppercase tracking-widest text-white mb-2">Engagement</h3>
                <p className="text-[10px] text-white/50 leading-relaxed">Branding integration and sponsorship activation.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Partnership Options */}
        <section id="partnership-options" className="mb-20">
          <div className="text-center mb-12">
            <h2 className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal">
              Sponsorship <span className="text-lsr-orange">Packages</span>
            </h2>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-xs mt-4">Sponsorship at any level includes all items up through that level</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-start">
            
            {/* Friend */}
            <div className="border border-white/10 bg-white/[0.02] p-6 flex flex-col h-full hover:border-white/20 transition-colors">
              <div className="mb-4">
                <h3 className="font-sans font-black text-lg text-white uppercase tracking-tight">Friend of LSR</h3>
                <div className="mt-2 text-xl font-mono text-white/60">$100 – $249</div>
              </div>
              <ul className="space-y-4 mb-8 flex-grow">
                <li className="flex items-start gap-3 text-xs text-white/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-white/20 mt-1.5 shrink-0" />
                  <span>
                    <strong className="block text-white/90">Business “Shout-out” on social media</strong>
                  </span>
                </li>
              </ul>
              <Button asChild variant="outline" className="w-full rounded-none border-white/10 hover:border-white text-white font-bold uppercase tracking-widest text-[10px]">
                <Link href={`mailto:${outreachEmail}?subject=Discussion: Friend Tier`}>Start a Conversation</Link>
              </Button>
            </div>

            {/* Silver */}
            <div className="border border-white/10 bg-white/[0.02] p-6 flex flex-col h-full hover:border-white/20 transition-colors">
              <div className="mb-4">
                <h3 className="font-sans font-black text-lg text-white uppercase tracking-tight">Silver Partner</h3>
                <div className="mt-2 text-xl font-mono text-white/80">$250 – $999</div>
              </div>
              <ul className="space-y-4 mb-8 flex-grow">
                <li className="flex items-start gap-3 text-xs text-white/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-white/40 mt-1.5 shrink-0" />
                  <span>
                    <strong className="block text-white/90">Business name on website sponsorship page</strong>
                  </span>
                </li>
                <li className="flex items-start gap-3 text-xs text-white/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-white/40 mt-1.5 shrink-0" />
                  <span>
                    <strong className="block text-white/90">Business logo on Longhorn Sim Racing’s Livery</strong>
                  </span>
                </li>
              </ul>
              <Button asChild variant="outline" className="w-full rounded-none border-white/10 hover:border-white text-white font-bold uppercase tracking-widest text-[10px]">
                <Link href={`mailto:${outreachEmail}?subject=Discussion: Silver Partner`}>Learn More</Link>
              </Button>
            </div>

            {/* Gold */}
            <div className="border border-white/10 bg-white/[0.02] p-6 flex flex-col h-full hover:border-white/20 transition-colors">
              <div className="mb-4">
                <h3 className="font-sans font-black text-lg text-white uppercase tracking-tight">Gold Partner</h3>
                <div className="mt-2 text-xl font-mono text-white">$1,000 – $4,999</div>
              </div>
              <ul className="space-y-4 mb-8 flex-grow">
                <li className="flex items-start gap-3 text-xs text-white/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-lsr-orange mt-1.5 shrink-0" />
                  <span>
                    <strong className="block text-white/90">Logo (medium-sized) on website’s main page with a clickable link to sponsor</strong>
                  </span>
                </li>
                <li className="flex items-start gap-3 text-xs text-white/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-lsr-orange mt-1.5 shrink-0" />
                  <span>
                    <strong className="block text-white/90">One team shirt</strong>
                  </span>
                </li>
              </ul>
              <Button asChild variant="outline" className="w-full rounded-none border-white/10 hover:border-white text-white font-bold uppercase tracking-widest text-[10px]">
                <Link href={`mailto:${outreachEmail}?subject=Discussion: Gold Partner`}>Discuss This Level</Link>
              </Button>
            </div>

            {/* Platinum */}
            <div className="border border-white/10 bg-white/[0.02] p-6 flex flex-col h-full hover:border-white/20 transition-colors">
              <div className="mb-4">
                <h3 className="font-sans font-black text-lg text-white uppercase tracking-tight">Platinum Partner</h3>
                <div className="mt-2 text-xl font-mono text-white">$5,000+</div>
              </div>
              <ul className="space-y-4 mb-8 flex-grow">
                <li className="flex items-start gap-3 text-xs text-white/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-white/60 mt-1.5 shrink-0" />
                  <span>
                    <strong className="block text-white/90">Logo featured on the team banner displayed at tabling and press events</strong>
                  </span>
                </li>
                <li className="flex items-start gap-3 text-xs text-white/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-white/60 mt-1.5 shrink-0" />
                  <span>
                    <strong className="block text-white/90">Team merchandise package</strong>
                  </span>
                </li>
                <li className="flex items-start gap-3 text-xs text-white/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-white/60 mt-1.5 shrink-0" />
                  <span>
                    <strong className="block text-white/90">Scheduled campus visit with the team</strong>
                  </span>
                </li>
              </ul>
              <Button asChild variant="outline" className="w-full rounded-none border-white/10 hover:border-white text-white font-bold uppercase tracking-widest text-[10px]">
                <Link href={`mailto:${outreachEmail}?subject=Discussion: Platinum Partner`}>Discuss This Level</Link>
              </Button>
            </div>

          </div>
        </section>

        {/* Compare Benefits Table */}
        <section className="mb-20">
          <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal mb-8 text-center">
            Compare <span className="text-lsr-orange">Benefits</span>
          </h3>
          <div className="overflow-x-auto border border-white/10 bg-white/[0.02]">
            <table className="w-full text-left text-xs">
              <thead className="bg-white/5 font-sans font-black text-[10px] uppercase tracking-widest text-white/60">
                <tr>
                  <th className="p-4 w-1/3">Benefit</th>
                  <th className="p-4 text-center w-1/6">Friend</th>
                  <th className="p-4 text-center w-1/6">Silver</th>
                  <th className="p-4 text-center w-1/6">Gold</th>
                  <th className="p-4 text-center w-1/6">Platinum</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-sans text-white/80">
                <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-bold">Tax-Deductible Contribution</td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-bold">Social Media Shout-out</td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-bold">Name on website sponsorship page</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-bold">Logo on Team Livery</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-bold">Website Main Page Logo & Link</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-bold">Team Shirt / Merchandise</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-white">1 Shirt</td>
                  <td className="p-4 text-center text-white">Merch Pkg</td>
                </tr>
                 <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-bold">Team Banner Logo (Events)</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-white">Medium Logo</td>
                  <td className="p-4 text-center text-white">Logo</td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-bold">Scheduled Campus Visit</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-white/20">-</td>
                  <td className="p-4 text-center text-lsr-orange"><Check className="h-4 w-4 mx-auto" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* 501c3 & Logistics */}
        <section className="grid md:grid-cols-2 gap-6 md:gap-12 mb-20">
          <div className="border border-white/10 bg-white/[0.02] p-6 md:p-10 overflow-hidden">
              <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal mb-6 border-b border-white/10 pb-4">
                Tax <span className="text-lsr-orange">Exemption</span>
              </h3>
              <p className="font-sans text-sm text-white/70 mb-6 leading-relaxed">
                W-9 available upon request. All donors will receive a receipt for tax exemption as we are a 501(c)3 nonprofit organization.
              </p>
              <p className="font-sans text-sm text-white/70 mb-6 leading-relaxed italic">
                A partnership with Longhorn Sim Racing provides many business opportunities from helping with the company’s community awareness to raising future employees.
              </p>
              <div className="flex flex-col gap-2">
                <Button asChild variant="outline" className="justify-start w-fit rounded-none border-white/10 hover:border-lsr-orange hover:text-lsr-orange font-bold uppercase tracking-widest text-[10px]">
                  <Link href={`mailto:${outreachEmail}?subject=W-9 Request`}>
                    <Download className="mr-2 h-3 w-3" />
                    Request W-9
                  </Link>
                </Button>
              </div>
          </div>

          <div className="border border-white/10 bg-white/[0.02] p-6 md:p-10 overflow-hidden">
            <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal mb-6 border-b border-white/10 pb-4">
              Deadlines & <span className="text-lsr-orange">Specs</span>
            </h3>
            <div className="space-y-6 font-sans text-sm">
              <div className="flex items-start gap-4">
                <div className="font-bold text-lsr-orange uppercase tracking-widest text-xs min-w-[80px] pt-0.5 shrink-0">July 31st</div>
                <div className="text-white/70">To meet printing deadlines, please pledge by this date.</div>
              </div>
              <div className="flex items-start gap-4">
                <div className="font-bold text-lsr-orange uppercase tracking-widest text-xs min-w-[80px] pt-0.5 shrink-0">Format</div>
                <div className="text-white/70">Logos must be submitted in <span className="text-white font-bold">PNG</span> or <span className="text-white font-bold">JPG</span> format and be a high resolution image.</div>
              </div>
              <div className="flex items-start gap-4">
                <div className="font-bold text-lsr-orange uppercase tracking-widest text-xs min-w-[80px] pt-0.5 shrink-0">Email</div>
                <div className="text-white/70">Submit logos to <span className="text-white font-bold break-all">{outreachEmail}</span>.</div>
              </div>
              <p className="text-[10px] text-white/40 italic">If we can’t work with your logo, we may not be able to include it.</p>
            </div>
          </div>
        </section>

        {/* Final relational CTA */}
        <div className="text-center py-12 border border-white/5 bg-white/[0.01]">
          <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal mb-4">
            To Donate
          </h3>
          <p className="font-sans text-white/60 mb-8 max-w-md mx-auto">
            Please make a donation through Venmo or make a check payable to: <span className="text-white font-bold">Longhorn Sim Racing</span>
          </p>
          <Button asChild className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-black uppercase tracking-[0.2em] text-[10px] h-12 px-8 transition-all">
            <Link href="https://www.paypal.com/qrcodes/venmocs/e3fd69ab-c345-4b53-add6-4f8037a4760d?created=1767404952.8381681&printed=1" target="_blank" rel="noopener noreferrer">Donate via Venmo</Link>
          </Button>
        </div>

      </div>

      {/* Floating Download Button */}
      <div className="fixed bottom-6 right-6 z-50 animate-in fade-in slide-in-from-bottom-4 duration-1000 delay-1000 fill-mode-both">
        <Button asChild className="rounded-full shadow-2xl bg-lsr-orange hover:bg-white text-white hover:text-lsr-charcoal font-black uppercase tracking-widest text-[10px] h-12 px-6 border-2 border-transparent hover:border-lsr-orange transition-all">
          <Link href="/SPONSOR_BENEFITS.pdf" target="_blank" download>
            <Download className="mr-2 h-4 w-4" />
            Download Packet
          </Link>
        </Button>
      </div>
    </main>
  )
}
