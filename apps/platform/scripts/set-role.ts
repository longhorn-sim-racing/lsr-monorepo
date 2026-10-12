import { prisma } from "../src/server/db";

/** Finds a user by email, handle or id, whichever the argument looks like. */
async function findUser(who: string) {
  if (who.includes("@")) {
    return prisma.user.findUnique({ where: { email: who.toLowerCase() } });
  }
  return (
    (await prisma.user.findUnique({ where: { handle: who.toLowerCase() } })) ??
    (await prisma.user.findUnique({ where: { id: who } }))
  );
}

async function main() {
  const who = process.argv[2];
  const roleKey = process.argv[3];

  if (!who || !roleKey) {
    console.error("Usage: tsx scripts/set-role.ts <email|handle|userId> <roleKey>");
    console.error("Example: tsx scripts/set-role.ts you@utexas.edu admin");
    process.exit(1);
  }

  const role = await prisma.role.findUnique({
    where: { key: roleKey },
  });

  if (!role) {
    const keys = (await prisma.role.findMany({ select: { key: true } })).map((r) => r.key);
    console.error(`Role with key "${roleKey}" not found. Available roles: ${keys.join(", ")}`);
    process.exit(1);
  }

  const user = await findUser(who);

  if (!user) {
    console.error(`No user found for "${who}". Sign in once so the account exists, then run this again.`);
    process.exit(1);
  }

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    create: { userId: user.id, roleId: role.id },
    update: {},
  });

  console.log(`✅ Role "${roleKey}" added to user ${user.displayName} (${user.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
