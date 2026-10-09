import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { StatusIndicator } from "@/lib/status-indicators";

/** Compact inline icons with tooltips — for the drivers page and user menu. */
export function StatusIcons({
  indicators,
  size = 12,
}: {
  indicators: StatusIndicator[];
  size?: number;
}) {
  if (indicators.length === 0) return null;

  return (
    <span className="inline-flex items-center gap-1">
      {indicators.map((ind) => {
        const Icon = ind.icon;
        return (
          <Tooltip key={ind.key}>
            <TooltipTrigger asChild>
              <span className={ind.colorClass}>
                <Icon style={{ width: size, height: size }} />
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="bg-lsr-charcoal border-white/10 text-white text-[10px] font-bold uppercase tracking-widest rounded-none px-2 py-1"
            >
              {ind.tooltip}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </span>
  );
}

/** Icons with full text labels — for driver profile hero. */
export function StatusBadges({
  indicators,
}: {
  indicators: StatusIndicator[];
}) {
  if (indicators.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {indicators.map((ind) => {
        const Icon = ind.icon;
        return (
          <span
            key={ind.key}
            className={`inline-flex items-center gap-1.5 border border-white/10 px-2 py-0.5 md:px-3 md:py-1 text-[8px] md:text-[9px] font-sans font-bold uppercase tracking-widest ${ind.colorClass}`}
          >
            <Icon className="w-3 h-3" />
            {ind.label}
          </span>
        );
      })}
    </div>
  );
}
