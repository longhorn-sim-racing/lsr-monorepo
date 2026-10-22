import type { JackDeckSizeKey } from "@/lib/jack/decks"

/**
 * Working slides in the LSR look (#177), built from the kit classes (kit-css.ts). The design guide
 * gives them to Jack to copy and adapt, and scripts/check-jack-render.ts renders every one, so a kit
 * change that breaks a template shows up there. Bracketed text is a placeholder.
 */

export type SlideTemplate = { name: string; size: JackDeckSizeKey; use: string; html: string }

export const SLIDE_TEMPLATES: SlideTemplate[] = [
  {
    name: "cover",
    size: "slides",
    use: "Opening slide: full-bleed photo, a pill and a meta line, the big title, one line on what it's for",
    html: `<section class="slide dark end">
<img class="photo" src="/images/gal_03.jpeg" alt="">
<div class="scrim"></div>
<header class="chrome">Longhorn Sim Racing</header>
<div class="row" style="align-items:center">
<p class="pill">[General Meeting]</p>
<p class="label muted">[Mon 10/26 · 6 PM · Alienware Lounge]</p>
</div>
<h1 class="title xl">[General]<br><span class="o">[Meeting 2]</span></h1>
<p class="lead" style="max-width:1100px">[One line on what tonight is for.]</p>
</section>`,
  },
  {
    name: "section",
    size: "slides",
    use: "A section divider or a single statement over a photo",
    html: `<section class="slide dark center">
<img class="photo" src="/images/liveries/nurburgring-dusk.webp" alt="">
<div class="scrim"></div>
<header class="chrome">Longhorn Sim Racing</header>
<p class="eyebrow">[Part two]</p>
<h2 class="title xl" style="max-width:1300px">[The <span class="o">season</span> ahead]</h2>
<p class="lead muted" style="max-width:1000px">[One sentence that sets up the section.]</p>
<footer class="footer"><span>[Deck name]</span><b>[02]</b></footer>
</section>`,
  },
  {
    name: "stats",
    size: "slides",
    use: "Photo slide with three big-number cards and two short lists",
    html: `<section class="slide dark">
<img class="photo" src="/images/gal_04.jpeg" alt="">
<div class="scrim even"></div>
<header class="chrome">Longhorn Sim Racing</header>
<div class="col" style="gap:14px">
<p class="eyebrow">[Season so far]</p>
<h2 class="title">[By the <span class="o">numbers</span>]</h2>
</div>
<div class="row">
<div class="card grow"><p class="stat">[42]</p><p class="label">[Members]</p><p class="muted">[One line of context.]</p></div>
<div class="card grow"><p class="stat">[6]</p><p class="label">[Races run]</p><p class="muted">[One line of context.]</p></div>
<div class="card grow"><p class="stat">[$0]</p><p class="label">[Dues]</p><p class="muted">[One line of context.]</p></div>
</div>
<div class="row" style="gap:48px">
<div class="col grow"><p class="label o">[What went well]</p><ul class="list"><li>[One line, about 45 characters]</li><li>[Item]</li><li>[Item]</li></ul></div>
<div class="col grow"><p class="label o">[What's next]</p><ul class="list"><li>[Item]</li><li>[Item]</li><li>[Item]</li></ul></div>
</div>
<footer class="footer"><span>[Deck name]</span><b>[03]</b></footer>
</section>`,
  },
  {
    name: "grid",
    size: "slides",
    use: "Light slide with six numbered cards, one of them the orange accent",
    html: `<section class="slide light">
<header class="chrome">Longhorn Sim Racing</header>
<div class="col" style="gap:14px">
<p class="eyebrow">[This semester]</p>
<h2 class="title">[What we're <span class="o">building</span>]</h2>
</div>
<div class="grid">
<div class="card"><p class="num">01</p><p class="label">[Title]</p><p class="muted">[One or two short lines.]</p></div>
<div class="card"><p class="num">02</p><p class="label">[Title]</p><p class="muted">[One or two short lines.]</p></div>
<div class="card accent"><p class="num">03</p><p class="label">[The one that matters most]</p><p>[One or two short lines.]</p></div>
<div class="card"><p class="num">04</p><p class="label">[Title]</p><p class="muted">[One or two short lines.]</p></div>
<div class="card"><p class="num">05</p><p class="label">[Title]</p><p class="muted">[One or two short lines.]</p></div>
<div class="card"><p class="num">06</p><p class="label">[Title]</p><p class="muted">[One or two short lines.]</p></div>
</div>
<footer class="footer"><span>[Deck name]</span><b>[04]</b></footer>
</section>`,
  },
  {
    name: "two-cards",
    size: "slides",
    use: "Photo slide with two large cards (two projects, two options, before and after)",
    html: `<section class="slide dark">
<img class="photo" src="/images/gal_05.JPG" alt="">
<div class="scrim even"></div>
<header class="chrome">Longhorn Sim Racing</header>
<div class="col" style="gap:14px">
<p class="eyebrow">[Two big things]</p>
<h2 class="title">[The <span class="o">plan</span>]</h2>
</div>
<div class="row" style="flex:1;min-height:0">
<div class="card grow" style="gap:16px"><p class="pill">[Owner]</p><p class="label" style="font-size:32px;letter-spacing:3px">[Project one]</p><ul class="list"><li>[Step]</li><li>[Step]</li><li>[Step]</li></ul><p class="muted" style="margin-top:auto">[Done when: …]</p></div>
<div class="card grow" style="gap:16px"><p class="pill">[Owner]</p><p class="label" style="font-size:32px;letter-spacing:3px">[Project two]</p><ul class="list"><li>[Step]</li><li>[Step]</li><li>[Step]</li></ul><p class="muted" style="margin-top:auto">[Done when: …]</p></div>
</div>
<footer class="footer"><span>[Deck name]</span><b>[05]</b></footer>
</section>`,
  },
  {
    name: "table",
    size: "slides",
    use: "Light slide with a table (standings, schedules, who owns what)",
    html: `<section class="slide light">
<header class="chrome">Longhorn Sim Racing</header>
<div class="col" style="gap:14px">
<p class="eyebrow">[Lone Star Cup]</p>
<h2 class="title">[The <span class="o">standings</span>]</h2>
</div>
<table class="table">
<tr><th>[Pos]</th><th>[Driver]</th><th>[Team]</th><th class="r">[Points]</th></tr>
<tr><td><b class="o">1</b></td><td>[Name]</td><td>[Team]</td><td class="r">[125]</td></tr>
<tr><td><b class="o">2</b></td><td>[Name]</td><td>[Team]</td><td class="r">[110]</td></tr>
<tr><td><b class="o">3</b></td><td>[Name]</td><td>[Team]</td><td class="r">[96]</td></tr>
<tr><td>4</td><td>[Name]</td><td>[Team]</td><td class="r">[80]</td></tr>
<tr><td>5</td><td>[Name]</td><td>[Team]</td><td class="r">[71]</td></tr>
</table>
<footer class="footer"><span>[Deck name]</span><b>[06]</b></footer>
</section>`,
  },
  {
    name: "split",
    size: "slides",
    use: "Light slide with text on the left and a photo filling the right side",
    html: `<section class="slide light" style="padding-right:1000px">
<img src="/images/liveries/le-mans-amg.webp" alt="" style="position:absolute;right:0;top:0;width:880px;height:1080px;object-fit:cover;z-index:0">
<header class="chrome" style="right:1008px">Longhorn Sim Racing</header>
<div class="col" style="gap:14px">
<p class="eyebrow">[Spotlight]</p>
<h2 class="title">[Our <span class="o">liveries</span>]</h2>
</div>
<p class="lead">[Two or three sentences about the photo's subject.]</p>
<ul class="list"><li>[Point]</li><li>[Point]</li><li>[Point]</li></ul>
<footer class="footer" style="right:1008px"><span>[Deck name]</span><b>[07]</b></footer>
</section>`,
  },
  {
    name: "wrap",
    size: "slides",
    use: "Closing slide: what to do next, with a portrait photo panel on the right",
    html: `<section class="slide dark end" style="padding-right:880px">
<img src="/images/gal_08.jpeg" alt="" style="position:absolute;right:0;top:0;width:760px;height:1080px;object-fit:cover;z-index:0">
<div style="position:absolute;right:0;top:0;width:760px;height:1080px;z-index:0;background:linear-gradient(90deg,#0B0B0B 0%,rgba(11,11,11,0) 40%)"></div>
<header class="chrome" style="right:888px">Longhorn Sim Racing</header>
<p class="eyebrow">[See you there]</p>
<h2 class="title xl">[Thanks <span class="o">all</span>]</h2>
<ul class="list"><li>[Next meeting: day, time, place]</li><li>[One thing to do this week]</li><li>[Where to ask questions]</li></ul>
<div class="row" style="align-items:center;gap:28px">
<img class="qr" src="https://jack.assets/qr?text=https%3A%2F%2Fwww.longhornsimracing.org" alt="" style="width:180px;height:180px">
<p class="label">[Scan for the site]<br><span class="muted">longhornsimracing.org</span></p>
</div>
</section>`,
  },
  {
    name: "event-post",
    size: "post",
    use: "Instagram post promoting an event: photo, date pill, big title, one line, QR code",
    html: `<section class="slide dark end">
<img class="photo" src="/images/lsr-hero.webp" alt="">
<div class="scrim bottom"></div>
<header class="chrome">Longhorn Sim Racing</header>
<p class="pill">[Mon Oct 26 · 6 PM]</p>
<h1 class="title xl">[General]<br><span class="o">[Meeting 2]</span></h1>
<p class="lead">[Alienware Gaming Lounge. One short line on why to come.]</p>
<div class="row" style="align-items:center;gap:28px">
<img class="qr" src="https://jack.assets/qr?text=https%3A%2F%2Fwww.longhornsimracing.org%2Fevents" alt="" style="width:190px;height:190px">
<p class="label">[Scan to RSVP]<br><span class="muted">longhornsimracing.org</span></p>
</div>
</section>`,
  },
  {
    name: "announcement-story",
    size: "story",
    use: "Instagram story announcing something, with a call to action",
    html: `<section class="slide dark center">
<img class="photo" src="/images/liveries/daytona-grid-pair.webp" alt="">
<div class="scrim even"></div>
<header class="chrome">Longhorn Sim Racing</header>
<p class="eyebrow">[Applications open]</p>
<h1 class="title xl">[Join the <span class="o">team</span>]</h1>
<p class="lead">[Two short lines on who should apply and what they'll do.]</p>
<p class="pill" style="font-size:34px;padding:12px 24px">[Apply by Fri 10/31]</p>
<img class="qr" src="https://jack.assets/qr?text=https%3A%2F%2Fwww.longhornsimracing.org%2Fapply" alt="" style="width:260px;height:260px">
</section>`,
  },
  {
    name: "results-square",
    size: "square",
    use: "Square post with race results: the top three as cards",
    html: `<section class="slide dark">
<img class="photo" src="/images/liveries/watkins-glen-turn-5.webp" alt="">
<div class="scrim even"></div>
<header class="chrome">[LSC Season 3]</header>
<div class="col" style="gap:12px">
<p class="eyebrow">[Round 6 · Watkins Glen]</p>
<h1 class="title">[Race <span class="o">results</span>]</h1>
</div>
<div class="col" style="gap:16px">
<div class="card row" style="align-items:center;gap:28px;padding:20px 28px"><p class="num" style="width:92px">P1</p><div class="col" style="gap:0"><p class="label">[Driver name]</p><p class="muted">[25 points]</p></div></div>
<div class="card row" style="align-items:center;gap:28px;padding:20px 28px"><p class="num" style="width:92px">P2</p><div class="col" style="gap:0"><p class="label">[Driver name]</p><p class="muted">[18 points]</p></div></div>
<div class="card row" style="align-items:center;gap:28px;padding:20px 28px"><p class="num" style="width:92px">P3</p><div class="col" style="gap:0"><p class="label">[Driver name]</p><p class="muted">[15 points]</p></div></div>
</div>
</section>`,
  },
]
