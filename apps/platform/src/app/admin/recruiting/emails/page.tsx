import Link from "next/link";
import { Button, EmptyState, PageHeader, Panel } from "@/components/admin/kit";
import type { Metadata } from "next";
import { requireOfficerPage } from "@/server/auth/guards";
import { getEmailQuota, listEmailsNeedingAttention } from "@/server/services/recruiting-email.service";
import { listCycles } from "@/server/services/recruiting-cycle.service";
import { EmailsConsole } from "@/components/admin/recruiting/emails-console";
import { recruitingDelivery } from "@/server/connectors/resend/delivery";

export const metadata: Metadata = { title: "Recruiting emails" };
export const dynamic = "force-dynamic";

export default async function RecruitingEmailsPage({ searchParams }: { searchParams: Promise<{ cycle?: string }> }) {
  await requireOfficerPage();
  const sp = await searchParams;

  const cycles = await listCycles();
  const cycle = cycles.find((c) => c.slug === sp.cycle) ?? cycles.find((c) => c.isActive) ?? cycles[0];
  if (!cycle) {
    return (
      <>
        <PageHeader title="Recruiting emails" back={{ href: "/admin/recruiting", label: "Applications" }} />
        <Panel>
          <EmptyState
            title="There are no recruiting rounds yet"
            action={
              <Button variant="primary" asChild>
                <Link href="/admin/recruiting/cycles">Create the first round</Link>
              </Button>
            }
          />
        </Panel>
      </>
    );
  }

  // listEmailsNeedingAttention first marks mail stuck mid-send as failed, so it can be resent
  const [rows, quota, delivery] = await Promise.all([
    listEmailsNeedingAttention(cycle.id),
    getEmailQuota(),
    // Sent mail Resend reported as bounced, refused or delayed (empty until delivery tracking is set up)
    recruitingDelivery(cycle.id).catch((error) => {
      console.error("[recruiting emails] Couldn't load delivery:", error);
      return null;
    }),
  ]);

  return (
    <EmailsConsole
      cycles={cycles.map((c) => ({ slug: c.slug, name: c.name, isActive: c.isActive }))}
      cycle={{ id: cycle.id, slug: cycle.slug, name: cycle.name }}
      quota={quota}
      deliverySummary={delivery?.summary ?? null}
      rows={[
        ...rows.map((r) => ({
          id: r.id,
          template: r.template,
          subject: r.subject,
          status: r.status,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
          toEmail: r.toEmail,
          applicationId: r.application.id,
          applicantName: r.application.fullName,
          delivery: null,
        })),
        ...(delivery?.problems ?? []).map((p) => ({
          id: p.id,
          template: p.template,
          subject: p.subject,
          status: "SENT",
          error: null,
          createdAt: p.createdAt.toISOString(),
          toEmail: p.toEmail,
          applicationId: p.applicationId,
          applicantName: p.applicantName,
          delivery: { status: p.delivery.status, reason: p.delivery.reason },
        })),
      ]}
    />
  );
}
