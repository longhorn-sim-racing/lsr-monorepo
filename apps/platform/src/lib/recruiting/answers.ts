import type { GenericQuestion } from "@/schemas/recruiting.schema";

/** An answer as plain text, for display and for the CSV. */
export function formatAnswer(question: Pick<GenericQuestion, "type">, value: unknown): string {
  if (value === undefined || value === null) return "";
  switch (question.type) {
    case "multi_choice":
      return Array.isArray(value) ? value.map(String).join("; ") : String(value);
    case "yes_no":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    default:
      return String(value);
  }
}

export type AnswerEntry = {
  id: string;
  label: string;
  type: GenericQuestion["type"] | "unknown";
  text: string;
  /** false for an answer whose question has since been removed from the form */
  known: boolean;
};

/**
 * Every question in order with its answer ("" when unanswered), then any stored answers whose
 * question no longer exists (kept visible so history is never silently hidden).
 */
export function answerEntries(questions: readonly GenericQuestion[], answers: unknown): AnswerEntry[] {
  const record = typeof answers === "object" && answers !== null && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {};
  const entries: AnswerEntry[] = questions.map((q) => ({
    id: q.id,
    label: q.label,
    type: q.type,
    text: formatAnswer(q, record[q.id]),
    known: true,
  }));
  const known = new Set(questions.map((q) => q.id));
  for (const [id, value] of Object.entries(record)) {
    if (known.has(id)) continue;
    entries.push({ id, label: `${id} (question no longer on the form)`, type: "unknown", text: typeof value === "string" ? value : JSON.stringify(value), known: false });
  }
  return entries;
}
