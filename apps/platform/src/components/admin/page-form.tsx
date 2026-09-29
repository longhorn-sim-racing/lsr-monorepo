"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { savePage, type PageInput } from "@/app/admin/pages/actions";

// Where each known page shows up on the site.
const PUBLIC_PATHS: Record<string, string> = {
  "lone-star-cup-rules": "/lone-star-cup/rules",
};

const fieldClass =
  "w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-lsr-orange transition-colors";
const labelClass = "text-[10px] uppercase tracking-wider text-white/40";

export function PageForm({ id, initial }: { id: string | null; initial: PageInput }) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const publicPath = PUBLIC_PATHS[form.slug];

  async function save(visibility = form.visibility) {
    setSaving(true);
    const result = await savePage(id, { ...form, visibility });
    setSaving(false);
    if (!result.ok) return toast.error(result.error);
    setForm((f) => ({ ...f, visibility }));
    toast.success(visibility === "public" && form.visibility !== "public" ? "Published" : "Saved");
    if (!id) router.replace(`/admin/pages/${result.id}`);
    else router.refresh();
  }

  return (
    <div className="max-w-4xl space-y-5 font-mono text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/admin/pages" className="text-xs text-white/40 hover:text-white">← Pages</Link>
        <div className="flex items-center gap-2">
          <span
            className={
              form.visibility === "public"
                ? "rounded border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-green-400"
                : "rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-300"
            }
          >
            {form.visibility === "public" ? "Public" : "Draft (officers only)"}
          </span>
          {publicPath && id && (
            <Button asChild variant="outline" size="sm" className="h-8 border-white/10 text-xs">
              <a href={publicPath} target="_blank" rel="noreferrer">View page</a>
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={labelClass} htmlFor="page-title">Title</label>
          <input id="page-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={fieldClass} />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor="page-slug">Slug</label>
          <input id="page-slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} className={fieldClass} />
          <p className="text-[11px] text-white/30">{publicPath ? `Shown at ${publicPath}` : "Not shown anywhere on the site yet."}</p>
        </div>
      </div>

      <div className="space-y-1">
        <label className={labelClass} htmlFor="page-body">Content (Markdown)</label>
        <textarea
          id="page-body"
          value={form.bodyMd}
          onChange={(e) => setForm({ ...form, bodyMd: e.target.value })}
          rows={28}
          className={`${fieldClass} font-mono text-xs leading-relaxed`}
        />
        <p className="text-[11px] text-white/30">
          # Heading, ## Section, - bullet, 1. numbered, **bold**, _italic_, [link](https://…), &gt; callout. Plain Markdown only.
        </p>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {form.visibility === "public" ? (
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => save("officers")} className="text-white/60">
            Unpublish
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={saving || !id} onClick={() => save("public")} className="border-green-500/30 text-green-400" title={id ? undefined : "Save it first"}>
            Publish
          </Button>
        )}
        <Button size="sm" disabled={saving} onClick={() => save()} className="bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal">
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
