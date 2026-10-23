import { Panel, PanelBody, PanelHeader } from "@/components/admin/kit"

/**
 * SLOT for G5 (file storage): Supabase Storage usage on the Connections page (the private "jack"
 * bucket: space used of the plan's limit, file count, the largest kinds). G5 replaces this placeholder
 * and nothing else on the page. It's a server component that loads its own data; the page renders it
 * through SafeSlot, so a throw here shows a short notice instead of breaking the page.
 */
export async function StoragePanel() {
  return (
    <Panel>
      <PanelHeader title="File storage" description="Room files, deck renders and exports." />
      <PanelBody>
        <p className="text-[13px] text-admin-subtle">Not built yet. How much storage Jack&apos;s files use shows here once it&apos;s set up.</p>
      </PanelBody>
    </Panel>
  )
}
