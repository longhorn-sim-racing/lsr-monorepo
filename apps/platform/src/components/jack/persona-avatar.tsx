import Image from "next/image"
import { cn } from "@/lib/utils"
import { JACK_PERSONA_AVATAR, type JackPersonaKey } from "@/lib/jack/types"

/** Jack's, Lift's or Stand's picture. Decorative: the name is always shown beside it. */
export function PersonaAvatar({ persona, className }: { persona: JackPersonaKey; className?: string }) {
  return <Image src={JACK_PERSONA_AVATAR[persona]} alt="" width={64} height={64} className={cn("size-7 shrink-0 rounded-md border bg-white object-contain", className)} />
}
