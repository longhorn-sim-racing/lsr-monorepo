import { requireOfficer } from "@/server/auth/guards";
import { getAdminPayments, type PaymentFilters } from "@/server/queries/payments";
import { PaymentsConsole } from "@/components/admin/payments-console";
import { isPaymentKind, isPaymentStatus } from "@/lib/payments";

export const dynamic = "force-dynamic";

const MAX_PAGE = 10_000;

export default async function AdminPaymentsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    await requireOfficer();

    const params = await searchParams;
    const one = (key: string) => {
        const value = params[key];
        return Array.isArray(value) ? value[0] : value;
    };

    const status = one("status");
    const kind = one("kind");
    const page = Number.parseInt(one("page") ?? "", 10);
    const filters: PaymentFilters = {
        status: isPaymentStatus(status) ? status : null,
        kind: isPaymentKind(kind) ? kind : null,
        q: (one("q") ?? "").trim().slice(0, 100),
        page: Number.isInteger(page) && page > 0 ? Math.min(page, MAX_PAGE) : 1,
    };

    const data = await getAdminPayments(filters);

    return (
        <div className="h-full">
            <PaymentsConsole filters={filters} {...data} />
        </div>
    );
}
