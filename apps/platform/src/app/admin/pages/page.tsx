import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { prisma } from "@/server/db";
import { requireOfficerPage } from "@/server/auth/guards";
import { Button } from "@/components/ui/button";

export default async function AdminPagesPage() {
  await requireOfficerPage();
  const pages = await prisma.page.findMany({
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, slug: true, visibility: true, updatedAt: true },
  });

  return (
    <div className="border border-white/10 bg-black/40 rounded-lg overflow-hidden font-mono text-sm">
      <div className="bg-white/5 p-3 border-b border-white/10 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 rounded border border-white/10">
          <FileText size={14} className="text-lsr-orange" />
          <span className="font-bold text-white/80 tracking-wider uppercase">Pages</span>
        </div>
        <Button asChild size="sm" className="h-8 bg-lsr-orange text-white text-xs uppercase tracking-wider hover:bg-white hover:text-lsr-charcoal">
          <Link href="/admin/pages/new"><Plus size={14} className="mr-1.5" /> New page</Link>
        </Button>
      </div>
      <table className="w-full text-left text-xs">
        <thead className="bg-white/5 text-[10px] uppercase tracking-wider text-white/40">
          <tr>
            <th className="px-3 py-2">Title</th>
            <th className="px-3 py-2">Slug</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {pages.map((p) => (
            <tr key={p.id} className="hover:bg-white/[0.03]">
              <td className="px-3 py-2">
                <Link href={`/admin/pages/${p.id}`} className="font-bold text-white hover:text-lsr-orange">{p.title}</Link>
              </td>
              <td className="px-3 py-2 text-white/50">{p.slug}</td>
              <td className="px-3 py-2">
                {p.visibility === "public" ? (
                  <span className="text-green-400 uppercase tracking-wider text-[10px]">Public</span>
                ) : (
                  <span className="text-amber-300 uppercase tracking-wider text-[10px]">Draft</span>
                )}
              </td>
              <td className="px-3 py-2 text-white/40">{p.updatedAt.toLocaleDateString()}</td>
            </tr>
          ))}
          {!pages.length && (
            <tr>
              <td colSpan={4} className="px-3 py-12 text-center text-white/30 uppercase tracking-widest">No pages yet</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
