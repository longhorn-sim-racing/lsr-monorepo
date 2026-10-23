"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Archive, ArchiveRestore, CheckCircle2, History, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button, useConfirm } from "@/components/admin/kit"
import type { ActionResult } from "@/lib/action-result"
import { unexpectedError } from "@/lib/action-result"
import { deleteKnowledgeEntryForGood, markKnowledgeEntryReviewed, restoreKnowledgeVersion, setKnowledgeEntryArchived } from "../actions"

/** Runs an action, reports it, and refreshes the page (or goes elsewhere) when it worked */
function useEntryAction() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const run = (action: () => Promise<ActionResult>, success: string, then?: string) =>
    startTransition(async () => {
      let result: ActionResult
      try {
        result = await action()
      } catch (error) {
        result = { ok: false, error: unexpectedError(error) }
      }
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(success)
      if (then) router.replace(then)
      else router.refresh()
    })
  return { pending, run }
}

/** The entry page's header buttons: review (of the version on the page), archive, and (admins) delete for good */
export function EntryActions({
  id,
  title,
  archived,
  canDelete,
  baseVersionId,
}: {
  id: string
  title: string
  archived: boolean
  canDelete: boolean
  /** The version the page shows: reviewing is refused if a newer one came in since */
  baseVersionId: string | null
}) {
  const confirm = useConfirm()
  const { pending, run } = useEntryAction()

  async function remove() {
    const ok = await confirm({
      title: `Delete “${title}” for good?`,
      description:
        "The entry and every version of it are deleted, and Jack can't find it any more. Jack's room notes with its text are cleared, and so is its text in his tool calls. Its title stays in the audit log, and messages that quote it (an officer's own, or Jack's answer) aren't changed: its History links the rooms. This can't be undone. To only hide it, archive it instead.",
      confirmLabel: "Delete for good",
      tone: "danger",
    })
    if (ok) run(() => deleteKnowledgeEntryForGood(id), "Entry deleted", "/admin/knowledge")
  }

  async function archive() {
    const ok = await confirm({
      title: `Archive “${title}”?`,
      description: "Jack stops finding it, and it leaves the main list. It keeps its history, and you can unarchive it any time.",
      confirmLabel: "Archive",
    })
    if (ok) run(() => setKnowledgeEntryArchived(id, true), "Archived")
  }

  return (
    <>
      {!archived && (
        <Button disabled={pending} onClick={() => run(() => markKnowledgeEntryReviewed(id, baseVersionId), "Marked reviewed")} title="You checked it's still true; its age restarts today">
          <CheckCircle2 aria-hidden />
          Mark reviewed
        </Button>
      )}
      {archived ? (
        <Button disabled={pending} onClick={() => run(() => setKnowledgeEntryArchived(id, false), "Unarchived")}>
          <ArchiveRestore aria-hidden />
          Unarchive
        </Button>
      ) : (
        <Button disabled={pending} onClick={() => void archive()}>
          <Archive aria-hidden />
          Archive
        </Button>
      )}
      {canDelete && (
        <Button variant="danger" disabled={pending} onClick={() => void remove()}>
          <Trash2 aria-hidden />
          Delete
        </Button>
      )}
    </>
  )
}

/** Makes an earlier version the newest again */
export function RestoreVersionButton({ entryId, versionId, baseVersionId, label }: { entryId: string; versionId: string; baseVersionId: string | null; label: string }) {
  const confirm = useConfirm()
  const { pending, run } = useEntryAction()

  async function restore() {
    const ok = await confirm({
      title: "Restore this version?",
      description: `The entry goes back to the version from ${label}. That becomes a new version, so nothing in the history is lost.`,
      confirmLabel: "Restore",
    })
    if (ok) run(() => restoreKnowledgeVersion(entryId, versionId, baseVersionId), "Version restored", `/admin/knowledge/${entryId}`)
  }

  return (
    <Button size="sm" disabled={pending} onClick={() => void restore()}>
      <History aria-hidden />
      Restore this version
    </Button>
  )
}
