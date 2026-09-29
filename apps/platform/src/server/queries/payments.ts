import type { PaymentStatus, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import type { PaymentKind } from "@/lib/payments";

export const PAYMENTS_PAGE_SIZE = 50;

export type PaymentFilters = {
  status: PaymentStatus | null;
  kind: PaymentKind | null;
  q: string;
  page: number;
};

const KIND_WHERE: Record<PaymentKind, Prisma.PaymentWhereInput> = {
  dues: { product: { type: "ANNUAL_DUES" } },
  league: { product: { type: "LEAGUE_FEE" } },
  event: {
    OR: [
      { productId: null },
      { product: { type: "EVENT_FEE" } },
      { eventRegistration: { isNot: null } },
    ],
  },
};

function paymentsWhere({ status, kind, q }: PaymentFilters): Prisma.PaymentWhereInput {
  const and: Prisma.PaymentWhereInput[] = [];
  if (status) and.push({ status });
  if (kind) and.push(KIND_WHERE[kind]);
  if (q) {
    and.push({
      user: {
        OR: [
          { displayName: { contains: q, mode: "insensitive" } },
          { handle: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
    });
  }
  return { AND: and };
}

export async function getAdminPayments(filters: PaymentFilters) {
  const where = paymentsWhere(filters);

  const [payments, total, succeeded] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (filters.page - 1) * PAYMENTS_PAGE_SIZE,
      take: PAYMENTS_PAGE_SIZE,
      include: {
        user: { select: { displayName: true, handle: true, email: true } },
        product: { select: { name: true, type: true } },
        eventRegistration: { select: { event: { select: { title: true, slug: true } } } },
      },
    }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({
      where: { AND: [where, { status: "succeeded" }] },
      _count: true,
      _sum: { amountCents: true },
    }),
  ]);

  return {
    payments,
    total,
    succeededCount: succeeded._count,
    succeededCents: succeeded._sum.amountCents ?? 0,
    pageCount: Math.max(1, Math.ceil(total / PAYMENTS_PAGE_SIZE)),
  };
}

export type AdminPayment = Awaited<ReturnType<typeof getAdminPayments>>["payments"][number];
