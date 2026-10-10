import { prisma } from "@/server/db";
import { notFound } from "next/navigation";
import { ResultDetailClient } from "./client";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function ResultDetailPage({
  params,
}: {
  params: { id: string };
}) {
  await requireOfficerPage();
  const awaitedParams = await params;
  const result = await prisma.rawResultUpload.findUnique({
    where: { id: awaitedParams.id },
    include: {
      uploadedBy: true,
      parseReport: true,
    },
  });

  if (!result) {
    notFound();
  }

  const events = await prisma.event.findMany({
    orderBy: { startsAtUtc: "desc" },
    take: 50,
    select: { id: true, title: true, startsAtUtc: true },
  });

  return (
    <div className="mx-auto max-w-6xl p-8">
      <ResultDetailClient result={result} events={events} />
    </div>
  );
}
