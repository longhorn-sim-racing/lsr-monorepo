// src/schemas/league-application.schema.ts
import { z } from 'zod';

export const SIM_EXPERIENCE_OPTIONS = [
  { value: 'NONE', label: 'None yet' },
  { value: 'CASUAL', label: "I've played racing games before" },
  { value: 'SIM_RACER', label: 'I actively play racing games or sims' },
  { value: 'COMPETITIVE', label: 'I have competitive sim racing experience' },
] as const;

export const RACING_EQUIPMENT_OPTIONS = [
  { value: 'WHEEL', label: 'Steering wheel' },
  { value: 'PEDALS', label: 'Pedals' },
  { value: 'CONTROLLER', label: 'Controller' },
  { value: 'KEYBOARD', label: 'Keyboard' },
] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const leagueApplicationSchema = z.object({
  discordUsername: z.string().trim().min(2, 'Enter your Discord username.').max(64),
  experience: z.enum(['NONE', 'CASUAL', 'SIM_RACER', 'COMPETITIVE']),
  equipment: z
    .array(z.enum(['WHEEL', 'PEDALS', 'CONTROLLER', 'KEYBOARD']))
    .min(1, 'Pick at least one.')
    .transform((list) => Array.from(new Set(list))),
  canCommit: z.boolean(),
  utStudent: z.boolean(),
  eid: optionalText(16).transform((v) => v?.toLowerCase()),
  school: optionalText(120),
  notes: optionalText(1000),
});

export type LeagueApplicationInput = z.infer<typeof leagueApplicationSchema>;

export const experienceLabel = (value: string) =>
  SIM_EXPERIENCE_OPTIONS.find((o) => o.value === value)?.label ?? value;

export const equipmentLabel = (value: string) =>
  RACING_EQUIPMENT_OPTIONS.find((o) => o.value === value)?.label ?? value;
