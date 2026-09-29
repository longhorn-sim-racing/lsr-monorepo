import Link from "next/link"
import SectionReveal from "./SectionReveal"
import { type User } from '@prisma/client';
import Image from "next/image"
import { Trophy } from "lucide-react"
import { cn } from "@/lib/utils"
import { RacingNumber } from "@/components/racing-number"

type DriverWithPoints = User & { allTimePoints: number };

type Props = {
  index: number;
  drivers: DriverWithPoints[];
};

export default function Leaderboard({ index, drivers }: Props) {
  const maxPoints = drivers.length > 0 ? (drivers[0].allTimePoints || 1) : 1;

  return (
    <SectionReveal index={index} className="mx-auto max-w-6xl mt-10 md:mt-14" clipClass="rounded-none">
      <div className="bg-lsr-charcoal border border-white/5 relative overflow-hidden">
        {/* Decorative background element */}
        <div className="absolute top-0 right-0 w-32 h-32 bg-lsr-orange/5 -rotate-45 translate-x-16 -translate-y-16" />
        
        <div className="p-6 md:p-10">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-10">
            <div>
              <h2 className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal">
                Driver <span className="text-lsr-orange">Standings</span>
              </h2>
              <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-2">Current Semester Leaders</p>
            </div>
            <Link href="/drivers" className="group flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-white/60 hover:text-lsr-orange transition-colors">
              Full Standings
              <div className="h-px w-8 bg-white/20 group-hover:bg-lsr-orange group-hover:w-12 transition-all" />
            </Link>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="pb-4 text-left font-sans font-black uppercase tracking-widest text-[10px] text-white/30 px-4">P.</th>
                  <th className="pb-4 text-left font-sans font-black uppercase tracking-widest text-[10px] text-white/30 px-4">Driver</th>
                  <th className="pb-4 text-right font-sans font-black uppercase tracking-widest text-[10px] text-white/30 px-4">Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {drivers.slice(0, 5).map((driver, i) => {
                  const initials = driver.displayName
                    .split(" ")
                    .map((n) => n[0])
                    .slice(0, 2)
                    .join("")
                    .toUpperCase()

                  return (
                    <tr key={driver.id} className="group hover:bg-white/[0.02] transition-colors">
                      <td className="py-5 px-4">
                        <span className={cn(
                          "font-display font-black italic text-2xl md:text-3xl italic leading-none",
                          i < 3 ? "text-lsr-orange" : "text-white/20"
                        )}>
                          {(i + 1).toString().padStart(2, '0')}
                        </span>
                      </td>
                      <td className="py-5 px-4">
                        <Link href={`/drivers/${driver.handle}`} className="flex items-center gap-4 group/driver">
                          <div className="relative h-10 w-10 overflow-hidden bg-white/5 flex-shrink-0 border border-white/10 group-hover/driver:border-lsr-orange transition-colors">
                            {driver.avatarUrl ? (
                              <Image
                                src={driver.avatarUrl}
                                alt=""
                                width={40}
                                height={40}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-xs font-bold text-white/30">
                                {initials || "U"}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-col">
                            <span className="flex items-baseline gap-2">
                              <span className="font-sans font-bold text-white text-base group-hover/driver:text-lsr-orange transition-colors uppercase tracking-[0.1em]">
                                {driver.displayName}
                              </span>
                              <RacingNumber user={driver} size="xs" />
                            </span>
                            <span className="text-[9px] font-bold text-white/30 uppercase tracking-[0.2em]">Active Member</span>
                          </div>
                        </Link>
                      </td>
                      <td className="py-5 px-4 text-right">
                        <div className="inline-flex flex-col items-end">
                          <span className="font-sans font-black text-white text-lg tracking-widest">{driver.allTimePoints}</span>
                          <div className={cn(
                            "h-1 w-full mt-1 bg-white/5 overflow-hidden",
                            i < 3 && "bg-lsr-orange/10"
                          )}>
                            <div 
                              className={cn("h-full", i < 3 ? "bg-lsr-orange" : "bg-white/20")} 
                              style={{ width: `${Math.min((driver.allTimePoints || 0) / maxPoints * 100, 100)}%` }} 
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </SectionReveal>
  )
}