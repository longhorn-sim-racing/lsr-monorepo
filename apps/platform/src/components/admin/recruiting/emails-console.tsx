"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge, Button, CheckboxField, Dialog, EmptyState, Notice, PageHeader, Panel, Select, TD, TH, THead, TR, Table, Toolbar } from "@/components/admin/kit";
import { resendAllFailedAction, resendEmailAction } from "@/app/admin/recruiting/actions";
import { EMAIL_STATUS_TONE, EMAIL_TEMPLATE_LABEL, formatCentral } from "@/lib/recruiting/labels";

type Row = {
  id: string;
  template: string;
  subject: string;
  status: string;
  error: string | null;
  createdAt: string;
  toEmail: string;
  applicationId: string;
  applicantName: string | null;
};

export function EmailsConsole({
  cycles,
  cycle,
  quota,
  rows,
}: {
  cycles: Array<{ slug: string; name: string; isActive: boolean }>;
  cycle: { id: string; slug: string; name: string };
  quota: { sentToday: number; dailyLimit: number | null; left: number | null };
  rows: Row[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const failed = rows.filter((r) => r.status === "FAILED");

  function resendOne(id: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await resendEmailAction(id);
      setBusyId(null);
      if (!res.ok) return void toast.error(res.error);
      if (res.data.status === "SENT") toast.success("Email sent.");
      else toast.warning(`Still not sent: ${res.data.error ?? "unknown reason"}`);
      router.refresh();
    });
  }

  return (
    <div className="max-w-5xl">
      <PageHeader
        back={{ href: `/admin/recruiting?cycle=${cycle.slug}`, label: "Applications" }}
        title="Emails that need attention"
        description="Failed emails, and ones stuck while sending."
        actions={
          <Button variant="primary" disabled={failed.length === 0 || pending} onClick={() => setBulkOpen(true)}>
            Resend all failed ({failed.length})
          </Button>
        }
      />

      <Toolbar>
        <Select aria-label="Round" className="w-auto" value={cycle.slug} onChange={(e) => router.push(`/admin/recruiting/emails?cycle=${e.target.value}`)}>
          {cycles.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
              {c.isActive ? " (active)" : ""}
            </option>
          ))}
        </Select>
      </Toolbar>

      <Notice className="mb-3">
        {quota.dailyLimit === null ? (
          "No daily email limit is configured."
        ) : (
          <>
            <strong className="font-semibold text-foreground">
              {quota.sentToday} of {quota.dailyLimit}
            </strong>{" "}
            emails sent today (announcements, receipts and recruiting together); {quota.left} left for recruiting (a few are held back for registration confirmations and receipts). The count resets at 7 pm Central (6 pm in winter). A message that fails because the limit was reached can be resent after that.
          </>
        )}
      </Notice>

      {rows.length === 0 ? (
        <Panel>
          <EmptyState title="Nothing needs attention" description="Every email for this round was sent." />
        </Panel>
      ) : (
        <Table minWidth={720}>
          <THead>
            <TH>Applicant</TH>
            <TH>Email</TH>
            <TH>Status</TH>
            <TH>Created</TH>
            <TH className="text-right">
              <span className="sr-only">Actions</span>
            </TH>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.id} className="align-top">
                <TD>
                  <Link href={`/admin/recruiting/${r.applicationId}`} className="font-semibold hover:text-primary hover:underline">
                    {r.applicantName || "Unnamed applicant"}
                  </Link>
                  <div className="text-xs text-admin-subtle">{r.toEmail}</div>
                </TD>
                <TD>
                  <div>{EMAIL_TEMPLATE_LABEL[r.template] ?? r.template}</div>
                  <div className="max-w-xs truncate text-xs text-admin-subtle">{r.subject}</div>
                </TD>
                <TD>
                  <Badge tone={EMAIL_STATUS_TONE[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge>
                  {r.error && <div className="mt-1 max-w-xs text-xs text-tone-danger-foreground">{r.error}</div>}
                </TD>
                <TD className="whitespace-nowrap text-muted-foreground">{formatCentral(r.createdAt, "MMM d, h:mm a")}</TD>
                <TD className="text-right">
                  {r.status === "FAILED" ? (
                    <Button size="sm" pending={busyId === r.id} disabled={pending} onClick={() => resendOne(r.id)}>
                      Resend
                    </Button>
                  ) : (
                    <span className="text-xs text-admin-subtle">sending</span>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}

      {bulkOpen && (
        <ResendAllDialog
          cycleId={cycle.id}
          count={failed.length}
          onClose={(changed) => {
            setBulkOpen(false);
            if (changed) router.refresh();
          }}
        />
      )}
    </div>
  );
}

function ResendAllDialog({ cycleId, count, onClose }: { cycleId: string; count: number; onClose: (changed: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [ignoreLimit, setIgnoreLimit] = useState(false);
  const [pending, startTransition] = useTransition();

  function go() {
    setError(null);
    startTransition(async () => {
      const res = await resendAllFailedAction(cycleId, { ignoreLimit });
      if (!res.ok) {
        setError(res.error);
        setLimitHit(res.code === "EMAIL_LIMIT");
        return;
      }
      const { sent, failed, total } = res.data;
      if (failed === 0) toast.success(`Sent ${sent} of ${total}.`);
      else toast.warning(`Sent ${sent} of ${total}; ${failed} still failed (see the reasons in the list).`);
      onClose(true);
    });
  }

  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(open) => !open && !pending && onClose(false)}
      title={`Resend ${count} failed email${count === 1 ? "" : "s"}?`}
      description="Each goes to the applicant it was written for, with the same message. Up to 100 are sent at a time."
      footer={
        <>
          <Button disabled={pending} onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button variant="primary" pending={pending} disabled={limitHit && !ignoreLimit} onClick={go}>
            Resend all
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {limitHit && (
          <CheckboxField
            checked={ignoreLimit}
            onChange={(e) => setIgnoreLimit(e.target.checked)}
            label="Send anyway"
            description="Anything over today's limit will fail again and can be resent later."
          />
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Dialog>
  );
}
