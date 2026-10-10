"use client";

import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";

/**
 * Submits a form to a server action and keeps the action's error message. Unlike `<form action>`,
 * React doesn't clear the fields afterwards, so a validation error doesn't wipe what was typed.
 * The clicked submit button's name and value are sent along, as a normal submit would.
 */
export function useFormAction(action: (formData: FormData) => Promise<ActionResult | void>, onSuccess?: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(e.currentTarget, submitter);
    // Browsers before 2023 ignore the second argument; add the clicked button by hand
    if (submitter instanceof HTMLButtonElement && submitter.name && !formData.has(submitter.name)) {
      formData.set(submitter.name, submitter.value);
    }
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result && !result.ok) setError(result.error);
      else if (result?.ok) onSuccess?.();
    });
  }

  return { onSubmit, error, pending };
}
