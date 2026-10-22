import { JACK_DECK_SIZES, type JackDeckSizeKey } from "@/lib/jack/decks"

/**
 * The LSR slide kit (#177): the stylesheet every slide renders with, before the deck's own CSS.
 * It's the `.claude/skills/lsr-deck` look as classes, so Jack's slides stay short (fewer output
 * tokens, faster decks) and the chrome is identical on every slide. The design guide
 * (design-guide.ts) documents each class for Jack; keep the two in step.
 *
 * Sizes come from custom properties set per canvas on <html data-size="…">, so the same class looks
 * right on a 1920×1080 slide and on a 1080×1920 story. Social sizes use bigger text (they're read on
 * phones) and the story keeps clear of Instagram's own bars at the top and bottom.
 */

type SizeVars = {
  padX: number
  padTop: number
  padBottom: number
  gap: number
  chromeTop: number
  logoW: number
  logoH: number
  small: number
  body: number
  lead: number
  eyebrow: number
  title: number
  titleXl: number
  stat: number
  statXl: number
  footerBottom: number
}

export const KIT_SIZES: Record<JackDeckSizeKey, SizeVars> = {
  slides: { padX: 128, padTop: 176, padBottom: 160, gap: 36, chromeTop: 60, logoW: 120, logoH: 40, small: 24, body: 24, lead: 34, eyebrow: 24, title: 88, titleXl: 152, stat: 64, statXl: 120, footerBottom: 56 },
  post: { padX: 80, padTop: 184, padBottom: 136, gap: 32, chromeTop: 64, logoW: 132, logoH: 44, small: 26, body: 32, lead: 40, eyebrow: 28, title: 100, titleXl: 136, stat: 96, statXl: 160, footerBottom: 56 },
  story: { padX: 88, padTop: 320, padBottom: 400, gap: 40, chromeTop: 210, logoW: 144, logoH: 48, small: 28, body: 36, lead: 44, eyebrow: 30, title: 112, titleXl: 150, stat: 110, statXl: 180, footerBottom: 300 },
  square: { padX: 80, padTop: 168, padBottom: 120, gap: 28, chromeTop: 60, logoW: 132, logoH: 44, small: 26, body: 30, lead: 38, eyebrow: 26, title: 92, titleXl: 120, stat: 88, statXl: 140, footerBottom: 48 },
}

/** The smallest text each size should have; the render check flags anything below it */
export const MIN_TEXT_PX: Record<JackDeckSizeKey, number> = { slides: 24, post: 26, story: 28, square: 26 }

function sizeRules(): string {
  return (Object.entries(KIT_SIZES) as [JackDeckSizeKey, SizeVars][])
    .map(([size, v]) =>
      `:root[data-size=${size}]{--w:${JACK_DECK_SIZES[size].width}px;--h:${JACK_DECK_SIZES[size].height}px;--pad-x:${v.padX}px;--pad-top:${v.padTop}px;--pad-bottom:${v.padBottom}px;--gap:${v.gap}px;` +
      `--chrome-top:${v.chromeTop}px;--logo-w:${v.logoW}px;--logo-h:${v.logoH}px;--small:${v.small}px;--body:${v.body}px;` +
      `--lead:${v.lead}px;--eyebrow:${v.eyebrow}px;--title:${v.title}px;--title-xl:${v.titleXl}px;--stat:${v.stat}px;` +
      `--stat-xl:${v.statXl}px;--footer-bottom:${v.footerBottom}px}`
    )
    .join("\n")
}

