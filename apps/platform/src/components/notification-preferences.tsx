"use client";

import { useState, useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type NotificationPreferencesProps = {
  preferences: {
    emailRegistration: boolean;
    emailWaitlistPromotion: boolean;
    emailEventReminder: boolean;
    emailEventPosted: boolean;
    emailResultsPosted: boolean;
  };
};

const PREFERENCE_CONFIG = [
  {
    key: "emailRegistration",
    label: "Registration confirmations",
    description: "When you register for an event",
  },
  {
    key: "emailWaitlistPromotion",
    label: "Waitlist promotions",
    description: "When you're moved from waitlist to registered",
  },
  {
    key: "emailEventReminder",
    label: "Event reminders",
    description: "24 hours before events you're registered for",
  },
  {
    key: "emailEventPosted",
    label: "New events",
    description: "When new events are posted",
  },
  {
    key: "emailResultsPosted",
    label: "Race results",
    description: "When results are posted for races you participated in",
  },
] as const;

export function NotificationPreferences({
  preferences,
}: NotificationPreferencesProps) {
  const [values, setValues] = useState(preferences);
  const [isDirty, setIsDirty] = useState(false);

  // Sync state when props change (e.g., after form submission and revalidation)
  useEffect(() => {
    setValues(preferences);
    setIsDirty(false);
  }, [preferences]);

  const handleChange = (key: keyof typeof values, checked: boolean) => {
    setValues((prev) => ({ ...prev, [key]: checked }));
    setIsDirty(true);
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-2 sm:grid-cols-2">
        {PREFERENCE_CONFIG.map((pref) => (
          <div key={pref.key} className="flex items-start gap-4 border border-white/10 bg-white/[0.02] p-4 transition-colors has-[[data-state=checked]]:border-lsr-orange/50">
            <input
              type="hidden"
              name={pref.key}
              value={values[pref.key] ? "on" : ""}
            />
            <Checkbox
              id={pref.key}
              checked={values[pref.key]}
              onCheckedChange={(checked) =>
                handleChange(pref.key, checked === true)
              }
              className="mt-1 rounded-none border-white/30 data-[state=checked]:bg-lsr-orange data-[state=checked]:border-lsr-orange"
            />
            <div className="flex-1">
              <Label
                htmlFor={pref.key}
                className="font-sans font-bold text-sm cursor-pointer text-white"
              >
                {pref.label}
              </Label>
              <p className="mt-0.5 font-sans text-xs text-white/55">{pref.description}</p>
            </div>
          </div>
        ))}
      </div>

      <Button
        type="submit"
        size="sm"
        disabled={!isDirty}
        className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-10 transition-all px-6 disabled:opacity-50"
      >
        Save Preferences
      </Button>
    </div>
  );
}
