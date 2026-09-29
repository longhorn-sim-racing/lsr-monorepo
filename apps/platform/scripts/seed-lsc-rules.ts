/**
 * Creates the Lone Star Cup rules page (/lone-star-cup/rules) as a DRAFT that only
 * officers can see, from Competition's "LSC Schedule 2026 Fall" doc. The comp team
 * settles the open questions, edits it in /admin/pages, and publishes it there.
 *
 * Does nothing if the page already exists. Dry run by default.
 *
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/seed-lsc-rules.ts
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/seed-lsc-rules.ts --apply
 *
 * Reads no .env file; DIRECT_URL is preferred over DATABASE_URL when both are set.
 */
export {}; // a module, so these names don't clash with other scripts

const APPLY = process.argv.includes("--apply");

if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL (or DIRECT_URL) must be set in the environment. No .env file is read.");
  process.exit(1);
}
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const DRAFT = `# Lone Star Cup Rules

_Season 3 · Fall 2026_

> **Draft for the comp team. Settle these, then delete this box and publish:**
> - **Setup:** the general notes say only ABS, TC and brake bias can change, but Section 0 also allows the wing level. Which is it?
> - **Pit stops:** are they mandatory? The notes say "I would like mandatory pitstops."
> - **Damage:** the notes say "lightly enabled (if possible, if not just enabled)." What's the final setting?

## Race day

- Races are on Saturdays at 10am Central. The full schedule is on the Lone Star Cup page.
- Each round is 30 minutes of practice, 10 minutes of qualifying, then a 30 minute race.
- Practice happens on race day only. There's no practicing the track before the event.
- The car is the Mustang GT4. Round 7 at Mount Panorama is a Halloween night race in the Mustang Supercar.
- Fuel use (110%) and tire wear are turned up so pit strategy matters.

## Points

- Final standings are decided by points across the season, F1 style.
- Standings are posted on the site after each round.

## Section 0: Car setup

Setups are closed. The only things you may change are the **wing level, traction control (TC), ABS and brake bias**.

If you're found changing any other part of the setup, you'll get a warning and may be disqualified from that event, including losing its points.

## Section 1: Practice

1. Drive with respect toward each other, on track and off.
2. Take practice seriously. We want this to be a welcoming community for learning and gaining experience.
3. Intentionally wrecking in practice leads to warnings before the race, or to losing access to races and practice sessions.
4. Follow the race rules in practice, just as you would in a race.
5. If race control decides a driver isn't following the rules or isn't race ready, that driver won't be allowed to start, or will start from the back of the field.

## Section 2: Qualifying

1. Setting a lap before the race is optional.
2. Track limits are lenient but enforced, and race control may void laps.
3. Qualifying is open for the whole season, so respect each other's space. If you're shown blue flags and the drivers behind you are on fast laps, let them by. And vice versa. **Drive with respect.**

## Section 3: Race

1. Drive with **respect**.
2. Retaliation is **not tolerated**. Retaliating during a race gets your car disqualified from that event, with a possible post-race penalty.
3. You may **not** leave the track to make a pass. If you pass below the racing surface (defined by race control in the drivers' meeting), you **must** give the position back within a lap. If you don't, you'll get a drive-through penalty.

## Incidents and penalties

- Report incidents in the incident reporting channel on Discord.
- Race control gives warnings and penalties as it sees fit.
- If you spot a problem with a track or the track UI, tell the comp team and they'll fix it as soon as they can.

## Entry

Entry is $10 for new drivers and $5 for returning drivers, and covers both the Lone Star Cup and the Formula Sunday League.
`;

async function main() {
  const { prisma } = await import("../src/server/db");
  const slug = "lone-star-cup-rules";

  const existing = await prisma.page.findUnique({ where: { slug }, select: { id: true, visibility: true } });
  if (existing) {
    console.log(`page ${slug} already exists (${existing.visibility}); nothing to do.`);
  } else if (!APPLY) {
    console.log(`would create page ${slug} as a draft (officers only), ${DRAFT.length} characters.\nDry run. Re-run with --apply to write.`);
  } else {
    await prisma.page.create({ data: { slug, title: "Lone Star Cup Rules", bodyMd: DRAFT, visibility: "officers" } });
    console.log(`created ${slug} as a draft. Review and publish it in /admin/pages.`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
