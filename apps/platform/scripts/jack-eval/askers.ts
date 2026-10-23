/**
 * Who asks a question. By default the run's officer (--as, or the first officer or admin); a question's
 * `as` names someone else: an officer's handle or email, the first officer in a department, or a lookup.
 * Paired questions ask the same thing as officers from different departments, and the pair judge checks
 * that the facts in the answers match (design §16).
 */
import type { AskerSpec, EvalContext, Question } from "./shared";

export type Asker = { id: string; displayName: string; handle: string };

const OFFICER = { status: { not: "deleted" as const }, roles: { some: { role: { key: { in: ["officer", "admin"] } } } } };
const SELECT = { id: true, displayName: true, handle: true } as const;

/** How a spec reads in a skip note: "@dylan", "the first media officer", "a lookup" */
export function describeAsker(spec: AskerSpec): string {
  if (typeof spec === "string") return spec.includes("@") && !spec.startsWith("@") ? spec : `@${spec.replace(/^@/, "")}`;
  if (typeof spec === "function") return "the officer its lookup names";
  return `the first ${spec.department} officer`;
}

/** The officer or admin a spec names, or null when there's none (the question is skipped) */
export async function resolveAsker(prisma: EvalContext["prisma"], spec: AskerSpec): Promise<Asker | null> {
  let who: string | null;
  if (typeof spec === "function") who = await spec(prisma);
  else if (typeof spec === "string") who = spec;
  else {
    return prisma.user.findFirst({ where: { ...OFFICER, department: spec.department }, orderBy: { createdAt: "asc" }, select: SELECT });
  }
  if (!who?.trim()) return null;
  const key = who.trim().replace(/^@/, "");
  const match = key.includes("@") ? { email: key.toLowerCase() } : { OR: [{ handle: key.toLowerCase() }, { id: key }] };
  return prisma.user.findFirst({ where: { ...OFFICER, ...match }, select: SELECT });
}

/** The run's officer when --as isn't given: the first officer or admin, by account age */
export function firstOfficer(prisma: EvalContext["prisma"]): Promise<Asker | null> {
  return prisma.user.findFirst({ where: OFFICER, orderBy: { createdAt: "asc" }, select: SELECT });
}

/**
 * The same question asked by each of `askers` (two or more, each with a short label for the id, like
 * "media"): ids `<id>@<label>`, the same `pair`. The pair judge compares their answers: the same facts,
 * numbers and conclusions, and no background no tool gave
 */
export function paired(base: Omit<Question, "as" | "pair">, askers: { label: string; as: AskerSpec }[]): Question[] {
  if (askers.length < 2) throw new Error(`paired("${base.id}") needs at least two askers`);
  const labels = askers.map((a) => a.label);
  if (new Set(labels).size !== labels.length || labels.some((l) => !/^[a-z0-9-]+$/.test(l))) {
    throw new Error(`paired("${base.id}"): labels must be distinct, lowercase letters, digits and dashes`);
  }
  return askers.map(({ label, as }) => ({ ...base, id: `${base.id}@${label}`, as, pair: base.id }));
}
