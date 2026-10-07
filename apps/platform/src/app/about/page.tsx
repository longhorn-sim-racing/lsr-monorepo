import Image from "next/image"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "About Us",
  description: "Learn about the mission, vision, and the student team behind Longhorn Sim Racing.",
  alternates: {
    canonical: "/about",
  },
};

export default function AboutPage() {
  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
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

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20 space-y-20">
        
        {/* Purpose & Vision */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-12 items-start">
          <div>
            <h2 className="font-display font-black italic text-3xl md:text-4xl text-white uppercase tracking-normal mb-6">
              Purpose & <span className="text-lsr-orange">Vision</span>
            </h2>
            <div className="h-1 w-20 bg-lsr-orange mb-8" />
            <p className="font-sans text-white/70 text-lg leading-relaxed">
              We are establishing LSR as a premier collegiate motorsport organization at UT Austin and a legitimate member of the Austin motorsports community.
            </p>
          </div>
          <div className="space-y-6">
            <div className="border border-white/10 bg-white/[0.02] p-6 group hover:border-lsr-orange/50 transition-colors">
              <h3 className="font-sans font-bold text-sm uppercase tracking-widest text-white mb-2">Interdisciplinary</h3>
              <p className="font-sans text-white/60 text-sm">
                Creating opportunities across business, engineering, media, and communications.
              </p>
            </div>
            <div className="border border-white/10 bg-white/[0.02] p-6 group hover:border-lsr-orange/50 transition-colors">
              <h3 className="font-sans font-bold text-sm uppercase tracking-widest text-white mb-2">Career Launchpad</h3>
              <p className="font-sans text-white/60 text-sm">
                Building careers in motorsports through networking, internships, and hands-on experience.
              </p>
            </div>
          </div>
        </section>

        {/* Officer Team */}
        <section>
          <h2 className="font-display font-black italic text-3xl md:text-5xl text-white uppercase tracking-normal mb-10 border-b border-white/10 pb-6">
            Officer <span className="text-lsr-orange">Team</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Dylan Foley */}
            <div className="group">
              <div className="relative aspect-[3/4] border border-white/10 bg-black overflow-hidden mb-6">
                <div className="absolute inset-0 bg-white/5 flex items-center justify-center">
                  <span className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/20">Image Pending</span>
                </div>
                {/* Image placeholder - uncomment when available
                <Image src="/images/dylan.jpg" alt="Dylan Foley" fill className="object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                */}
              </div>
              <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal">Dylan Foley</h3>
              <p className="font-sans font-bold text-xs uppercase tracking-[0.2em] text-lsr-orange mb-4">President</p>
              <p className="font-sans text-sm text-white/60 leading-relaxed">
                Leading the strategic vision and organizational growth of LSR. Dedicated to building partnerships and fostering a competitive spirit within the team.
              </p>
            </div>

            {/* Cooper Tomlin */}
            <div className="group">
              <div className="relative aspect-[3/4] border border-white/10 bg-black overflow-hidden mb-6">
                <div className="absolute inset-0 bg-white/5 flex items-center justify-center">
                  <span className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/20">Image Pending</span>
                </div>
                {/* Image placeholder - uncomment when available
                <Image src="/images/cooper.jpg" alt="Cooper Tomlin" fill className="object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                */}
              </div>
              <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal">Cooper Tomlin</h3>
              <p className="font-sans font-bold text-xs uppercase tracking-[0.2em] text-lsr-orange mb-4">Chief Financial Officer</p>
              <p className="font-sans text-sm text-white/60 leading-relaxed">
                Managing financial operations and sponsorship acquisitions. Focused on ensuring sustainable growth and resource allocation for all team initiatives.
              </p>
            </div>

            {/* Gray Marshall */}
            <div className="group">
              <div className="relative aspect-[3/4] border border-white/10 bg-black overflow-hidden mb-6">
                <div className="absolute inset-0 bg-white/5 flex items-center justify-center">
                  <span className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/20">Image Pending</span>
                </div>
                {/* Image placeholder - uncomment when available
                <Image src="/images/gray.jpg" alt="Gray Marshall" fill className="object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                */}
              </div>
              <h3 className="font-display font-black italic text-2xl text-white uppercase tracking-normal">Gray Marshall</h3>
              <p className="font-sans font-bold text-xs uppercase tracking-[0.2em] text-lsr-orange mb-4">Chief Technology Officer</p>
              <p className="font-sans text-sm text-white/60 leading-relaxed">
                Overseeing technical infrastructure and digital presence. Driving innovation in simulation hardware and software integration for the team.
              </p>
            </div>
          </div>

          {/* Full Team Table */}
          <div className="mt-20 border border-white/10 bg-white/[0.02]">
            <div className="bg-white/5 p-4 border-b border-white/10">
              <h3 className="font-sans font-black text-[10px] uppercase tracking-[0.3em] text-white/40">Full Leadership Roster</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left font-sans text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-[9px] uppercase tracking-widest text-white/20 font-black">
                    <th className="p-4 px-6">Officer</th>
                    <th className="p-4 px-6">Departmental Role</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {[
                    { name: "Dylan Foley", role: "President" },
                    { name: "Cooper Tomlin", role: "Chief Financial Officer" },
                    { name: "Gray Marshall", role: "Chief Technology Officer" },
                    { name: "Grant Ruhland", role: "Director of Community" },
                    { name: "Alexis Voisin", role: "Director of External Affairs" },
                    { name: "Bryan Reyes", role: "Head of Competition" },
                    { name: "Jaylon Collins", role: "Head of Recruitment" },
                    { name: "Armando Martinez", role: "Competition Lead" },
                    { name: "Constanza Jongkind", role: "Media Engineer" },
                    { name: "George Lawrence", role: "Community Lead" },
                    { name: "Anya Shevaun Rodricks", role: "Community Lead" },
                    { name: "Diane Chagoya", role: "Graphic Designer" },
                    { name: "Tina Choi", role: "Brand Designer" },
                    { name: "Chingiz Asgarli", role: "Photographer / Videographer" },
                    { name: "Leisha Jhamnani", role: "Photographer / Videographer" },
                    { name: "Anuja Manjrekar", role: "Photographer / Videographer" },
                    { name: "Harshika Mandula", role: "Photographer / Videographer" },
                    { name: "Boen Kelly", role: "Business Associate" },
                  ].map((officer, i) => (
                    <tr key={i} className="hover:bg-white/[0.02] transition-colors group">
                      <td className="p-4 px-6 font-bold text-white group-hover:text-lsr-orange transition-colors uppercase tracking-tight">{officer.name}</td>
                      <td className="p-4 px-6 text-white/40 font-medium uppercase text-[10px] tracking-widest">{officer.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Strategy */}
        <section className="border border-white/10 bg-white/[0.02] p-8 md:p-12 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-lsr-orange/5 rounded-full blur-[100px] pointer-events-none" />
          
          <h2 className="font-display font-black italic text-3xl md:text-4xl text-white uppercase tracking-normal mb-8 relative z-10">
            Collaboration <span className="text-lsr-orange">Strategy</span>
          </h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 relative z-10">
            <div>
              <p className="font-sans font-bold text-xs uppercase tracking-[0.2em] text-white/40 mb-4">Partner Organizations</p>
              <ul className="space-y-3 font-sans text-white/80 font-bold">
                <li className="flex items-center gap-3">
                  <span className="h-1.5 w-1.5 bg-lsr-orange rounded-full" />
                  Longhorn Racing (LHR)
                </li>
                <li className="flex items-center gap-3">
                  <span className="h-1.5 w-1.5 bg-lsr-orange rounded-full" />
                  Longhorn Car Club (LCC)
                </li>
                <li className="flex items-center gap-3">
                  <span className="h-1.5 w-1.5 bg-lsr-orange rounded-full" />
                  Longhorn Lemons / Orange Dames
                </li>
                <li className="flex items-center gap-3">
                  <span className="h-1.5 w-1.5 bg-lsr-orange rounded-full" />
                  Longhorn Baja (LBR)
                </li>
              </ul>
            </div>
            <div>
              <p className="font-sans font-bold text-xs uppercase tracking-[0.2em] text-white/40 mb-4">Joint Initiatives</p>
              <div className="space-y-4">
                <div className="flex gap-4">
                  <div className="font-display font-black italic text-2xl text-white/20">01</div>
                  <div>
                    <h4 className="font-sans font-bold text-white text-sm uppercase tracking-wide">Shared Events</h4>
                    <p className="font-sans text-white/60 text-xs mt-1">Collaborative race weekends and community gatherings.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="font-display font-black italic text-2xl text-white/20">02</div>
                  <div>
                    <h4 className="font-sans font-bold text-white text-sm uppercase tracking-wide">Cross-Disciplinary</h4>
                    <p className="font-sans text-white/60 text-xs mt-1">Engineering and business projects spanning multiple teams.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="font-display font-black italic text-2xl text-white/20">03</div>
                  <div>
                    <h4 className="font-sans font-bold text-white text-sm uppercase tracking-wide">Outreach</h4>
                    <p className="font-sans text-white/60 text-xs mt-1">Unified campaigns to grow the campus motorsport culture.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Roadmap */}
        <section>
          <div className="flex items-end justify-between mb-10 border-b border-white/10 pb-6">
            <h2 className="font-display font-black italic text-3xl md:text-5xl text-white uppercase tracking-normal">
              Development <span className="text-lsr-orange">Phases</span>
            </h2>
            <span className="hidden md:block font-sans font-bold text-xs uppercase tracking-[0.2em] text-white/40">2025 — 2027+</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Phase 1 */}
            <div className="border border-white/10 bg-lsr-charcoal p-6 group hover:border-lsr-orange transition-colors">
              <div className="flex justify-between items-start mb-6">
                <span className="font-display font-black italic text-4xl text-white/10 group-hover:text-lsr-orange/20 transition-colors">01</span>
                <span className="font-sans font-bold text-[9px] uppercase tracking-widest text-lsr-orange border border-lsr-orange/30 px-2 py-1">Current Phase</span>
              </div>
              <h3 className="font-sans font-black text-xl text-white uppercase tracking-tight mb-2">Foundation</h3>
              <p className="font-sans font-bold text-xs text-white/40 uppercase tracking-widest mb-6">Fall 2025 – Spring 2026</p>
              <ul className="space-y-3">
                <li className="text-sm text-white/70 font-sans leading-snug">• Secure campus facility space</li>
                <li className="text-sm text-white/70 font-sans leading-snug">• Install initial simulator fleet</li>
                <li className="text-sm text-white/70 font-sans leading-snug">• Launch media & engineering teams</li>
                <li className="text-sm text-white/70 font-sans leading-snug">• Host industry partner events</li>
              </ul>
            </div>

            {/* Phase 2 */}
            <div className="border border-white/10 bg-lsr-charcoal p-6 group hover:border-white/30 transition-colors">
              <div className="flex justify-between items-start mb-6">
                <span className="font-display font-black italic text-4xl text-white/10 group-hover:text-white/20 transition-colors">02</span>
              </div>
              <h3 className="font-sans font-black text-xl text-white uppercase tracking-tight mb-2">Expansion</h3>
              <p className="font-sans font-bold text-xs text-white/40 uppercase tracking-widest mb-6">2026 – 2027</p>
              <ul className="space-y-3">
                <li className="text-sm text-white/70 font-sans leading-snug">• Expand simulator capacity</li>
                <li className="text-sm text-white/70 font-sans leading-snug">• Formalize mentorship pipelines</li>
                <li className="text-sm text-white/70 font-sans leading-snug">• Enter competitive leagues</li>
                <li className="text-sm text-white/70 font-sans leading-snug">• WRL Entry Target (Dec 2026)</li>
              </ul>
            </div>

            {/* Phase 3 */}
            <div className="border border-white/10 bg-lsr-charcoal p-6 group hover:border-white/30 transition-colors">
              <div className="flex justify-between items-start mb-6">
                <span className="font-display font-black italic text-4xl text-white/10 group-hover:text-white/20 transition-colors">03</span>
              </div>
              <h3 className="font-sans font-black text-xl text-white uppercase tracking-tight mb-2">Legacy</h3>
              <p className="font-sans font-bold text-xs text-white/40 uppercase tracking-widest mb-6">2027 Onward</p>
              <ul className="space-y-3">
                <li className="text-sm text-white/70 font-sans leading-snug">• Sustain sponsorship ecosystem</li>
                <li className="text-sm text-white/70 font-sans leading-snug">• Strong alumni engagement</li>
                <li className="text-sm text-white/70 font-sans leading-snug">• National collegiate recognition</li>
              </ul>
            </div>
          </div>
        </section>

      </div>
    </main>
  )
}
