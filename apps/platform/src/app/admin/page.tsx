import { AuditConsole } from "@/components/admin/audit-console";
import { Metadata } from "next";
import { requireOfficerPage } from "@/server/auth/guards";

export const metadata: Metadata = {
  title: "Admin Console | LSR",
};

export default async function AdminPage() {
  await requireOfficerPage();
  return (
    <div className="h-full">
      <AuditConsole />
    </div>
  );
}