"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "./button"
import { Field, Textarea } from "./form"

/** A centered dialog with a title, optional description, body and footer. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  size = "md",
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  footer?: React.ReactNode
  size?: "sm" | "md" | "lg"
  children?: React.ReactNode
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-card text-[13px] shadow-xl outline-none",
            size === "sm" && "max-w-sm",
            size === "md" && "max-w-lg",
            size === "lg" && "max-w-3xl",
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-admin-row px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <DialogPrimitive.Title className="text-sm font-semibold">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-xs text-muted-foreground">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close className="-mr-1 flex size-7 items-center justify-center rounded-md text-admin-subtle hover:bg-accent hover:text-foreground" aria-label="Close">
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          {children && <div className="min-h-0 overflow-y-auto px-4 py-3.5">{children}</div>}
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-admin-row px-4 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export type ConfirmOptions = {
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: "default" | "danger"
}

export type PromptOptions = ConfirmOptions & {
  /** Label for the text box */
  inputLabel: string
  placeholder?: string
  defaultValue?: string
  /** Blank answers can't be submitted */
  required?: boolean
}

type Pending =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void }

const ConfirmContext = React.createContext<{
  confirm: (options: ConfirmOptions) => Promise<boolean>
  prompt: (options: PromptOptions) => Promise<string | null>
} | null>(null)

/** Mounted once by the admin shell; lets any admin component ask `await confirm(...)` instead of window.confirm. */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null)
  const [text, setText] = React.useState("")

  // A new question while one is open answers the open one with "no", so its caller doesn't hang
  const replace = React.useCallback((next: Pending) => {
    setPending((current) => {
      if (current?.kind === "confirm") current.resolve(false)
      else if (current?.kind === "prompt") current.resolve(null)
      return next
    })
  }, [])

  const api = React.useMemo(
    () => ({
      confirm: (options: ConfirmOptions) => new Promise<boolean>((resolve) => replace({ kind: "confirm", options, resolve })),
      prompt: (options: PromptOptions) =>
        new Promise<string | null>((resolve) => {
          setText(options.defaultValue ?? "")
          replace({ kind: "prompt", options, resolve })
        }),
    }),
    [replace],
  )

  const close = (accepted: boolean) => {
    if (!pending) return
    if (pending.kind === "confirm") pending.resolve(accepted)
    else pending.resolve(accepted ? text.trim() : null)
    setPending(null)
  }

  const options = pending?.options
  const blocked = pending?.kind === "prompt" && pending.options.required && !text.trim()

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      <Dialog
        open={!!pending}
        onOpenChange={(open) => !open && close(false)}
        size="sm"
        title={options?.title ?? ""}
        description={options?.description}
        footer={
          <>
            {/* Destructive confirms start on Cancel, so a stray Enter can't delete */}
            <Button variant="secondary" onClick={() => close(false)} autoFocus={pending?.kind === "confirm" && options?.tone === "danger"}>
              {options?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={options?.tone === "danger" ? "danger-solid" : "primary"}
              disabled={blocked}
              onClick={() => close(true)}
              autoFocus={pending?.kind === "confirm" && options?.tone !== "danger"}
            >
              {options?.confirmLabel ?? (options?.tone === "danger" ? "Delete" : "Confirm")}
            </Button>
          </>
        }
      >
        {pending?.kind === "prompt" && (
          <Field label={pending.options.inputLabel} htmlFor="admin-prompt-input">
            <Textarea
              id="admin-prompt-input"
              autoFocus
              rows={3}
              value={text}
              placeholder={pending.options.placeholder}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  )
}

function useConfirmContext() {
  const context = React.useContext(ConfirmContext)
  if (!context) throw new Error("useConfirm must be used inside the admin shell")
  return context
}

/** `const confirm = useConfirm(); if (await confirm({ title: "Delete this event?", tone: "danger" })) ...` */
export function useConfirm() {
  return useConfirmContext().confirm
}

/** Like window.prompt, in the admin's style. Resolves to the trimmed text, or null if cancelled. */
export function usePrompt() {
  return useConfirmContext().prompt
}

/**
 * A panel that slides in from the right, for editing or inspecting one item without leaving a list on
 * screens where the list and a side panel don't fit together.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l bg-card text-[13px] shadow-xl outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-admin-row px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <DialogPrimitive.Title className="text-sm font-semibold">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-xs text-muted-foreground">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close className="-mr-1 flex size-7 items-center justify-center rounded-md text-admin-subtle hover:bg-accent hover:text-foreground" aria-label="Close">
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-admin-row px-4 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
