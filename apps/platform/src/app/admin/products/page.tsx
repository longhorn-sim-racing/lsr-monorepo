import { requireOfficer } from "@/server/auth/guards";
import { getAllProducts } from "@/server/queries/products";
import { ProductsConsole } from "@/components/admin/products-console";

export const dynamic = "force-dynamic";

export default async function AdminProductsPage() {
    await requireOfficer();
    const products = await getAllProducts();

    return (
        <div className="h-full">
            <ProductsConsole products={products} />
        </div>
    );
}
