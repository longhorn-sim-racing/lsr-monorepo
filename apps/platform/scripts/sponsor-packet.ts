/**
 * Render the sponsor packet, public/SPONSOR_BENEFITS.pdf, which /sponsors links to.
 *
 *   pnpm --filter @lsr/platform sponsor-packet [--html]
 *
 * Page 1 is the pitch, page 2 the benefits sheet. The tiers come from src/app/sponsors/tiers.ts
 * and the partners from src/lib/sponsors.ts, so the packet always matches the website; edit
 * those, not this file, when a package or sponsor changes. The numbers in STATS are typed in by
 * hand: check them against the live About page before re-rendering.
 *
 * Prints with a local Chrome or Edge in headless mode (set CHROME_PATH if it isn't found).
 * Fonts and event photos load from Google Fonts and Cloudinary, so it needs a network
 * connection. --html only writes the HTML to a temp folder and prints its path, for
 * previewing in a browser.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import QRCode from "qrcode";
import { TIERS } from "../src/app/sponsors/tiers";
import { SPONSORS } from "../src/lib/sponsors";

const ROOT = resolve(__dirname, "..");
const PUBLIC = join(ROOT, "public");
const OUT = join(PUBLIC, "SPONSOR_BENEFITS.pdf");

const OUTREACH_EMAIL = "outreach@longhornsimracing.org";
const VENMO_URL = "https://www.paypal.com/qrcodes/venmocs/e3fd69ab-c345-4b53-add6-4f8037a4760d?created=1767404952.8381681&printed=1";
const CLOUD = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ?? "daklxjoxr";

// Rounded down from the About page's live counts (2026-10-08: 105 members, 47 events)
const STATS = [
  { value: "2024", label: "Founded" },
  { value: "100+", label: "Members" },
  { value: "45+", label: "Events hosted" },
  { value: "S3", label: "Lone Star Cup season" },
];

// The Business team's pitch, as on /sponsors
const VALUES = [
  {
    title: "Return on Investment",
    body: "LSR sponsors should expect to be able to see the impact of their contribution, so our board of directors takes care that your impact is well documented.",
  },
  {
    title: "University of Texas Excellence",
    body: "As students at UT, we strive to be the best and the brightest. By sponsoring LSR, you’re empowering students who are dedicated to greatness.",
  },
  {
    title: "Motorsports Democratization",
    body: "Since its inception, racing has never been an affordable endeavor; however, the excessive price of entry and enjoyment has fragmented the enthusiast community. Sponsoring LSR reduces the gap between the audience and the track through meaningful volunteering and industry exposure.",
  },
];

const STEPS = [
  { title: "Conversation", body: "We discuss your goals and alignment with our mission." },
  { title: "Selection", body: "Choose a partnership level." },
  { title: "Agreement", body: "Tax documentation and formal contract." },
  { title: "Engagement", body: "Branding integration and sponsorship activation." },
];

const EVENTS = [
  { title: "WEC at COTA", date: "Sep 2025", photo: "gallery/wec-at-cota-2025/dsc09724" },
  { title: "F1 Weekend Fan Zone", date: "Oct 2025", photo: "gallery/f1-weekend-fan-zone/img-1771" },
  { title: "Race Club Austin", date: "Nov 2025", photo: "gallery/race-club-austin/00000362" },
  { title: "COTA Track Day", date: "Feb 2026", photo: "gallery/cota-track-day/img-1049" },
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const file = (path: string) => pathToFileURL(join(PUBLIC, path)).href;
// Cloudinary JPEGs: Chrome embeds JPEG as is, but re-encodes anything else losslessly, which balloons the PDF
const photo = (publicId: string, transform = "c_fill,g_auto,w_480,h_360") =>
  `https://res.cloudinary.com/${CLOUD}/image/upload/f_jpg,q_80,${transform}/${publicId}`;

function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error("No Chrome or Edge found; set CHROME_PATH");
  return found;
}

async function render(): Promise<string> {
  const qr = await QRCode.toString(VENMO_URL, { type: "svg", margin: 0, color: { dark: "#1B1B1B", light: "#0000" } });
  const tiers = [...TIERS].reverse(); // Platinum first, as in the original sheet

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Longhorn Sim Racing — Sponsor Packet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Kanit:ital,wght@1,800;1,900&family=Montserrat:ital,wght@0,400;0,500;0,600;0,700;0,800;1,500&display=block" rel="stylesheet">
<style>
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Montserrat, sans-serif; color: #1B1B1B; background: #FAFAFA; }
  .page { position: relative; width: 816px; height: 1056px; overflow: hidden; page-break-after: always; background: #FAFAFA; }
  .page:last-child { page-break-after: auto; }
  .display { font-family: Kanit, sans-serif; font-style: italic; font-weight: 900; text-transform: uppercase; line-height: 0.92; }
  .o { color: #FF8000; }
  .kicker { font-weight: 800; font-size: 9px; letter-spacing: 3px; text-transform: uppercase; color: #FF8000; }
  .label { font-weight: 800; font-size: 8px; letter-spacing: 2px; text-transform: uppercase; }
  .bars { position: absolute; top: 40px; right: 48px; display: flex; gap: 5px; }
  .bars span { width: 10px; height: 18px; background: #FF8000; transform: skewX(-20deg); }
  .bars span:nth-child(2) { opacity: 0.7; } .bars span:nth-child(3) { opacity: 0.4; }
  .rule { width: 56px; height: 4px; background: #FF8000; }

  /* Page 1 */
  .hero { position: relative; height: 340px; background: #0B0B0B; color: #FAFAFA; }
  .hero img.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 60%; }
  .hero .scrim { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(11,11,11,0.92) 0%, rgba(11,11,11,0.55) 50%, rgba(11,11,11,0.1) 100%), linear-gradient(0deg, rgba(11,11,11,0.85) 0%, rgba(11,11,11,0) 45%); }
  .hero .logo { position: absolute; top: 40px; left: 48px; height: 26px; }
  .hero .copy { position: absolute; left: 48px; bottom: 40px; width: 560px; }
  .hero h1 { font-size: 60px; margin-top: 10px; }
  .hero .sub { width: 470px; margin-top: 14px; font-size: 13px; line-height: 1.55; font-weight: 600; color: rgba(250,250,250,0.82); }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); background: #1B1B1B; color: #FAFAFA; border-top: 1px solid rgba(250,250,250,0.1); }
  .stats div { padding: 16px 0 14px 48px; border-right: 1px solid rgba(250,250,250,0.1); }
  .stats div:last-child { border-right: 0; }
  .stats b { display: block; font-family: Kanit, sans-serif; font-style: italic; font-weight: 900; font-size: 30px; line-height: 1; }
  .stats span { display: block; margin-top: 6px; color: rgba(250,250,250,0.5); }
  .why { padding: 22px 48px 0; }
  .why h2 { font-size: 32px; margin-top: 6px; }
  .why .lede { margin-top: 12px; font-size: 10.5px; line-height: 1.6; color: rgba(27,27,27,0.78); }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 14px; }
  .card { position: relative; background: #F1F1EF; border: 1px solid #E0E0DD; padding: 16px 16px 14px; }
  .card::before { content: ""; position: absolute; top: -1px; left: -1px; width: 40px; height: 4px; background: #FF8000; }
  .card .n { font-family: Kanit, sans-serif; font-style: italic; font-weight: 900; font-size: 18px; color: #FF8000; }
  .card h3 { margin-top: 4px; font-size: 9px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; }
  .card p { margin-top: 6px; font-size: 9px; line-height: 1.5; color: rgba(27,27,27,0.72); }
  .events { padding: 18px 48px 0; }
  .events .row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 10px; }
  .events figure { position: relative; height: 100px; overflow: hidden; background: #1B1B1B; }
  .events img { width: 100%; height: 100%; object-fit: cover; }
  .events figcaption { position: absolute; inset: auto 0 0 0; padding: 22px 10px 8px; background: linear-gradient(0deg, rgba(11,11,11,0.9), rgba(11,11,11,0)); color: #FAFAFA; }
  .events figcaption b { display: block; font-family: Kanit, sans-serif; font-style: italic; font-weight: 900; font-size: 13px; text-transform: uppercase; line-height: 1; }
  .events figcaption span { display: block; margin-top: 3px; font-size: 7px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; color: #FF8000; }
  .partners { position: absolute; left: 0; right: 0; bottom: 0; height: 128px; background: #1B1B1B; color: #FAFAFA; padding: 22px 48px 0; }
  .partners .logos { display: grid; grid-template-columns: repeat(${SPONSORS.length}, 1fr); gap: 32px; align-items: center; margin-top: 14px; height: 42px; }
  .partners .logos img { width: 100%; height: 42px; object-fit: contain; }
  .partners .contact { position: absolute; left: 48px; right: 48px; bottom: 14px; display: flex; justify-content: space-between; color: rgba(250,250,250,0.55); }

  /* Page 2 */
  .sheet { padding: 44px 48px 0; }
  .sheet header { display: flex; justify-content: space-between; align-items: flex-end; }
  .sheet h1 { font-size: 46px; }
  .sheet header img { height: 34px; }
  .sheet .intro { margin-top: 14px; font-size: 11px; line-height: 1.55; font-weight: 500; }
  .sheet .intro em { display: block; margin-top: 4px; color: rgba(27,27,27,0.65); }
  .tiers { margin-top: 18px; display: grid; gap: 8px; }
  .tier { display: grid; grid-template-columns: 250px 1fr; gap: 20px; align-items: center; padding: 16px 20px; border: 1px solid #E0E0DD; }
  .tier .price { font-size: 30px; }
  .tier .name { margin-top: 6px; font-size: 10px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; }
  .tier .tb { display: flex; gap: 3px; margin-bottom: 8px; }
  .tier .tb span { width: 6px; height: 10px; transform: skewX(-20deg); background: rgba(27,27,27,0.15); }
  .tier .tb span.on { background: #1B1B1B; }
  .tier ul { list-style: none; display: grid; gap: 6px; }
  .tier li { position: relative; padding-left: 16px; font-size: 11px; line-height: 1.4; font-weight: 500; }
  .tier li::before { content: ""; position: absolute; left: 0; top: 5px; width: 7px; height: 7px; background: currentColor; transform: skewX(-20deg); }
  .tier .plus { margin-bottom: 6px; font-size: 7.5px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; opacity: 0.6; }
  .tier.platinum { background: #FF8000; border-color: #FF8000; }
  .tier.gold { background: #FFB366; border-color: #FFB366; }
  .tier.silver { background: #FFE2C4; border-color: #FFE2C4; }
  .tier.friend { background: #F1F1EF; }
  .important { margin-top: 20px; display: grid; grid-template-columns: 150px 1fr; gap: 20px; padding-top: 18px; border-top: 2px solid #1B1B1B; }
  .important h2 { font-size: 24px; }
  .important ul { list-style: none; display: grid; gap: 7px; }
  .important li { position: relative; padding-left: 16px; font-size: 10.5px; line-height: 1.45; }
  .important li::before { content: ""; position: absolute; left: 0; top: 5px; width: 7px; height: 7px; background: #FF8000; transform: skewX(-20deg); }
  .steps { margin-top: 22px; display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid #E0E0DD; }
  .steps div { padding: 12px 14px; border-right: 1px solid #E0E0DD; }
  .steps div:last-child { border-right: 0; }
  .steps b { font-family: Kanit, sans-serif; font-style: italic; font-weight: 900; font-size: 20px; color: rgba(27,27,27,0.15); line-height: 1; }
  .steps h3 { margin-top: 4px; font-size: 9px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; }
  .steps p { margin-top: 3px; font-size: 9px; line-height: 1.45; color: rgba(27,27,27,0.7); }
  .give { position: absolute; left: 48px; right: 48px; bottom: 60px; display: grid; grid-template-columns: 1.15fr 1fr 1fr; gap: 12px; }
  .give > div { border: 1px solid #E0E0DD; background: #F1F1EF; padding: 16px; position: relative; }
  .give > div::before { content: ""; position: absolute; top: -1px; left: -1px; width: 40px; height: 4px; background: #FF8000; }
  .give h3 { font-size: 18px; }
  .give p { margin-top: 8px; font-size: 10px; line-height: 1.5; }
  .give .qr { display: flex; gap: 14px; align-items: center; }
  .give .qr svg { width: 92px; height: 92px; flex: none; background: #FFFFFF; padding: 6px; }
  .give .dark { background: #1B1B1B; color: #FAFAFA; border-color: #1B1B1B; }
  .foot { position: absolute; left: 48px; right: 48px; bottom: 24px; display: flex; justify-content: space-between; align-items: center; color: rgba(27,27,27,0.55); }
  .foot .line { flex: 1; height: 2px; margin: 0 16px; background: linear-gradient(90deg, #FF8000, rgba(255,128,0,0)); }
</style>
</head>
<body>

<section class="page">
  <div class="hero">
    <img class="bg" src="${photo("gallery/liveries/backstretch", "c_limit,w_1632")}" alt="">
    <div class="scrim"></div>
    <img class="logo" src="${file("brand/logos/white_logo.png")}" alt="Longhorn Sim Racing">
    <div class="bars"><span></span><span></span><span></span></div>
    <div class="copy">
      <p class="kicker">Sponsor packet</p>
      <h1 class="display">Put your brand<br><span class="o">on the grid</span></h1>
      <p class="sub">Collaborate with UT Austin's premier collegiate motorsport organization to drive innovation and engineering excellence.</p>
    </div>
  </div>
  <div class="stats">
    ${STATS.map((s) => `<div><b>${esc(s.value)}</b><span class="label">${esc(s.label)}</span></div>`).join("")}
  </div>

  <div class="why">
    <p class="kicker">Why LSR</p>
    <h2 class="display">Worth your <span class="o">investment</span></h2>
    <p class="lede">Longhorn Sim Racing is more than a competitive team; we are a professional, student-run, non-profit dedicated to creating opportunities for career engagement for every one of our members. By contributing to LSR, you align your brand with a passionate talent pipeline while supporting the practical application of creative, technical, and entrepreneurial principles.</p>
    <div class="cards">
      ${VALUES.map((v, i) => `<div class="card"><div class="n">0${i + 1}</div><h3>${esc(v.title)}</h3><p>${esc(v.body)}</p></div>`).join("")}
    </div>
  </div>

  <div class="events">
    <p class="kicker">Where we've been</p>
    <div class="row">
      ${EVENTS.map((e) => `<figure><img src="${photo(e.photo)}" alt=""><figcaption><b>${esc(e.title)}</b><span>${esc(e.date)}</span></figcaption></figure>`).join("")}
    </div>
  </div>

  <div class="partners">
    <p class="kicker">Current partners</p>
    <div class="logos">
      ${SPONSORS.map((s) => `<img src="${file(s.logo.replace(/^\//, ""))}" alt="${esc(s.name)}">`).join("")}
    </div>
    <div class="contact label"><span>${OUTREACH_EMAIL}</span><span>longhornsimracing.org/sponsors</span></div>
  </div>
</section>

<section class="page">
  <div class="sheet">
    <header>
      <h1 class="display">Sponsor <span class="o">benefits</span></h1>
      <img src="${file("brand/logos/black_logo.png")}" alt="Longhorn Sim Racing">
    </header>
    <p class="intro">A partnership with Longhorn Sim Racing provides many business opportunities from helping with the company’s community awareness to raising future employees.<em>Sponsorship at any level includes all items up through that level:</em></p>

    <div class="tiers">
      ${tiers
        .map((tier) => {
          const rank = TIERS.indexOf(tier);
          const below = rank > 0 ? TIERS[rank - 1] : null;
          return `<div class="tier ${tier.id}">
        <div>
          <div class="tb">${TIERS.map((_, i) => `<span${i <= rank ? ' class="on"' : ""}></span>`).join("")}</div>
          <div class="price display">${esc(tier.price)}</div>
          <div class="name">${esc(tier.name)}</div>
        </div>
        <div>
          ${below ? `<div class="plus">Everything in ${esc(below.short)}, plus</div>` : ""}
          <ul>${tier.benefits.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
        </div>
      </div>`;
        })
        .join("\n      ")}
    </div>

    <div class="important">
      <h2 class="display">Important</h2>
      <ul>
        <li>To meet printing deadlines, <em>please pledge by July 31</em>.</li>
        <li>Logos must be submitted to <b>${OUTREACH_EMAIL}</b>.</li>
        <li>Logos must be submitted in PNG or JPG format and be a high resolution image. If we can’t work with your logo, we may not be able to include it.</li>
      </ul>
    </div>

    <div class="steps">
      ${STEPS.map((step, i) => `<div><b>0${i + 1}</b><h3>${esc(step.title)}</h3><p>${esc(step.body)}</p></div>`).join("")}
    </div>
  </div>

  <div class="give">
    <div class="qr">
      ${qr}
      <div><h3 class="display">To <span class="o">donate</span></h3><p>Scan the code to make a donation through Venmo.</p></div>
    </div>
    <div><h3 class="display">Or by <span class="o">check</span></h3><p>Make a check payable to:<br><b>Longhorn Sim Racing</b></p></div>
    <div class="dark"><h3 class="display">Tax <span class="o">exemption</span></h3><p>W-9 available upon request. All donors will receive a receipt for tax exemption as we are a 501(c)3 nonprofit organization.</p></div>
  </div>

  <div class="foot label"><span>Longhorn Sim Racing</span><span class="line"></span><span>${OUTREACH_EMAIL} · longhornsimracing.org/sponsors</span></div>
</section>

</body>
</html>`;
}

async function main() {
  const html = await render();
  const dir = mkdtempSync(join(tmpdir(), "lsr-packet-"));
  const page = join(dir, "packet.html");
  writeFileSync(page, html);

  if (process.argv.includes("--html")) {
    console.log(`Wrote ${page}`);
    return;
  }

  const result = spawnSync(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-pdf-header-footer",
      "--allow-file-access-from-files",
      "--virtual-time-budget=20000",
      `--print-to-pdf=${OUT}`,
      pathToFileURL(page).href,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !existsSync(OUT)) {
    console.error(result.stderr || result.stdout);
    throw new Error("Chrome failed to print the packet");
  }
  console.log(`Wrote ${OUT} (${Math.round(readFileSync(OUT).length / 1024)} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
