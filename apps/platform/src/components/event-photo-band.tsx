import Image from "next/image";

/**
 * An event's photo across the top of a card padded p-6 md:p-8, bleeding to the card's edges.
 * Renders nothing when the event has no photo. The card needs `relative overflow-hidden` (and
 * `group` for the hover zoom).
 */
export function EventPhotoBand({ src, sizes }: { src: string | null; sizes: string }) {
  if (!src) return null;
  return (
    <div className="relative -mx-6 -mt-6 mb-6 h-36 overflow-hidden border-b border-white/10 md:-mx-8 md:-mt-8 md:h-44">
      <Image src={src} alt="" fill sizes={sizes} className="object-cover opacity-75 transition-transform duration-700 group-hover:scale-105" />
      <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal/80 to-transparent" />
    </div>
  );
}
