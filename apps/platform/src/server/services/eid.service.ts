import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";

type Db = Prisma.TransactionClient | typeof prisma;

export const EID_TAKEN = "That UT EID is already on another account.";

/** Throws EID_TAKEN when another account already holds this EID. */
export async function assertEidAvailable(db: Db, eid: string, userId: string) {
  const owner = await db.user.findUnique({ where: { eid }, select: { id: true } });
  if (owner && owner.id !== userId) throw new Error(EID_TAKEN);
}

/**
 * Sets or clears a user's UT EID. Returns "taken" when another account has it, including when
 * two saves race for the same EID and the unique index catches the second.
 */
export async function setUserEid(userId: string, eid: string | null, db: Db = prisma): Promise<"ok" | "taken"> {
  try {
    if (eid) await assertEidAvailable(db, eid, userId);
    await db.user.update({ where: { id: userId }, data: { eid } });
    return "ok";
  } catch (error) {
    if (error instanceof Error && error.message === EID_TAKEN) return "taken";
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "taken";
    throw error;
  }
}
