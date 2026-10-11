"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resendAllFailedAction, resendEmailAction } from "@/app/admin/recruiting/actions";
import { EMAIL_STATUS_BADGE, EMAIL_TEMPLATE_LABEL, formatCentral } from "@/lib/recruiting/labels";
import { cn } from "@/lib/utils";

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
    <div className="mx-auto max-w-5xl space-y-5 font-mono text-sm text-white">
      <Link href={`/admin/recruiting?cycle=${cycle.slug}`} className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-white/50 hover:text-white">
        <ArrowLeft size={14} /> Applications
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 font-display text-2xl font-black uppercase italic">
          <Mail size={20} className="text-lsr-orange" /> Emails that need attention
        </h1>
        <select
          aria-label="Round"
          value={cycle.slug}
          onChange={(e) => router.push(`/admin/recruiting/emails?cycle=${e.target.value}`)}
          className="rounded border border-white/10 bg-black/50 px-3 py-1.5 text-xs text-white focus:border-lsr-orange focus:outline-none"
        >
          {cycles.map((c) => (
            <option key={c.slug} value={c.slug}>{c.name}{c.isActive ? " (active)" : ""}</option>
          ))}
        </select>
        <Button size="sm" disabled={failed.length === 0 || pending} onClick={() => setBulkOpen(true)} className="ml-auto h-8 bg-lsr-orange text-xs uppercase tracking-wider text-white hover:bg-white hover:text-lsr-charcoal">
          Resend all failed ({failed.length})
        </Button>
      </div>

      <p className="rounded border border-white/10 bg-black/40 px-3 py-2 text-xs leading-relaxed text-white/60">
        {quota.dailyLimit === null ? (
          <>No daily email limit is configured.</>
        ) : (
          <>
            <strong className="text-white/80">{quota.sentToday} of {quota.dailyLimit}</strong> emails sent today (announcements and recruiting together); {quota.left} left. The count resets at 7 pm Central (6 pm in winter). A message that fails because the limit was reached can be resent after that.
          </>
        )}
      </p>

      <div className="overflow-x-auto rounded-lg border border-white/10 bg-black/40">
        <table className="w-full text-left text-xs">
          <thead className="bg-white/5 text-[10px] uppercase tracking-wider text-white/40">
            <tr>
              <th className="px-3 py-2">Applicant</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((r) => (
              <tr key={r.id} className="align-top hover:bg-white/[0.03]">
                <td className="px-3 py-2">
                  <Link href={`/admin/recruiting/${r.applicationId}`} className="font-bold text-white hover:text-lsr-orange">{r.applicantName || "Unnamed applicant"}</Link>
                  <div className="text-white/40">{r.toEmail}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="text-white/80">{EMAIL_TEMPLATE_LABEL[r.template] ?? r.template}</div>
                  <div className="max-w-xs truncate text-white/40">{r.subject}</div>
                </td>
                <td className="px-3 py-2">
                  <span className={cn("rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider", EMAIL_STATUS_BADGE[r.status])}>{r.status.toLowerCase()}</span>
                  {r.error && <div className="mt-1 max-w-xs text-red-300/80">{r.error}</div>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-white/50">{formatCentral(r.createdAt, "MMM d, h:mm a")}</td>
                <td className="px-3 py-2 text-right">
                  {r.status === "FAILED" ? (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => resendOne(r.id)} className="h-7 border-white/10 text-[11px] uppercase tracking-wider">
                      {busyId === r.id ? "Sending..." : "Resend"}
                    </Button>
                  ) : (
                    <span className="text-[11px] text-white/30">sending</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-12 text-center uppercase tracking-widest text-white/30">Nothing needs attention</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {bulkOpen && <ResendAllDialog cycleId={cycle.id} count={failed.length} onClose={(changed) => { setBulkOpen(false); if (changed) router.refresh(); }} />}
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
    <Dialog open onOpenChange={(open) => !open && !pending && onClose(false)}>
      <DialogContent className="max-w-md border-white/10 bg-lsr-charcoal text-white">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-black uppercase italic">Resend {count} failed email{count === 1 ? "" : "s"}?</DialogTitle>
          <DialogDescription className="text-white/60">Each goes to the applicant it was written for, with the same message. Up to 100 are sent at a time.</DialogDescription>
        </DialogHeader>
        {limitHit && (
          <label className="flex items-start gap-2 text-xs text-amber-200">
            <Checkbox checked={ignoreLimit} onCheckedChange={(v) => setIgnoreLimit(v === true)} className="mt-0.5" />
            <span>Send anyway. Anything over today&apos;s limit will fail again and can be resent later.</span>
          </label>
        )}
        {error && <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={pending} onClick={() => onClose(false)} className="text-white/60">Cancel</Button>
          <Button disabled={pending || (limitHit && !ignoreLimit)} onClick={go} className="bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal">
            {pending ? "Sending..." : "Resend all"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
