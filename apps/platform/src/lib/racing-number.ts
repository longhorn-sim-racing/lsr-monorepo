import type { Prisma } from "@prisma/client";

/** A driver's racing number and how it's styled; any User row satisfies it. */
export type RacingNumberStyle = {
  racingNumber?: number | null;
  racingNumberColor?: string | null;
  racingNumberFont?: string | null;
  racingNumberItalic?: boolean | null;
  racingNumberBorder?: boolean | null;
};

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
