import { cardClass } from "./apply-styles";

/** The page frame for /apply, /apply/start and /apply/status: heading on the club's charcoal background. */
export function ApplyShell({ kicker, title, children, wide = false }: { kicker: string; title: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-lsr-charcoal text-white">
      <div className="border-b border-white/10 bg-gradient-to-b from-white/[0.04] to-transparent">
        <div className="mx-auto max-w-6xl px-6 pb-8 pt-12 md:px-8 md:pb-12 md:pt-16">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.3em] text-lsr-orange">{kicker}</p>
          <h1 className="mt-3 font-display text-4xl font-black uppercase italic leading-[0.95] md:text-6xl">{title}</h1>
        </div>
      </div>
      <div className={`mx-auto px-6 py-10 md:px-8 md:py-14 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>{children}</div>
    </div>
  );
}

/** A short message with an accent bar, and an optional action underneath. */
export function ApplyNotice({ children, action, tone = "neutral" }: { children: React.ReactNode; action?: React.ReactNode; tone?: "neutral" | "good" | "bad" }) {
  const bar = tone === "good" ? "bg-green-500" : tone === "bad" ? "bg-red-500" : "bg-lsr-orange";
  return (
    <div className={`${cardClass} max-w-2xl space-y-5`}>
      <div className={`absolute left-0 top-0 h-1 w-24 ${bar}`} />
      <div className="font-sans text-base leading-relaxed text-white/75">{children}</div>
      {action}
    </div>
  );
}
