"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveProgressAction, setTeamsAction, submitApplicationAction } from "@/app/apply/actions";
import { formatCentral } from "@/lib/recruiting/labels";
import {
  buildSteps,
  nextStepKey,
  patchForStep,
  prevStepKey,
  questionsForStep,
  resolveStep,
  stepCompletion,
  teamLabel,
  type FormState,
  type StepKey,
} from "@/lib/recruiting/steps";
import { RECRUITING_LIMITS, isBlank, parseAnswers, type CompletenessReport } from "@/schemas/recruiting.schema";
import { cn } from "@/lib/utils";
import { ApplyNotice } from "./apply-shell";
import { ApplicationSummary } from "./application-summary";
import { QuestionField } from "./question-field";
import { cardClass, errorClass, ghostButton, inputClass, labelClass, primaryButton } from "./apply-styles";

type TeamDef = { key: string; label: string; blurb: string; interviewRequired: boolean };

type Props = {
  initial: FormState;
  /** The page the applicant last saved, so the form reopens there */
  initialStep: string | null;
  accountEmail: string;
  round: { id: string; name: string; closesAt: string };
  teams: TeamDef[];
};

/** Codes that mean "this application can't be changed any more", not "fix a field". */
const LOCKED_CODES = ["ROUND_CLOSED", "ROUND_NOT_OPEN_YET", "ALREADY_SUBMITTED", "CLOSED", "ROUND_CHANGED"];

/** Server field errors are keyed by path; the page keys question errors by question id. */
function normalizeFieldErrors(fieldErrors: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(fieldErrors ?? {})) {
    const m = key.match(/^genericAnswers\.(.+)$/) ?? key.match(/^trackAnswers\.[^.]+\.(.+)$/);
    out[m ? m[1] : key] = message;
  }
  return out;
}

/** Problems with the answers on this page that can be caught before asking the server (length, options). */
function questionErrors(step: StepKey, state: FormState): Record<string, string> {
  const questions = questionsForStep(step);
  if (questions.length === 0) return {};
  const answers = step === "general" ? state.genericAnswers : (state.trackAnswers[step.slice(5)] ?? {});
  // Answers to questions that were removed since they were saved aren't the applicant's to fix
  return parseAnswers(questions, answers, "draft", { ignoreUnknown: true }).errors;
}

/** Field-error keys the page has somewhere to show: this page's questions, profile fields, the resume link. */
function keysShownOn(step: StepKey): Set<string> {
  const keys = new Set(questionsForStep(step).map((q) => q.id));
  return keys;
}

/** The problems a page can't show next to a field (a team's page that isn't part of the application, say), for the banner. */
function unmatchedMessages(step: StepKey, fields: Record<string, string>): string[] {
  const shown = keysShownOn(step);
  return Object.entries(fields)
    .filter(([key]) => !shown.has(key) && !key.startsWith("profile.") && key !== "resumeUrl" && key !== "tracks")
    .map(([, message]) => message);
}

