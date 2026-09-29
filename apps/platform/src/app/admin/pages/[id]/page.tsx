import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { requireOfficerPage } from "@/server/auth/guards";
import { PageForm } from "@/components/admin/page-form";

export default async function EditAdminPagePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage();
  const { id } = await params;
  const page = await prisma.page.findUnique({ where: { id } });
  if (!page) notFound();

  return (
    <PageForm
      id={page.id}
      initial={{
        title: page.title,
        slug: page.slug,
        visibility: page.visibility === "public" ? "public" : "officers",
        bodyMd: page.bodyMd,
      }}
    />
  );
}
