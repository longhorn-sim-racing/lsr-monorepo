import Link from "next/link";
import type { Metadata } from "next";
import { requireOfficerPage } from "@/server/auth/guards";
import { getEmailQuota, listEmailsNeedingAttention } from "@/server/services/recruiting-email.service";
import { listCycles } from "@/server/services/recruiting-cycle.service";
import { EmailsConsole } from "@/components/admin/recruiting/emails-console";

export const metadata: Metadata = { title: "Recruiting emails | LSR Admin" };
export const dynamic = "force-dynamic";

export default async function RecruitingEmailsPage({ searchParams }: { searchParams: Promise<{ cycle?: string }> }) {
  await requireOfficerPage();
  const sp = await searchParams;

  const cycles = await listCycles();
  const cycle = cycles.find((c) => c.slug === sp.cycle) ?? cycles.find((c) => c.isActive) ?? cycles[0];
  if (!cycle) {
    return (
      <div className="mx-auto max-w-xl space-y-3 font-mono text-sm text-white/70">
        <h1 className="font-display text-2xl font-black uppercase italic text-white">Recruiting emails</h1>
        <p>There are no recruiting rounds yet.</p>
        <Link href="/admin/recruiting/cycles" className="text-lsr-orange hover:underline">Create the first round</Link>
      </div>
    );
  }

  // listEmailsNeedingAttention first marks mail stuck mid-send as failed, so it can be resent
  const [rows, quota] = await Promise.all([listEmailsNeedingAttention(cycle.id), getEmailQuota()]);

  return (
    <EmailsConsole
      cycles={cycles.map((c) => ({ slug: c.slug, name: c.name, isActive: c.isActive }))}
      cycle={{ id: cycle.id, slug: cycle.slug, name: cycle.name }}
      quota={quota}
      rows={rows.map((r) => ({
        id: r.id,
        template: r.template,
        subject: r.subject,
        status: r.status,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
        toEmail: r.toEmail,
        applicationId: r.application.id,
        applicantName: r.application.fullName,
      }))}
    />
  );
}
