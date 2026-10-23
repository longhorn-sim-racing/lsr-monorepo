import { JACK_DECK_SIZES, type JackDeckSizeKey } from "@/lib/jack/decks"
import { KIT_SIZES, MIN_TEXT_PX } from "./kit-css"
import { SLIDE_TEMPLATES } from "./templates"

/**
 * The LSR design guide Jack reads before making slides (#177): how slides work, the brand, the kit's
 * classes (kit-css.ts), layout numbers per size, and the templates (templates.ts). The deck_guide tool
 * returns it, so the system prompt stays small. Built from the kit's own numbers so the two can't drift.
 *
 * It's adapted from .claude/skills/lsr-deck (the recipe behind the club's GM and Tech Team decks).
 * The brand belongs to the Media team.
 */

function sizeLine(size: JackDeckSizeKey): string {
  const { width, height, label } = JACK_DECK_SIZES[size]
  const k = KIT_SIZES[size]
  const usable = height - k.padTop - k.padBottom
  return `- ${size} (${label}, ${width}×${height}): padding ${k.padTop}px top, ${k.padX}px sides, ${k.padBottom}px bottom, so about ${usable}px of height for content. Title ${k.title}px (xl ${k.titleXl}px), body ${k.body}px, lead ${k.lead}px, stat ${k.stat}px. Minimum text ${MIN_TEXT_PX[size]}px.`
}

const templates = SLIDE_TEMPLATES.map((t) => `### ${t.name} (${t.size}): ${t.use}\n\`\`\`html\n${t.html}\n\`\`\``).join("\n\n")

