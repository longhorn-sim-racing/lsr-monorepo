'use client';

import { useState, useTransition } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unexpectedError } from '@/lib/action-result';
import { saveEid } from './actions';
import { inputClass, labelClass } from './form-styles';

/** The UT EID, saved on its own like the photo, since it's private and checked against other accounts. */
export function EidField({ initialEid }: { initialEid: string | null }) {
  const [value, setValue] = useState(initialEid ?? '');
  const [saved, setSaved] = useState(initialEid ?? '');
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const changed = value.trim().toLowerCase() !== saved;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!changed) return;
    setError(null);
    setJustSaved(false);
    startTransition(async () => {
      try {
        const result = await saveEid(value);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        const eid = result.data ?? '';
        setSaved(eid);
        setValue(eid);
        setJustSaved(true);
      } catch (err) {
        setError(unexpectedError(err, "Saving your EID didn't work"));
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Label htmlFor="eid" className={labelClass}>UT EID</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="eid"
          name="eid"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setJustSaved(false);
          }}
          placeholder="e.g. abc1234"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={16}
          className={`${inputClass} sm:max-w-xs`}
        />
        <Button
          type="submit"
          disabled={!changed || isPending}
          className="h-12 rounded-none bg-lsr-orange px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal"
        >
          {isPending ? 'Saving…' : 'Save EID'}
        </Button>
      </div>
      {justSaved && !changed && (
        <p className="flex items-center gap-1.5 font-sans text-xs text-white/60">
          <Check className="h-3.5 w-3.5 text-lsr-orange" aria-hidden />
          {saved ? 'Saved.' : 'Removed.'}
        </p>
      )}
      {error && (
        <p role="alert" className="border border-red-400/30 bg-red-500/10 px-4 py-3 font-sans text-xs leading-relaxed text-red-200">
          {error}
        </p>
      )}
      <p className="font-sans text-xs text-white/45">
        Never shown on your public pages. Officers use it for UT records and the Lone Star Cup.
      </p>
    </form>
  );
}
