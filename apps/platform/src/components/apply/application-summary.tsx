import { answerEntries } from "@/lib/recruiting/answers";
import { genericQuestions, questionsForTrack } from "@/schemas/recruiting.schema";
import { teamLabel } from "@/lib/recruiting/steps";
import { SafeLink } from "@/components/recruiting/safe-link";

type Props = {
  profile: { fullName: string | null; email: string | null; eid: string | null; gradYear: number | string | null; major: string | null };
  resumeUrl: string | null;
  genericAnswers: unknown;
  teams: Array<{ key: string; answers: unknown }>;
};

/** Everything the applicant entered, read-only. Used on the review page and on their status page. */
export function ApplicationSummary({ profile, resumeUrl, genericAnswers, teams }: Props) {
  return (
    <div className="space-y-8">
      <Block title="About you">
        <Row label="Name" value={profile.fullName} />
        <Row label="Account email" value={profile.email} />
        <Row label="UT EID" value={profile.eid} />
        <Row label="Graduation year" value={profile.gradYear === null ? null : String(profile.gradYear)} />
        <Row label="Major" value={profile.major} />
      </Block>

      {genericQuestions.length > 0 && (
        <Block title="General questions">
          <Answers entries={answerEntries(genericQuestions, genericAnswers)} />
        </Block>
      )}

      {teams.map((t) => (
        <Block key={t.key} title={teamLabel(t.key)}>
          <Answers entries={answerEntries(questionsForTrack(t.key), t.answers)} emptyText="This team has no extra questions." />
        </Block>
      ))}

      <Block title="Resume">
        <div className="space-y-1">
          <Label>Resume</Label>
          <div className="font-sans text-sm text-white/85">{resumeUrl ? <SafeLink url={resumeUrl} /> : <span className="text-white/30">Not added</span>}</div>
        </div>
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-4 font-display text-lg font-black uppercase italic text-white">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white/45">{children}</div>;
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="font-sans text-sm text-white/85">{value ? value : <span className="text-white/30">Not added</span>}</div>
    </div>
  );
}

function Answers({ entries, emptyText = "No questions." }: { entries: ReturnType<typeof answerEntries>; emptyText?: string }) {
  if (entries.length === 0) return <p className="font-sans text-sm text-white/40">{emptyText}</p>;
  return (
    <>
      {entries.map((e) => (
        <div key={e.id} className="space-y-1">
          <Label>{e.label}</Label>
          <div className="whitespace-pre-wrap font-sans text-sm text-white/85">
            {e.text === "" ? <span className="text-white/30">No answer</span> : e.type === "link" ? <SafeLink url={e.text} /> : e.text}
          </div>
        </div>
      ))}
    </>
  );
}
