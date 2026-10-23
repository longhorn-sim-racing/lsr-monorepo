import { z } from "zod";
import { TEAMS, type TeamId } from "@/app/about/roster";

/**
 * An officer's profile (Jack 2.0, #188, design §3.3): their department (the About page roster's team),
 * whether they hold a board seat, and a short "what I work on" in their own words. Jack matches his
 * vocabulary to it; the facts he gives never change with it. Officers set it on their own profile
 * editor, and admins on Members.
 */

/** The departments, in the roster's order */
export const DEPARTMENTS: { id: TeamId; name: string }[] = TEAMS.map((team) => ({ id: team.id, name: team.name }));

export const WORKING_ON_MAX = 160;

const DEPARTMENT_IDS = TEAMS.map((team) => team.id) as [TeamId, ...TeamId[]];

const blankToNull = (value: unknown) => (typeof value === "string" && !value.trim() ? null : value);

export const officerProfileSchema = z.object({
  department: z.preprocess(blankToNull, z.enum(DEPARTMENT_IDS, { error: "Pick a department from the list." }).nullable()),
  isBoard: z.boolean(),
  // One line: line breaks and runs of spaces become single spaces
  workingOn: z.preprocess(
    (value) => (typeof value === "string" ? blankToNull(value.replace(/\s+/g, " ").trim()) : value),
    z.string().max(WORKING_ON_MAX, `Keep “what I work on” to ${WORKING_ON_MAX} characters.`).nullable(),
  ),
});

export type OfficerProfile = z.infer<typeof officerProfileSchema>;

/** The profile as a form posts it: department, isBoard ("on" when ticked) and workingOn */
export function officerProfileFromForm(formData: FormData): { department: unknown; isBoard: boolean; workingOn: unknown } {
  return { department: formData.get("department"), isBoard: formData.get("isBoard") === "on", workingOn: formData.get("workingOn") };
}

/** "Technology" for "technology"; null for none or an id that isn't a department */
export function departmentName(id: string | null | undefined): string | null {
  return DEPARTMENTS.find((department) => department.id === id)?.name ?? null;
}
