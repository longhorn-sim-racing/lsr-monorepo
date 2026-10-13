"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { cn } from "@/lib/utils"

const control =
  "w-full min-w-0 rounded-md border border-input bg-card px-2.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-admin-subtle focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:bg-admin-surface disabled:text-admin-subtle aria-invalid:border-tone-danger-foreground"

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(control, "h-8", className)} {...props} />
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(control, "min-h-20 resize-y py-2 leading-relaxed", className)} {...props} />
}

/** A native select: fast, accessible, and fine for short option lists. */
export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select className={cn(control, "h-8 pr-7", className)} {...props}>
      {children}
    </select>
  )
}

/** A dollar amount typed in dollars (e.g. "10" or "10.50"). Convert to cents in the action. */
export function MoneyInput({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <div className={cn("relative", className)}>
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[13px] text-admin-subtle">$</span>
      <input type="text" inputMode="decimal" className={cn(control, "h-8 pl-6 tabular-nums")} {...props} />
    </div>
  )
}

/** Label, control, and an optional hint or error under it. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: React.ReactNode
  htmlFor?: string
  hint?: React.ReactNode
  error?: React.ReactNode
  required?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-semibold text-tone-neutral-foreground">
        {label}
        {required && <span className="text-tone-danger-foreground"> *</span>}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs font-medium text-tone-danger-foreground">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-admin-subtle">{hint}</p>
      )}
    </div>
  )
}

/** Two fields per row on wide screens, one on phones. Give a field `className="sm:col-span-2"` to span. */
export function FieldGrid({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", className)}>{children}</div>
}

/** A titled group of fields inside a form panel. */
export function FormSection({ title, description, className, children }: { title: React.ReactNode; description?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-3", className)}>
      <legend className="mb-3 flex flex-col gap-0.5">
        <span className="text-xs font-bold text-foreground">{title}</span>
        {description && <span className="text-xs text-admin-subtle">{description}</span>}
      </legend>
      {children}
    </fieldset>
  )
}

/** A checkbox with its label (and an optional second line). */
export function CheckboxField({
  label,
  description,
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & { label: React.ReactNode; description?: React.ReactNode }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 text-[13px]", props.disabled && "cursor-not-allowed opacity-60", className)}>
      <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-[#FF8000]" {...props} />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        {description && <span className="text-xs text-admin-subtle">{description}</span>}
      </span>
    </label>
  )
}

/** An on/off switch with its label. Inside a form it submits "on" under `name` when checked. */
export function SwitchField({
  label,
  description,
  className,
  id,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { label: React.ReactNode; description?: React.ReactNode }) {
  const generated = React.useId()
  const switchId = id ?? generated
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <label htmlFor={switchId} className="flex cursor-pointer flex-col gap-0.5 text-[13px]">
        <span className="font-medium">{label}</span>
        {description && <span className="text-xs text-admin-subtle">{description}</span>}
      </label>
      <SwitchPrimitive.Root
        id={switchId}
        className="relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-[#D6CFC4] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary"
        {...props}
      >
        <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[16px]" />
      </SwitchPrimitive.Root>
    </div>
  )
}

/** The bottom row of a form: a status note on the left, buttons on the right. */
export function FormActions({ note, className, children }: { note?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2.5", className)}>
      <span className="text-xs text-admin-subtle">{note}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}
