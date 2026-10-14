import type { AnswerEntry } from "@/lib/recruiting/answers";
import { SafeLink } from "./safe-link";

/** Questions and the applicant's answers. All text is rendered as text (React escapes it). */
export function AnswerList({ entries }: { entries: AnswerEntry[] }) {
  if (entries.length === 0) return <p className="text-xs text-admin-subtle">No questions.</p>;
  return (
    <dl className="space-y-4">
      {entries.map((e) => (
        <div key={e.id}>
          <dt className="text-xs font-semibold text-muted-foreground">{e.label}</dt>
          <dd className="mt-1 whitespace-pre-wrap text-[13px] text-foreground">
            {e.text === "" ? <span className="text-admin-subtle">No answer</span> : e.type === "link" ? <SafeLink url={e.text} tone="admin" /> : e.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}
