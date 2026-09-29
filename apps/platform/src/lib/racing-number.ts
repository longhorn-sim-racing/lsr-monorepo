import type { Prisma } from "@prisma/client";

/** A driver's racing number and how it's styled; any User row satisfies it. */
export type RacingNumberStyle = {
  racingNumber?: number | null;
  racingNumberColor?: string | null;
  racingNumberFont?: string | null;
  racingNumberItalic?: boolean | null;
  racingNumberBorder?: boolean | null;
};

/** The fonts a driver can pick for their number (value is the CSS font-family). */
export const RACING_NUMBER_FONTS = [
  { value: "sans-serif", label: "Sans Serif" },
  { value: "serif", label: "Serif" },
  { value: "monospace", label: "Monospace" },
  { value: "Impact, sans-serif", label: "Impact" },
  { value: "Arial Black, sans-serif", label: "Arial Black" },
  { value: "Trebuchet MS, sans-serif", label: "Trebuchet" },
  { value: "Verdana, sans-serif", label: "Verdana" },
] as const;

export const RACING_NUMBER_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Spread into a Prisma user `select` to load everything `<RacingNumber>` needs. */
export const racingNumberSelect = {
  racingNumber: true,
  racingNumberColor: true,
  racingNumberFont: true,
  racingNumberItalic: true,
  racingNumberBorder: true,
} satisfies Prisma.UserSelect;

/** Copies just the racing number fields off a user, for flattening into rows. */
export function pickRacingNumberStyle(user: RacingNumberStyle | null | undefined): RacingNumberStyle {
  return {
    racingNumber: user?.racingNumber ?? null,
    racingNumberColor: user?.racingNumberColor ?? null,
    racingNumberFont: user?.racingNumberFont ?? null,
    racingNumberItalic: user?.racingNumberItalic ?? null,
    racingNumberBorder: user?.racingNumberBorder ?? null,
  };
}
