---
name: lsr-deck
description: Build Longhorn Sim Racing slide decks (Tech Team weeklies, board and GM slides) in the LSR brand look, as a Slides artifact. Use whenever someone asks for LSR slides, a meeting deck, or a presentation for the club.
---

# LSR slide decks

Every LSR deck uses one look: Kanit and Montserrat, burnt orange on charcoal, real photos of the club's cars and members, alternating dark photo slides with light slides. The templates in `templates/` are working slides in that look; copy them and replace the bracketed text.

The brand belongs to the Media team. Never swap in other fonts, colors or stock photos.

## Workflow

1. **Start the deck.** Run the Artifact tool's `quickstart` with intent `slides`, then create a new deck from the Slides type it returns. Title it like `Tech Team Weekly — 10/5`.
2. **Bring in the images.**
   - If you can open an earlier LSR deck, copy its uploaded assets server-side (Artifact `publish` with `asset: true`, `from_url` and `asset_ids` from a `scope: "assets"` listing of it). Nothing is re-uploaded.
   - Otherwise run `python .claude/skills/lsr-deck/prepare_photos.py <out-dir>`, which resizes the photos below to 2400px JPEGs and copies the two logos, and upload everything it writes (six photos, two logos).
   - Either way, use each image's returned `/_blob/<id>` url exactly as given, in place of the `{{…}}` tokens in the templates. Each token is named after the file `prepare_photos.py` writes, such as `{{lsr-white.png}}` or `{{pit-porsche.jpg}}`.
3. **Write the files** in a scratch folder: `project/deck.json` first (start from `templates/deck.json`), then one `project/slides/<id>.html` per slide.
4. **Publish** the index and cover first, then the remaining slides a few per call.
5. **Hand over the link**, and say what you assumed and which blanks (`[pick tonight]`, owners, dates) the presenter fills in live.

## Brand tokens

| Token | Value | Use |
|---|---|---|
| Orange | `#FF8000` | Accent: eyebrows, numbers, one key word per title, rules, ticks |
| Charcoal | `#1B1B1B` | Text on light slides, dark pills and bars |
| Ground | `#FAFAFA` | Light slide background, text on dark |
| Dark | `#0B0B0B` | Dark slide background and photo scrims |
| Light card | `#F1F1EF` with `1px solid #E0E0DD` | Cards on light slides |
| Dark card | `rgba(11,11,11,0.72–0.76)` with `1px solid rgba(250,250,250,0.16)` | Cards over photos |

Fonts, declared in `deck.json` `faces` from Google Fonts: **Kanit** italic 800/900 for titles and numbers, **Montserrat** 400–800 for everything else.

## Type

- Title: Kanit 900 italic, uppercase, 88px, one word wrapped in an orange `<span>`, then a 96×6px orange rule. The cover title is 152px with a 112×6px rule.
- Eyebrow above the title: Montserrat 800, 24px, uppercase, `letter-spacing:6px`, orange.
- Card labels: 24–26px, 800, uppercase, tracked. Big numbers: Kanit italic, orange.
- Body: 24px, never smaller. Muted text is the base color at 0.62–0.86 opacity, not grey.

## Chrome on every slide

- LSR logo top-left (120×40 at left 128, top 64), a 2px divider, then "Longhorn Sim Racing" as a tracked wordmark. White logo on dark slides, black on light.
- Three skewed orange bars top-right (`skewX(-20deg)`, opacity 1 / 0.7 / 0.4).
- Footer at `bottom:56px`: tracked deck name, a 2px orange-to-transparent rule (`flex:1`), the page number in Kanit. The cover has no footer; its run-of-show strip sits there instead.
- Optional time pill top-right under the bars (`8:05 · 10 min`): orange on dark slides, charcoal on light.
- Cards carry a 56×4px orange tick pinned to their top-left corner.

The templates already contain all of this; keep it identical across slides so nothing jumps between them.

## Rhythm and layout

- Open and close dark. In between, alternate dark photo slides (full-bleed photo plus two scrim gradients, 90deg and 0deg) with light `#FAFAFA` slides, never more than two of a kind in a row, and don't reuse a photo on back-to-back slides.
- Content slides use `padding:176px 128px 160px`, which leaves about 744px of height. The title block takes about 158px.
- Size cards to their text (three lines of 24px at most) and never give them fixed heights. If a slide runs out of room, split it or move detail to the speaker notes; don't shrink text.
- At most one orange accent card per light slide.

## Photos

All from `apps/platform/public/images`:

| File | Shows | Good for |
|---|---|---|
| `lsr-hero.webp` | The orange Mercedes GT3 on the grid | Cover, statement slides |
| `gal_03.jpeg` | The Porsche at night | Cover |
| `gal_04.jpeg` | The Porsche in a night pit stop | Recap and stats slides |
| `gal_05.JPG` | The orange Mercedes in the pits at night | Work and plan slides |
| `gal_11.jpg` | Race cars parked in a garage | Parking lot, "next" slides |
| `gal_08.jpeg` | Members at the sim rigs (portrait) | The wrap slide's right-hand panel |

Photos are `object-fit:cover`. Use only club photos, never stock images.

## Content rules

- Ground every number and claim in a real source (the database, GitHub, Teams posts, meeting notes), and cite it in the speaker notes.
- Speaker notes go in one `<aside>`, the section's last child. Anyone with the link can read them, so keep secrets, credentials and anything sensitive out of slides and notes alike. Describe security problems neutrally ("a key needs rotating").
- One idea per slide. Prefer stat cards, numbered grids and tables over bullet walls.
- Leave owners and dates the room decides as visible blanks, e.g. `[pick tonight]`.

## Pitfalls

- `padding` values above 256px make the slide format drop the whole rule.
- `gap` takes a single value.
- No classes, no `<style>`, no `margin`; every style is inline.
- Full-bleed backdrops (photo, scrims) come first in the section, or they paint over the text.
- Never put a `data:` URI or an outside URL in `<img src>`; only `/_blob/<id>` urls from the upload or copy.

## Templates

| File | Slide |
|---|---|
| `templates/deck.json` | The index: title, order, sections, the two font faces |
| `templates/cover.html` | Dark cover with the run-of-show strip |
| `templates/dark-stats.html` | Photo slide: three big-number cards and two lists |
| `templates/light-grid.html` | Light slide: 3×2 numbered cards with one accent card |
| `templates/decide.html` | Light slide: numbered two-column decision grid |
| `templates/dark-two-cards.html` | Photo slide: two large project cards with owner, list and "done when" |
| `templates/wrap.html` | Dark close with a portrait photo panel on the right |

Exports: the deck's **Share › Export** menu downloads PDF or PPTX.
