"use client"

import { useCallback, useState, useTransition } from "react"
import { unstable_rethrow } from "next/navigation"
import { toast } from "sonner"
import { unexpectedError } from "@/lib/action-result"

/** Next's redirect and notFound signals. They have to be rethrown so the router can act on them. */
function isNavigation(error: unknown) {
  try {
    unstable_rethrow(error)
    return false
  } catch {
    return true
  }
}

function failureMessage(result: unknown): string | null {
  if (result && typeof result === "object" && "ok" in result && result.ok === false && "error" in result) {
    return String(result.error)
  }
  return null
}

type Messages = {
  /** Toasted when the action finishes (or redirects) */
  success?: string
  /** Prefix for the toast when the action throws */
  error?: string
}

/**
 * Runs a server action from a button or a hand-rolled form submit: tracks pending, toasts the outcome, and
 * lets redirects through to the router. An `{ ok: false, error }` result is toasted as is. Pass a `key` to
 * know which row of a list is busy. Resolves to true on success.
 */
export function useAction() {
  const [pending, startTransition] = useTransition()
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const run = useCallback(
    (action: () => Promise<unknown>, messages: Messages = {}, key?: string) =>
      new Promise<boolean>((resolve) => {
        setBusyKey(key ?? null)
        startTransition(async () => {
          try {
            const result = await action()
            const failed = failureMessage(result)
            if (failed) {
              toast.error(failed)
              resolve(false)
              return
            }
            if (messages.success) toast.success(messages.success)
            resolve(true)
          } catch (error) {
            if (isNavigation(error)) {
              if (messages.success) toast.success(messages.success)
              resolve(true)
              throw error
            }
            toast.error(unexpectedError(error, messages.error))
            resolve(false)
          }
        })
      }),
    [],
  )

  return { run, pending, busyKey: pending ? busyKey : null }
}
