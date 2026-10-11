import type { AnswerEntry } from "@/lib/recruiting/answers";
import { SafeLink } from "./safe-link";

/** Questions and the applicant's answers. All text is rendered as text (React escapes it). */
export function AnswerList({ entries }: { entries: AnswerEntry[] }) {
  if (entries.length === 0) return <p className="text-xs text-white/40">No questions.</p>;
  return (
    <dl className="space-y-4">
      {entries.map((e) => (
        <div key={e.id}>
          <dt className="text-[11px] uppercase tracking-wider text-white/40">{e.label}</dt>
          <dd className="mt-1 whitespace-pre-wrap text-sm text-white/90">
            {e.text === "" ? <span className="text-white/25">No answer</span> : e.type === "link" ? <SafeLink url={e.text} /> : e.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}
