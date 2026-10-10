/**
 * Bulk User Provisioning Script
 *
 * Re-provisions all Supabase Auth users into the Prisma User table
 * after the database wipe of 2026-02-04. Mirrors the JIT provisioning
 * logic in src/server/auth/session.ts exactly.
 *
 * Usage:
 *   npx tsx scripts/bulk-provision-users.ts            # dry-run (default)
 *   npx tsx scripts/bulk-provision-users.ts --execute   # actually write
 */

import { prisma } from "../src/server/db";
import { slugify } from "../src/lib/slug";

interface AuthUser {
  id: string;
  email: string;
  raw_user_meta_data: { full_name?: string; displayName?: string; avatar_url?: string; marketingOptIn?: boolean } | null;
}

async function main() {
  const dryRun = !process.argv.includes("--execute");

  if (dryRun) {
    console.log("=== DRY RUN MODE (pass --execute to write) ===\n");
  } else {
    console.log("=== EXECUTE MODE — writing to database ===\n");
  }

  // 1. Fetch all auth users
  const authUsers = await prisma.$queryRawUnsafe<AuthUser[]>(
    'SELECT id, email, raw_user_meta_data FROM auth.users ORDER BY created_at'
  );
  console.log(`Auth users found: ${authUsers.length}`);

  // 2. Fetch existing Prisma users
  const existingUsers = await prisma.user.findMany({ select: { id: true } });
  const existingIds = new Set(existingUsers.map((u) => u.id));
  console.log(`Already provisioned: ${existingIds.size}`);

  const toProvision = authUsers.filter((au) => !existingIds.has(au.id));
  console.log(`To provision: ${toProvision.length}\n`);

  if (toProvision.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const authUser of toProvision) {
    const meta = authUser.raw_user_meta_data ?? {};
    const displayName =
      meta.full_name || meta.displayName || authUser.email.split("@")[0];
    const avatarUrl = meta.avatar_url ?? null;
    const marketingOptIn = meta.marketingOptIn ?? true;

    // Handle generation — mirrors session.ts exactly
    const baseHandle = slugify(displayName);
    let finalHandle = baseHandle;

    if (dryRun) {
      console.log(
        `  [DRY] Would create: ${displayName} <${authUser.email}> → @${baseHandle}`
      );
      created++;
      continue;
    }

    // Execute mode: create in a transaction with double-check guard
    try {
      await prisma.$transaction(async (tx) => {
        // Double-check inside transaction (mirrors JIT)
        const existing = await tx.user.findUnique({
          where: { id: authUser.id },
        });
        if (existing) {
          skipped++;
          console.log(`  [SKIP] Already exists: ${authUser.email}`);
          return;
        }

        if (!authUser.email) {
          throw new Error("Missing email");
        }

        // Handle collision loop
        let counter = 1;
        while (await tx.user.findUnique({ where: { handle: finalHandle } })) {
          finalHandle = `${baseHandle}-${counter}`;
          counter++;
        }

        await tx.user.create({
          data: {
            id: authUser.id,
            email: authUser.email,
            handle: finalHandle,
            displayName,
            avatarUrl,
            status: "active",
            marketingOptIn,
          },
        });

        created++;
        console.log(
          `  [OK] Created: ${displayName} <${authUser.email}> → @${finalHandle}`
        );
      });
    } catch (err) {
      failed++;
      console.error(`  [ERR] Failed for ${authUser.email}:`, err);
    }
  }

  console.log(
    `\nDone. Created: ${created}, Skipped: ${skipped}, Failed: ${failed}`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
