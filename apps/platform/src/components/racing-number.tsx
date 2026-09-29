import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { RacingNumberStyle } from "@/lib/racing-number";

export type { RacingNumberStyle } from "@/lib/racing-number";

export type RacingNumberSize = "xs" | "sm" | "md" | "lg" | "xl";

// The border stroke grows with the type so it keeps roughly the same visual weight.
const SIZES: Record<RacingNumberSize, { text: string; stroke: string }> = {
  xs: { text: "text-sm", stroke: "0.5px" },
  sm: { text: "text-lg", stroke: "1px" },
  md: { text: "text-2xl", stroke: "1px" },
  lg: { text: "text-4xl leading-none", stroke: "1.5px" },
  xl: { text: "text-5xl md:text-7xl leading-none", stroke: "2px" },
};

// Color and font are user-supplied and land in server-rendered style attributes,
// so anything that isn't a plain hex color or font list is dropped.
const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;
const SAFE_FONT = /^[\w\s,-]+$/;

/**
 * A driver's `#N` in their chosen color, font, italic and border. Renders `fallback`
 * when they haven't picked a number. `className` can override the font size.
 */
export function RacingNumber({
  user,
  size = "sm",
  fallback = null,
  className,
}: {
  user: RacingNumberStyle;
  size?: RacingNumberSize;
  fallback?: ReactNode;
  className?: string;
}) {
  const number = user.racingNumber;
  if (number == null) return <>{fallback}</>;

  const { text, stroke } = SIZES[size];
  const color = user.racingNumberColor && SAFE_COLOR.test(user.racingNumberColor) ? user.racingNumberColor : undefined;
  const font = user.racingNumberFont && SAFE_FONT.test(user.racingNumberFont) ? user.racingNumberFont : undefined;

  return (
    <span
      role="img"
      aria-label={`Car number ${number}`}
      className={cn(
        "font-display font-black whitespace-nowrap",
        user.racingNumberItalic ? "italic" : "not-italic",
        text,
        className,
      )}
      style={{
        color,
        fontFamily: font,
        WebkitTextStroke: user.racingNumberBorder ? `${stroke} white` : undefined,
      }}
    >
      {`#${number}`}
    </span>
  );
}
