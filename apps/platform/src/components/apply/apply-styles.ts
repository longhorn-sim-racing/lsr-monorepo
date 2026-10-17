// Shared class strings for the applicant pages. A plain module (no "use client") so server pages get the strings themselves.

export const labelClass = "font-sans font-bold text-[11px] text-white/55 uppercase tracking-[0.2em]";
// 16px text on phones so iOS doesn't zoom into the field
export const inputClass =
  "h-12 rounded-none border-white/15 bg-white/[0.04] text-base text-white placeholder:text-white/30 focus-visible:border-lsr-orange focus-visible:ring-1 focus-visible:ring-lsr-orange md:text-sm";
export const textareaClass =
  "rounded-none border-white/15 bg-white/[0.04] text-base text-white placeholder:text-white/30 focus-visible:border-lsr-orange focus-visible:ring-1 focus-visible:ring-lsr-orange md:text-sm";
export const choiceClass =
  "flex cursor-pointer items-center gap-3 border border-white/10 bg-white/[0.02] px-4 py-3.5 text-sm text-white/80 transition-colors hover:border-white/25 has-[:checked]:border-lsr-orange has-[:checked]:bg-lsr-orange/[0.06] has-[[data-state=checked]]:border-lsr-orange has-[[data-state=checked]]:bg-lsr-orange/[0.06]";
export const primaryButton =
  "h-12 rounded-none bg-lsr-orange px-6 font-sans text-xs font-bold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-lsr-charcoal disabled:opacity-50";
export const ghostButton =
  "h-12 rounded-none border border-white/20 bg-transparent px-6 font-sans text-xs font-bold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-lsr-charcoal";
export const errorClass = "font-sans text-xs text-red-300";
export const cardClass = "relative border border-white/10 bg-white/[0.02] p-5 md:p-7";
