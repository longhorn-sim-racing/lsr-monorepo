"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOfficer } from "@/server/auth/guards";
import { createAuditLog } from "@/server/audit/log";
import { productUpdateSchema, type ProductUpdateInput } from "@/schemas/product.schema";
import { applyProductUpdate, ProductUpdateError } from "@/server/services/product.service";

export type UpdateProductResult =
    | { ok: true }
    | { ok: false; error: string; fieldErrors?: Record<string, string[] | undefined> };

// Returns errors instead of throwing: thrown action errors lose their message in production.
export async function updateProduct(id: string, input: ProductUpdateInput): Promise<UpdateProductResult> {
    const user = await requireOfficer();

    const parsed = productUpdateSchema.safeParse(input);
    if (!parsed.success) {
        return { ok: false, error: "Fix the highlighted fields.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
    }

    let result: Awaited<ReturnType<typeof applyProductUpdate>>;
    try {
        result = await applyProductUpdate(id, parsed.data);
    } catch (error) {
        if (error instanceof ProductUpdateError) {
            return {
                ok: false,
                error: error.message,
                fieldErrors: error.field ? { [error.field]: [error.message] } : undefined,
            };
        }
        throw error;
    }

    await createAuditLog({
        actorUserId: user.id,
        actionType: "PRODUCT_UPDATED",
        entityType: "Product",
        entityId: id,
        summary: `Updated product: ${result.after.name}`,
        before: result.before,
        after: result.after,
    });

    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${id}`);
    revalidatePath("/account");
    revalidatePath("/lone-star-cup");
    return { ok: true };
}
