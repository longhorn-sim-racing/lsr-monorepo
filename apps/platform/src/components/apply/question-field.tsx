"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RECRUITING_LIMITS, type GenericQuestion } from "@/schemas/recruiting.schema";
import { choiceClass, errorClass, inputClass, labelClass, textareaClass } from "./apply-styles";

/**
 * One question, rendered by its type. The value shapes match what the server stores: text as a
 * string, single choice as the option, multiple choice as an array, scale as a number, yes/no as a boolean.
 */
export function QuestionField({
  question,
  value,
  onChange,
  error,
}: {
  question: GenericQuestion;
  value: unknown;
  onChange: (next: unknown) => void;
  error?: string;
}) {
  const id = `q-${question.id}`;
  const errorId = `${id}-error`;
  const aria = { "aria-invalid": error ? true : undefined, "aria-describedby": error ? errorId : undefined } as const;
  const text = typeof value === "string" ? value : "";

  const header = (
    <>
      <span className={labelClass}>{question.label}</span>
      <span className="ml-2 font-sans text-[10px] uppercase tracking-widest text-white/35">{question.required ? "Required" : "Optional"}</span>
    </>
  );
  const help = question.help ? <p className="font-sans text-xs text-white/50">{question.help}</p> : null;
  const err = error ? <p id={errorId} role="alert" className={errorClass}>{error}</p> : null;

  switch (question.type) {
    case "short_text":
      return (
        <div className="space-y-2">
          <Label htmlFor={id} className="block">{header}</Label>
          {help}
          <Input id={id} value={text} maxLength={RECRUITING_LIMITS.shortTextMax} onChange={(e) => onChange(e.target.value)} className={inputClass} {...aria} />
          {err}
        </div>
      );
    case "long_text":
      return (
        <div className="space-y-2">
          <Label htmlFor={id} className="block">{header}</Label>
          {help}
          <Textarea id={id} value={text} rows={6} maxLength={RECRUITING_LIMITS.longTextMax} onChange={(e) => onChange(e.target.value)} className={textareaClass} {...aria} />
          <p className="text-right font-sans text-[11px] text-white/35">{text.length} / {RECRUITING_LIMITS.longTextMax}</p>
          {err}
        </div>
      );
    case "link":
      return (
        <div className="space-y-2">
          <Label htmlFor={id} className="block">{header}</Label>
          {help}
          <Input id={id} type="url" inputMode="url" value={text} placeholder="https://" onChange={(e) => onChange(e.target.value)} className={inputClass} {...aria} />
          {err}
        </div>
      );
    case "single_choice":
      return (
        <fieldset className="space-y-3" {...aria}>
          <legend className="mb-3">{header}</legend>
          {help}
          {question.options.map((option, i) => (
            <label key={option} htmlFor={`${id}-${i}`} className={choiceClass}>
              <input id={`${id}-${i}`} type="radio" name={id} checked={value === option} onChange={() => onChange(option)} className="accent-lsr-orange" />
              {option}
            </label>
          ))}
          {err}
        </fieldset>
      );
    case "multi_choice": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="space-y-3" {...aria}>
          <legend className="mb-3">{header}</legend>
          {help ?? <p className="font-sans text-xs text-white/50">Pick as many as apply.</p>}
          {question.options.map((option, i) => (
            <label key={option} htmlFor={`${id}-${i}`} className={choiceClass}>
              <Checkbox
                id={`${id}-${i}`}
                checked={selected.includes(option)}
                onCheckedChange={(on) => onChange(on === true ? [...selected, option] : selected.filter((o) => o !== option))}
              />
              {option}
            </label>
          ))}
          {err}
        </fieldset>
      );
    }
    case "scale": {
      const points = Array.from({ length: question.max - question.min + 1 }, (_, i) => question.min + i);
      return (
        <fieldset className="space-y-3" {...aria}>
          <legend className="mb-3">{header}</legend>
          {help}
          <div className="flex flex-wrap gap-2">
            {points.map((n) => (
              <label key={n} htmlFor={`${id}-${n}`} className={`${choiceClass} min-w-14 justify-center`}>
                <input id={`${id}-${n}`} type="radio" name={id} checked={value === n} onChange={() => onChange(n)} className="sr-only" />
                {n}
              </label>
            ))}
          </div>
          {err}
        </fieldset>
      );
    }
    case "yes_no":
      return (
        <fieldset className="space-y-3" {...aria}>
          <legend className="mb-3">{header}</legend>
          {help}
          <div className="flex gap-3">
            {([["Yes", true], ["No", false]] as const).map(([label, v]) => (
              <label key={label} htmlFor={`${id}-${label}`} className={`${choiceClass} min-w-24`}>
                <input id={`${id}-${label}`} type="radio" name={id} checked={value === v} onChange={() => onChange(v)} className="accent-lsr-orange" />
                {label}
              </label>
            ))}
          </div>
          {err}
        </fieldset>
      );
  }
}
