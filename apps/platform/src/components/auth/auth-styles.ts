// Shared by the auth forms and pages. A plain module (no "use client"), so server pages get the strings
// themselves rather than client references.

export const authLabel = "font-sans font-bold text-[11px] uppercase tracking-[0.2em] text-white/55"
// 16px text on phones so iOS doesn't zoom into the field
export const authInput =
  "h-11 rounded-none border-white/15 bg-white/[0.04] text-base text-white placeholder:text-white/30 focus-visible:border-lsr-orange focus-visible:ring-1 focus-visible:ring-lsr-orange md:text-sm"
export const authSubmit =
  "h-12 w-full rounded-none bg-lsr-orange font-sans text-xs font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal"