export const DESIGN_GUIDE = `# LSR slide kit

## How slides work
- A deck is slides at one canvas size. Each slide is HTML: one root \`<section class="slide dark">\` (or \`light\`). Its children stack top to bottom (a flex column with the size's padding and gap); \`end\` pushes them to the bottom, \`center\` to the middle.
- Every slide renders with the kit stylesheet below, then the deck's CSS (deck_write \`css\`), then the slide. Put classes you reuse across slides in the deck CSS; use inline styles for one-offs. A \`<style>\` inside a slide only affects that slide.
- No JavaScript. Fonts: only Kanit and Montserrat load. No emoji (they render as empty boxes); use plain text, or an inline \`<svg>\` for a simple icon.
- Images load only from: the club site (relative paths from deck_assets, like /images/lsr-hero.webp), club photos on res.cloudinary.com (from deck_assets), photos officers posted in this room (https://jack.assets/room/<file id>, listed by deck_assets and room_files; they load only in this room's decks), QR codes from https://jack.assets/qr?text=<URL-encoded link>, and screenshots of the site from deck_screenshot. Never invent an image URL or use one from elsewhere; it's blocked.
- Officers' own photos are welcome on slides when they ask for them or they fit: frame them with object-fit: cover and a scrim for text, as with the club's photos.
- After each write you get the layout checks (cut-off or overlapping text, text too small, wrong fonts, images that didn't load). Fix every one unless it's deliberate. Then deck_render the slides and look at them before you call the work done.

## Brand
- The look: burnt orange on charcoal, Kanit italic for display, Montserrat for text, and real photos of the club's cars and members. The Media team owns the brand: no other fonts or colors, no stock-style art, no clip art, no gradients beyond the photo scrims.
- Colors: orange #FF8000 (var(--orange)): eyebrows, numbers, one key word per title, rules and ticks. Charcoal #1B1B1B (var(--charcoal)): text on light slides. Ground #FAFAFA (var(--ground)): light backgrounds, text on dark. Dark #0B0B0B (var(--dark)): dark backgrounds and scrims.
- One orange word or phrase per title (\`<span class="o">\`). At most one orange accent card per slide.
- Muted text is the same color at lower opacity (\`muted\`), never grey.
- Never shrink text below the size's minimum to make things fit: cut words, or split the slide.

## Kit classes
Slide and backdrop:
- \`slide dark\` / \`slide light\`: the root. Add \`end\` (content at the bottom) or \`center\`.
- \`<img class="photo" src="…" alt="">\` then \`<div class="scrim"></div>\`: a full-bleed photo and its shade, first inside the slide. Scrim variants: plain (dark on the left and bottom; text on the left), \`scrim even\` (text anywhere), \`scrim bottom\` (text at the bottom; posts and stories).
- \`<header class="chrome">Longhorn Sim Racing</header>\`: the logo, divider, wordmark and the three orange bars. Every slide has it, identical. The text may change (e.g. "LSC Season 3").
- \`<footer class="footer"><span>Deck name</span><b>02</b></footer>\`: deck name, orange rule, page number. Every deck slide except the cover. Not on single graphics.
Type:
- \`eyebrow\`: small orange uppercase line above a title.
- \`title\`: Kanit italic uppercase with the orange rule under it (\`title xl\` for covers and statements, \`title bare\` without the rule). Use h1 on covers, h2 elsewhere.
- \`o\` (orange text), \`lead\` (a bigger line of text), \`muted\`, \`small\`, \`label\` (bold tracked uppercase), \`stat\` (a big orange number; \`stat xl\`), \`num\` (an orange card number like 01), \`pill\` (an orange tag; charcoal on light slides).
Layout and blocks:
- \`row\` (side by side, 24px gap), \`col\` (stacked, 12px gap), \`grid\` (3 equal columns; set \`style="--cols:2"\` or 4), \`grow\` (take the free width), \`spacer\` (push what follows to the end).
- \`card\`: a panel with the orange tick, dark or light to match the slide; \`card accent\` is solid orange (one per slide); \`card bare\` has no tick; \`card row\` lays its contents side by side.
- \`list\` on a ul: orange-dash bullets. One line each, five at most.
- \`table\` with \`th\`/\`td\` (\`r\` aligns a cell right). Under ten rows.
- \`cover\` on an img: fill its box. \`qr\` on a QR img: white backing; make it at least 180px.

## Sizes and layout numbers
${(Object.keys(JACK_DECK_SIZES) as JackDeckSizeKey[]).map(sizeLine).join("\n")}
- A title block (eyebrow, title, rule) takes about ${KIT_SIZES.slides.title + 70}px on 16:9 slides. Cards hold at most three lines of text each; never give them fixed heights.
- Stories: Instagram covers about 250px at the top and 350px at the bottom; the kit's padding keeps text out of those bands. Posts and squares are seen small on phones: few words, big type.

## Decks
- One idea per slide. Prefer stat cards, numbered grids and tables over walls of bullets.
- Open and close on dark photo slides. In between, alternate dark photo slides with light ones, never more than two of a kind in a row, and don't use the same photo on neighboring slides.
- Speaker notes go in a slide's \`notes\`, not on the slide. Ground every number in the data (use the club data tools first) and say in the notes where it came from.
- Leave anything the officers decide as a visible blank, like [pick tonight].

## Social graphics
- A post, story or square is one slide, or a few for a carousel (number them in the chrome or a pill, e.g. "1/4").
- One message: an eyebrow, a title, a line or two, one call to action (a date pill, a link and a QR code).
- Use a bright photo with \`scrim bottom\` and keep the text at the bottom (\`slide dark end\`), or \`scrim even\` and center it.

## Photos
- deck_assets lists the club's photos and logos with what each shows. Use action and people shots for events and recruiting, livery renders for racing and the LSC, logos for sponsor slides.
- Photos fill their box (\`object-fit:cover\`). A portrait photo works as a side panel (see the wrap template).
- On posts and stories, let the photo show: a bright photo, \`scrim bottom\`, and the text at the bottom (\`slide dark end\`). A photo shaded almost to black wastes it.
- To show a feature of the club site, take a deck_screenshot and frame it (a card with a thin border and a soft shadow, or a phone outline) beside the text that explains it.

## Templates
Copy one, replace the bracketed text, and adapt freely: add or drop cards, change the photo, rebalance. The cover, stats and grid templates are the core of most decks.

${templates}

## Before you finish
- No layout problems left in the checks, or the ones left are on purpose.
- You rendered and looked at every slide you changed, at least once.
- Numbers, dates and names came from the tools.
- Tell the officers what you made, link the deck, and say what they should fill in or check.`