export function ApplyForm({ initial, initialStep, accountEmail, round, teams }: Props) {
  const router = useRouter();
  const [state, setState] = useState<FormState>(initial);
  const [lastSaved, setLastSaved] = useState(() => JSON.stringify(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [serverReport, setServerReport] = useState<CompletenessReport | null>(null);
  const [locked, setLocked] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const heading = useRef<HTMLHeadingElement>(null);

  const steps = useMemo(() => buildSteps(state.teams), [state.teams]);
  // The page lives in the URL (?step=), so the browser's Back and the phone's back gesture move
  // between pages instead of leaving the form. The first visit opens where the applicant left off.
  const stepParam = useSearchParams().get("step");
  const stepKey = resolveStep(stepParam ?? initialStep, steps);
  const completion = useMemo(() => stepCompletion(state, accountEmail), [state, accountEmail]);
  const dirty = JSON.stringify(state) !== lastSaved;
  const index = Math.max(0, steps.findIndex((s) => s.key === stepKey));

  // Typed but unsaved changes: warn before the tab closes
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Give the first page an address of its own, so Back from page two lands here and not on a different page
  useEffect(() => {
    if (stepParam === null) window.history.replaceState(null, "", `?step=${encodeURIComponent(stepKey)}`);
    // Only on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save the current page a moment after the applicant stops typing, so leaving the form any way
  // at all (the back gesture on a phone, a closed tab) loses at most a few seconds of typing.
  // Pages with problems are left for "Save and continue" to explain.
  useEffect(() => {
    if (!dirty || pending || locked || stepKey === "review" || stepKey === "teams") return;
    const built = patchForStep(stepKey, state);
    if (!built.ok || Object.keys(questionErrors(stepKey, state)).length > 0) return;
    const snapshot = JSON.stringify(state);
    const timer = setTimeout(async () => {
      const res = await saveProgressAction(round.id, built.patch);
      if (res.ok) {
        setLastSaved(snapshot);
        setSavedAt(res.data.savedAt);
      } else if (res.code && LOCKED_CODES.includes(res.code)) setLocked(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, [state, dirty, pending, locked, stepKey, round.id]);

  // Back (or the back gesture) can move to another page while the one just left has unsaved typing:
  // save that page now. "Save and continue" saves before it moves, so it never has anything left to save here.
  const latest = useRef({ state, dirty });
  useEffect(() => {
    latest.current = { state, dirty };
  });
  const shownStep = useRef(stepKey);
  useEffect(() => {
    const left = shownStep.current;
    shownStep.current = stepKey;
    const { state: current, dirty: unsaved } = latest.current;
    if (left === stepKey || !unsaved || left === "review" || left === "teams") return;
    const built = patchForStep(left, current);
    if (!built.ok || Object.keys(questionErrors(left, current)).length > 0) return;
    const snapshot = JSON.stringify(current);
    void saveProgressAction(round.id, built.patch).then((res) => {
      if (res.ok) {
        setLastSaved(snapshot);
        setSavedAt(res.data.savedAt);
      }
    });
  }, [stepKey, round.id]);

  // Move focus to the new page's heading so keyboard and screen-reader users land in the right place
  useEffect(() => {
    heading.current?.focus();
  }, [stepKey]);

  const set = (patch: Partial<FormState>) => setState((s) => ({ ...s, ...patch }));
  const setProfile = (patch: Partial<FormState["profile"]>) => setState((s) => ({ ...s, profile: { ...s.profile, ...patch } }));

  function failed(res: { error: string; fieldErrors?: Record<string, string>; code?: string; report?: CompletenessReport }): false {
    if (res.code && LOCKED_CODES.includes(res.code)) setLocked(true);
    else if (res.code === "UNAUTHENTICATED") setBanner("Your session ended. Sign in again, then come back; your saved progress is kept.");
    else {
      const fields = normalizeFieldErrors(res.fieldErrors);
      setErrors(fields);
      const loose = unmatchedMessages(stepKey, fields);
      if (loose.length > 0) setBanner(`${res.error} ${loose.join(" ")}`);
      else setBanner(Object.keys(fields).length > 0 ? "Some answers need attention (see below)." : res.error);
    }
    if (res.report) setServerReport(res.report);
    return false;
  }

  /** Saves this page. True when it is saved (or there is nothing to save). */
  async function saveCurrent(): Promise<boolean> {
    setBanner(null);
    if (stepKey === "review") return true;
    const caught = questionErrors(stepKey, state);
    if (Object.keys(caught).length > 0) {
      setErrors(caught);
      setBanner("Some answers need attention (see below).");
      return false;
    }
    const built = patchForStep(stepKey, state);
    if (!built.ok) {
      setErrors(built.errors);
      setBanner("Some answers need attention (see below).");
      return false;
    }
    if (stepKey === "teams") {
      const teamsResult = await setTeamsAction(round.id, state.teams);
      if (!teamsResult.ok) return failed(teamsResult);
    }
    const res = await saveProgressAction(round.id, built.patch);
    if (!res.ok) return failed(res);
    setLastSaved(JSON.stringify(state));
    setSavedAt(res.data.savedAt);
    setErrors({});
    return true;
  }

  function goTo(target: StepKey) {
    startTransition(async () => {
      if (dirty && !(await saveCurrent())) return;
      setErrors({});
      setBanner(null);
      window.history.pushState(null, "", `?step=${encodeURIComponent(target)}`);
      window.scrollTo({ top: 0 });
    });
  }

  function saveAndExit() {
    startTransition(async () => {
      if (dirty && !(await saveCurrent())) return;
      router.push("/apply");
    });
  }

  function submit() {
    startTransition(async () => {
      setBanner(null);
      const res = await submitApplicationAction(round.id);
      if (res.ok) {
        router.replace("/apply/status?submitted=1");
        router.refresh();
        return;
      }
      if (res.code === "INCOMPLETE") {
        setServerReport(res.report ?? null);
        setBanner("Your application isn't complete yet. Fix the pages marked below.");
        return;
      }
      failed(res);
    });
  }

  function toggleTeam(key: string) {
    if (state.teams.includes(key)) {
      const answered = Object.values(state.trackAnswers[key] ?? {}).some((v) => !isBlank(v));
      if (answered) return setRemoving(key);
      return setState((s) => ({ ...s, teams: s.teams.filter((t) => t !== key) }));
    }
    setState((s) => (s.teams.includes(key) ? s : { ...s, teams: [...s.teams, key] }));
  }

  function confirmRemoveTeam() {
    if (!removing) return;
    const key = removing;
    setState((s) => {
      const { [key]: _dropped, ...rest } = s.trackAnswers;
      void _dropped;
      return { ...s, teams: s.teams.filter((t) => t !== key), trackAnswers: rest };
    });
    setRemoving(null);
  }

  if (locked) {
    return (
      <ApplyNotice
        tone="bad"
        action={
          <Button asChild className={primaryButton}>
            <Link href="/apply/status">See my application</Link>
          </Button>
        }
      >
        This application can&apos;t be changed any more: the round has closed or it has already been submitted. Everything you saved before then is kept.
      </ApplyNotice>
    );
  }

  const stepLabel = steps[index]?.label ?? "";
  const prev = prevStepKey(steps, stepKey);
  const next = nextStepKey(steps, stepKey);

  return (
    <div className="grid gap-8 lg:grid-cols-[16rem_1fr]">
      <nav aria-label="Application steps" className="lg:sticky lg:top-24 lg:self-start">
        <p className="mb-3 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white/45 lg:hidden">
          Step {index + 1} of {steps.length}: {stepLabel}
        </p>
        <div className="mb-4 h-1 bg-white/10 lg:hidden">
          <div className="h-1 bg-lsr-orange transition-all" style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
        </div>
        <ol className="hidden space-y-1 lg:block">
          {steps.map((s, i) => {
            const done = completion.byStep[s.key]?.complete;
            const current = s.key === stepKey;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => !current && goTo(s.key)}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 border-l-2 px-3 py-2.5 text-left font-sans text-sm transition-colors",
                    current ? "border-lsr-orange bg-white/[0.05] text-white" : "border-white/10 text-white/60 hover:border-white/30 hover:text-white",
                  )}
                >
                  {done ? <Check className="h-4 w-4 shrink-0 text-green-400" aria-label="Complete" /> : <Circle className="h-4 w-4 shrink-0 text-white/25" aria-label="Not complete yet" />}
                  <span className="min-w-0 truncate">
                    <span className="mr-2 text-white/35">{i + 1}</span>
                    {s.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="min-w-0 space-y-5">
        <p className="border border-white/10 bg-white/[0.02] px-4 py-3 font-sans text-xs leading-relaxed text-white/60">
          <strong className="text-white/80">{round.name} closes {formatCentral(round.closesAt)}.</strong> Your progress is saved each time you continue. If your application is complete but you haven&apos;t pressed Submit by the deadline, we submit it for you; an unfinished one is not submitted.
        </p>

        <section className={cardClass} aria-labelledby="step-heading">
          <div className="absolute left-0 top-0 h-1 w-16 bg-lsr-orange" />
          <h2 id="step-heading" ref={heading} tabIndex={-1} className="font-display text-2xl font-black uppercase italic text-white outline-none">
            {stepLabel}
          </h2>

          {banner && (
            <p role="alert" className="mt-5 border border-red-500/30 bg-red-500/10 px-4 py-3 font-sans text-sm text-red-200">
              {banner}
            </p>
          )}

          {/* Nothing can be typed while a save is in flight: an edit made then would be left behind by the page moving on */}
          <fieldset disabled={pending} className="mt-6 min-w-0 space-y-6 border-0 p-0">
            {stepKey === "about" && <AboutStep state={state} accountEmail={accountEmail} setProfile={setProfile} errors={errors} />}
            {(stepKey === "general" || stepKey.startsWith("team:")) && (
              <QuestionsStep
                step={stepKey}
                team={stepKey.startsWith("team:") ? teams.find((t) => t.key === stepKey.slice(5)) : undefined}
                state={state}
                setState={setState}
                errors={errors}
              />
            )}
            {stepKey === "teams" && <TeamsStep teams={teams} selected={state.teams} onToggle={toggleTeam} />}
            {stepKey === "links" && <LinksStep state={state} set={set} errors={errors} />}
            {stepKey === "review" && (
              <ReviewStep
                state={state}
                accountEmail={accountEmail}
                steps={steps}
                completion={completion}
                serverReport={serverReport}
                pending={pending}
                onFix={goTo}
                onSubmit={submit}
              />
            )}
          </fieldset>

          {stepKey !== "review" && (
            <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-white/10 pt-6">
              {prev && (
                <Button type="button" disabled={pending} onClick={() => goTo(prev)} className={ghostButton}>
                  Back
                </Button>
              )}
              <Button
                type="button"
                disabled={pending || (stepKey === "teams" && state.teams.length === 0)}
                onClick={() => next && goTo(next)}
                className={primaryButton}
              >
                {pending ? "Saving..." : next === "review" ? "Save and review" : "Save and continue"}
              </Button>
              <button type="button" disabled={pending} onClick={saveAndExit} className="font-sans text-xs font-bold uppercase tracking-widest text-white/50 underline-offset-4 hover:text-lsr-orange hover:underline">
                Save and finish later
              </button>
              {stepKey === "teams" && state.teams.length === 0 && <p className="w-full font-sans text-xs text-white/50">Choose at least one team to continue.</p>}
              {savedAt && !dirty && <p className="ml-auto font-sans text-xs text-green-400/80" role="status">Saved {new Date(savedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</p>}
            </div>
          )}
          {stepKey === "review" && prev && (
            <div className="mt-6 border-t border-white/10 pt-6">
              <Button type="button" disabled={pending} onClick={() => goTo(prev)} className={ghostButton}>
                Back
              </Button>
            </div>
          )}
        </section>
      </div>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent className="max-w-md rounded-none border-white/10 bg-lsr-charcoal text-white">
          <DialogHeader>
            <DialogTitle className="font-display text-xl font-black uppercase italic">Remove {removing ? teamLabel(removing) : "this team"}?</DialogTitle>
            <DialogDescription className="text-white/60">
              You have already answered this team&apos;s questions. If you remove the team, those answers are deleted when you continue. You can choose the team again later, but you will need to answer them again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setRemoving(null)} className="text-white/60">Keep the team</Button>
            <Button onClick={confirmRemoveTeam} className="rounded-none bg-red-500 text-white hover:bg-red-400">Remove it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function AboutStep({ state, accountEmail, setProfile, errors }: { state: FormState; accountEmail: string; setProfile: (p: Partial<FormState["profile"]>) => void; errors: Record<string, string> }) {
  const field = (id: "fullName" | "eid" | "gradYear" | "major", label: string, props: { placeholder: string; maxLength: number; inputMode?: "numeric" }) => (
    <div className="space-y-2">
      <Label htmlFor={`profile-${id}`} className={labelClass}>{label}</Label>
      <Input
        id={`profile-${id}`}
        value={state.profile[id]}
        onChange={(e) => setProfile({ [id]: e.target.value })}
        aria-invalid={errors[`profile.${id}`] ? true : undefined}
        className={inputClass}
        {...props}
      />
      {errors[`profile.${id}`] && <p role="alert" className={errorClass}>{errors[`profile.${id}`]}</p>}
    </div>
  );
  return (
    <>
      <p className="font-sans text-sm leading-relaxed text-white/60">We filled in what we know from your account. Check it, and fix anything that is wrong.</p>
      <div className="space-y-2">
        <span className={labelClass}>Email</span>
        <p className="border border-white/10 bg-white/[0.02] px-4 py-3 font-sans text-sm text-white/80">{accountEmail}</p>
        <p className="font-sans text-xs text-white/45">Every message about your application goes to this address. To change it, change your account email.</p>
      </div>
      {field("fullName", "Full name", { placeholder: "Your name", maxLength: 120 })}
      {field("eid", "UT EID", { placeholder: "abc123", maxLength: 16 })}
      {field("gradYear", "Graduation year", { placeholder: "2028", maxLength: 4, inputMode: "numeric" })}
      {field("major", "Major", { placeholder: "Your major", maxLength: 120 })}
    </>
  );
}

function QuestionsStep({
  step,
  team,
  state,
  setState,
  errors,
}: {
  step: StepKey;
  team?: TeamDef;
  state: FormState;
  setState: React.Dispatch<React.SetStateAction<FormState>>;
  errors: Record<string, string>;
}) {
  const questions = questionsForStep(step);
  const answers = step === "general" ? state.genericAnswers : (state.trackAnswers[step.slice(5)] ?? {});
  const change = (id: string, value: unknown) =>
    setState((s) =>
      step === "general"
        ? { ...s, genericAnswers: { ...s.genericAnswers, [id]: value } }
        : { ...s, trackAnswers: { ...s.trackAnswers, [step.slice(5)]: { ...(s.trackAnswers[step.slice(5)] ?? {}), [id]: value } } },
    );

  return (
    <>
      {team && (
        <div className="border border-white/10 bg-white/[0.03] px-4 py-3 font-sans text-sm text-white/65">
          {team.blurb}{" "}
          <span className={team.interviewRequired ? "text-sky-300" : "text-white/45"}>{team.interviewRequired ? "This team interviews applicants." : "This team does not interview."}</span>
        </div>
      )}
      {questions.length === 0 ? (
        <p className="font-sans text-sm text-white/60">{team ? `${team.label} has no extra questions. Continue when you are ready.` : "No questions on this page."}</p>
      ) : (
        questions.map((q) => <QuestionField key={q.id} question={q} value={answers[q.id]} onChange={(v) => change(q.id, v)} error={errors[q.id]} />)
      )}
    </>
  );
}

function TeamsStep({ teams, selected, onToggle }: { teams: TeamDef[]; selected: string[]; onToggle: (key: string) => void }) {
  return (
    <>
      <p className="font-sans text-sm leading-relaxed text-white/60">
        Pick every team you want to apply to. Each one gets its own page of questions, and they are all submitted together as one application.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {teams.map((t) => {
          const on = selected.includes(t.key);
          return (
            <label
              key={t.key}
              htmlFor={`team-${t.key}`}
              className={cn(
                "flex cursor-pointer gap-3 border p-4 transition-colors",
                on ? "border-lsr-orange bg-lsr-orange/[0.06]" : "border-white/10 bg-white/[0.02] hover:border-white/25",
              )}
            >
              <Checkbox id={`team-${t.key}`} checked={on} onCheckedChange={() => onToggle(t.key)} className="mt-1" />
              <span className="space-y-1">
                <span className="block font-display text-lg font-black uppercase italic text-white">{t.label}</span>
                <span className="block font-sans text-sm text-white/60">{t.blurb}</span>
                <span className={cn("block font-sans text-[11px] font-bold uppercase tracking-widest", t.interviewRequired ? "text-sky-300" : "text-white/40")}>
                  {t.interviewRequired ? "Interview required" : "No interview"}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </>
  );
}

function LinksStep({ state, set, errors }: { state: FormState; set: (p: Partial<FormState>) => void; errors: Record<string, string> }) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="resume-url" className={labelClass}>Link to your resume <span className="ml-2 text-[10px] tracking-widest text-white/35">Required</span></Label>
        <Input
          id="resume-url"
          type="url"
          inputMode="url"
          placeholder="https://"
          value={state.resumeUrl}
          maxLength={RECRUITING_LIMITS.urlMax}
          onChange={(e) => set({ resumeUrl: e.target.value })}
          aria-invalid={errors.resumeUrl ? true : undefined}
          className={inputClass}
        />
        {errors.resumeUrl && <p role="alert" className={errorClass}>{errors.resumeUrl}</p>}
        <p className="font-sans text-xs leading-relaxed text-white/50">
          Upload your resume somewhere you control (for example Google Drive) and paste the link. <strong className="text-white/70">Make sure anyone with the link can view it</strong>: officers who can&apos;t open it can&apos;t consider your application. Open the link in a private window to check.
        </p>
      </div>
    </>
  );
}

function ReviewStep({
  state,
  accountEmail,
  steps,
  completion,
  serverReport,
  pending,
  onFix,
  onSubmit,
}: {
  state: FormState;
  accountEmail: string;
  steps: Array<{ key: StepKey; label: string }>;
  completion: ReturnType<typeof stepCompletion>;
  serverReport: CompletenessReport | null;
  pending: boolean;
  onFix: (key: StepKey) => void;
  onSubmit: () => void;
}) {
  const [linkOk, setLinkOk] = useState(false);
  const [finalOk, setFinalOk] = useState(false);
  const pages = steps.filter((s) => s.key !== "review");
  const ready = completion.complete && linkOk && finalOk;

  return (
    <>
      <p className="font-sans text-sm leading-relaxed text-white/60">Check that everything is right. Once you submit, you can&apos;t change your application.</p>

      <ul className="space-y-2" aria-label="Checklist">
        {pages.map((s) => {
          const c = completion.byStep[s.key];
          return (
            <li key={s.key} className={cn("flex flex-wrap items-start gap-3 border px-4 py-3", c?.complete ? "border-green-500/20 bg-green-500/[0.04]" : "border-red-500/30 bg-red-500/[0.05]")}>
              {c?.complete ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-400" aria-label="Complete" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-label="Needs attention" />}
              <div className="min-w-0 flex-1">
                <p className="font-sans text-sm font-bold text-white">{s.label}</p>
                {!c?.complete && (
                  <ul className="mt-1 space-y-0.5 font-sans text-xs text-red-200">
                    {c?.problems.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                )}
              </div>
              {!c?.complete && (
                <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onFix(s.key)} className="h-8 rounded-none border-white/20 bg-transparent font-sans text-[11px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
                  Fix
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {serverReport && !serverReport.complete && (
        <p role="alert" className="border border-red-500/30 bg-red-500/10 px-4 py-3 font-sans text-sm text-red-200">
          We checked again and something is still missing: {serverReport.sections.filter((s) => !s.complete).map((s) => s.label).join(", ")}.
        </p>
      )}

      <details className="border border-white/10 bg-white/[0.02]">
        <summary className="cursor-pointer px-4 py-3 font-sans text-xs font-bold uppercase tracking-widest text-white/70">Read through your answers</summary>
        <div className="border-t border-white/10 p-4">
          <ApplicationSummary
            profile={{ fullName: state.profile.fullName, email: accountEmail, eid: state.profile.eid, gradYear: state.profile.gradYear || null, major: state.profile.major }}
            resumeUrl={state.resumeUrl.trim() || null}
            genericAnswers={state.genericAnswers}
            teams={state.teams.map((key) => ({ key, answers: state.trackAnswers[key] ?? {} }))}
          />
        </div>
      </details>

      <div className="space-y-3">
        <label htmlFor="confirm-link" className="flex cursor-pointer items-start gap-3 font-sans text-sm text-white/75">
          <Checkbox id="confirm-link" checked={linkOk} onCheckedChange={(v) => setLinkOk(v === true)} className="mt-0.5" />
          I opened my resume link in a private window and it works for anyone with the link.
        </label>
        <label htmlFor="confirm-final" className="flex cursor-pointer items-start gap-3 font-sans text-sm text-white/75">
          <Checkbox id="confirm-final" checked={finalOk} onCheckedChange={(v) => setFinalOk(v === true)} className="mt-0.5" />
          I understand that every team I chose is submitted together, and that I can&apos;t edit or withdraw my application afterwards.
        </label>
      </div>

      <Button type="button" disabled={!ready || pending} onClick={onSubmit} className={cn(primaryButton, "w-full sm:w-auto")}>
        {pending ? "Submitting..." : "Submit my application"}
      </Button>
      {!completion.complete && <p className="font-sans text-xs text-white/50">Fix the pages marked above to turn on Submit.</p>}
    </>
  );
}