export const KIT_CSS = `
:root{--orange:#FF8000;--charcoal:#1B1B1B;--ground:#FAFAFA;--dark:#0B0B0B;--card-light:#F1F1EF;--card-light-line:#E0E0DD;--card-dark:rgba(11,11,11,0.74);--card-dark-line:rgba(250,250,250,0.16);--display:'Kanit','Arial Black',sans-serif;--sans:'Montserrat',Arial,sans-serif;--track:6px}
${sizeRules()}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:var(--w);height:var(--h);overflow:hidden;background:var(--dark)}
body{font-family:var(--sans);font-size:var(--body);line-height:1.4;color:var(--ground);-webkit-font-smoothing:antialiased}
img,svg{display:block;max-width:none}
ul,ol{padding-left:1.2em}
li+li{margin-top:0.3em}
b,strong{font-weight:800}
.slide{position:relative;width:var(--w);height:var(--h);overflow:hidden;display:flex;flex-direction:column;gap:var(--gap);padding:var(--pad-top) var(--pad-x) var(--pad-bottom);background:var(--dark);color:var(--ground)}
.slide.dark{background:var(--dark);color:var(--ground)}
.slide.light{background:var(--ground);color:var(--charcoal)}
.slide.center{justify-content:center}
.slide.end{justify-content:flex-end}
.slide>*{position:relative;z-index:1}
.slide>.photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
.slide>.scrim{position:absolute;inset:0;z-index:0;background:linear-gradient(90deg,rgba(11,11,11,0.94) 0%,rgba(11,11,11,0.82) 36%,rgba(11,11,11,0.32) 70%,rgba(11,11,11,0.22) 100%),linear-gradient(0deg,rgba(11,11,11,0.94) 0%,rgba(11,11,11,0.12) 52%,rgba(11,11,11,0.45) 100%)}
.slide>.scrim.even{background:linear-gradient(90deg,rgba(11,11,11,0.95) 0%,rgba(11,11,11,0.86) 50%,rgba(11,11,11,0.7) 100%),linear-gradient(0deg,rgba(11,11,11,0.9) 0%,rgba(11,11,11,0.4) 55%,rgba(11,11,11,0.72) 100%)}
.slide>.scrim.bottom{background:linear-gradient(0deg,rgba(11,11,11,0.97) 0%,rgba(11,11,11,0.78) 34%,rgba(11,11,11,0.1) 66%,rgba(11,11,11,0.5) 100%)}
.slide>.chrome{position:absolute;left:var(--pad-x);right:var(--pad-x);top:var(--chrome-top);z-index:2;height:48px;display:flex;align-items:center;font-size:var(--small);font-weight:700;letter-spacing:var(--track);text-transform:uppercase;line-height:1;white-space:nowrap;color:rgba(250,250,250,0.6)}
.chrome::before{content:"";flex:none;width:calc(var(--logo-w) + 24px);height:var(--logo-h);margin-right:24px;padding-right:24px;border-right:2px solid rgba(250,250,250,0.3);background:url(/brand/logos/white_logo.png) left center/contain no-repeat;background-origin:content-box}
.chrome::after{content:"";flex:none;margin-left:auto;width:66px;height:48px;transform:skewX(-20deg);background:linear-gradient(90deg,#FF8000 0 12px,transparent 12px 26px,rgba(255,128,0,0.7) 26px 38px,transparent 38px 52px,rgba(255,128,0,0.4) 52px 64px,transparent 64px)}
.light>.chrome{color:rgba(27,27,27,0.6)}
.light>.chrome::before{border-right-color:rgba(27,27,27,0.25);background-image:url(/brand/logos/black_logo.png)}
.slide>.footer{position:absolute;left:var(--pad-x);right:var(--pad-x);bottom:var(--footer-bottom);z-index:2;display:flex;align-items:center;gap:32px;font-size:var(--small);font-weight:700;letter-spacing:5px;text-transform:uppercase;line-height:1.4;white-space:nowrap;color:rgba(250,250,250,0.5)}
.footer>span{flex:1;display:flex;align-items:center;gap:32px}
.footer>span::after{content:"";flex:1;height:2px;background:linear-gradient(90deg,rgba(255,128,0,0.9) 0%,rgba(255,128,0,0.06) 100%)}
.footer>b{font-family:var(--display);font-style:italic;font-weight:900;font-size:calc(var(--small) * 1.33);letter-spacing:0;color:var(--orange)}
.light>.footer{color:rgba(27,27,27,0.5)}
.eyebrow{font-size:var(--eyebrow);font-weight:800;letter-spacing:var(--track);text-transform:uppercase;line-height:1.4;color:var(--orange)}
.title{font-family:var(--display);font-style:italic;font-weight:900;font-size:var(--title);line-height:1.02;letter-spacing:-1px;text-transform:uppercase}
.title.xl{font-size:var(--title-xl);line-height:0.95;letter-spacing:-2px}
.title::after{content:"";display:block;width:96px;height:6px;margin-top:22px;background:var(--orange)}
.title.xl::after{width:112px;margin-top:28px}
.title.bare::after{display:none}
.o{color:var(--orange)}
.lead{font-size:var(--lead);font-weight:600;line-height:1.35}
.muted{opacity:0.72}
.small{font-size:var(--small)}
.label{font-size:var(--small);font-weight:800;letter-spacing:4px;text-transform:uppercase;line-height:1.4}
.stat{font-family:var(--display);font-style:italic;font-weight:900;font-size:var(--stat);line-height:1.05;text-transform:uppercase;color:var(--orange)}
.stat.xl{font-size:var(--stat-xl);line-height:0.95}
.num{font-family:var(--display);font-style:italic;font-weight:900;font-size:calc(var(--stat) * 0.75);line-height:1;color:var(--orange)}
.pill{display:inline-block;align-self:flex-start;background:var(--orange);color:var(--charcoal);font-size:var(--small);font-weight:800;letter-spacing:4px;text-transform:uppercase;line-height:1.3;padding:6px 16px}
.light .pill{background:var(--charcoal);color:var(--ground)}
.row{display:flex;flex-direction:row;gap:24px}
.col{display:flex;flex-direction:column;gap:12px}
.grid{display:grid;grid-template-columns:repeat(var(--cols,3),minmax(0,1fr));gap:24px}
.grow{flex:1;min-width:0}
.spacer{flex:1}
.card{position:relative;display:flex;flex-direction:column;gap:10px;padding:30px 32px 32px;background:var(--card-dark);border:1px solid var(--card-dark-line)}
.light .card{background:var(--card-light);border-color:var(--card-light-line)}
.card::before{content:"";position:absolute;left:-1px;top:-1px;width:56px;height:4px;background:var(--orange)}
.card.accent{background:var(--orange);border-color:var(--orange);color:var(--charcoal)}
.card.accent::before{background:var(--charcoal)}
.card.accent .stat,.card.accent .num,.card.accent .eyebrow{color:var(--charcoal)}
.card.bare::before{display:none}
.card.row{flex-direction:row}
.list{list-style:none;padding:0;display:flex;flex-direction:column;gap:10px;line-height:1.45}
.list>li{position:relative;padding-left:34px;margin:0}
.list>li::before{content:"";position:absolute;left:0;top:0.62em;width:18px;height:4px;background:var(--orange)}
.table{width:100%;border-collapse:collapse}
.table th{text-align:left;font-size:var(--small);font-weight:800;letter-spacing:3px;text-transform:uppercase;color:var(--orange);padding:0 16px 12px;border-bottom:2px solid var(--orange)}
.table td{padding:14px 16px;border-bottom:1px solid rgba(250,250,250,0.14)}
.light .table td{border-bottom-color:rgba(27,27,27,0.12)}
.table .r{text-align:right}
.cover{width:100%;height:100%;object-fit:cover}
.qr{background:#FFFFFF;padding:16px}
`.trim()
