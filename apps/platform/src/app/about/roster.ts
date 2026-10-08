// The officer roster shown on /about. Source of truth: the president's roster post to the
// exec team (2026-09-28). Update this file when roles change.
//
// Photos: run scripts/crop-headshot.py on the original (it frames the face to match the
// others and writes public/images/officers/<slug>.jpg), then set `photo` to that path.
// Anyone without one gets an initials tile.

export type TeamId = "executive" | "business" | "community" | "competition" | "media" | "technology";

export type Team = {
  id: TeamId;
  name: string;
  /** Short code shown on board tiles, timing-tower style. */
  code: string;
  blurb: string;
};

export type Officer = {
  name: string;
  title: string;
  team: TeamId;
  /** Holds a board seat: shown in the Leadership grid as well as under their team. */
  board?: boolean;
  photo?: string;
};

export const TEAMS: Team[] = [
  {
    id: "executive",
    name: "Executive",
    code: "EXEC",
    blurb: "Leads the club, sets priorities each semester and keeps every department pulling in the same direction.",
  },
  {
    id: "competition",
    name: "Competition",
    code: "COMP",
    blurb: "Runs the Lone Star Cup: race control, stewarding, sporting regulations and the sim servers we race on.",
  },
  {
    id: "community",
    name: "Community",
    code: "CMTY",
    blurb: "Brings people in and keeps them around: watch parties, sim nights, socials, tabling and volunteering at track events.",
  },
  {
    id: "media",
    name: "Media",
    code: "MDIA",
    blurb: "Photos, video, race highlights and the LSR brand across every channel.",
  },
  {
    id: "business",
    name: "Business",
    code: "BUSN",
    blurb: "Sponsorships, partnerships, fundraising and industry connections, plus the books and our nonprofit status.",
  },
  {
    id: "technology",
    name: "Technology",
    code: "TECH",
    blurb: "Builds and runs this website and the tools behind it: events, payments, results and the member database.",
  },
];

export const OFFICERS: Officer[] = [
  { name: "Dylan Foley", title: "President", team: "executive", board: true, photo: "/images/officers/dylan-foley.jpg" },
  { name: "Bryan Reyes", title: "Vice President", team: "executive", board: true, photo: "/images/officers/bryan-reyes.jpg" },
  { name: "Romer Pena", title: "Operations Lead", team: "executive" },

  { name: "Armando Martinez", title: "Competition Lead", team: "competition", board: true, photo: "/images/officers/armando-martinez.jpg" },
  { name: "Mark Yuan", title: "Officer", team: "competition" },
  { name: "Prakul Sherikar", title: "Officer", team: "competition" },
  { name: "Jacob Pineda", title: "Officer", team: "competition" },
  { name: "Constanza Jongkind", title: "Officer", team: "competition" },

  { name: "George Lawrence", title: "Community Lead", team: "community", board: true, photo: "/images/officers/george-lawrence.jpg" },
  { name: "Ethan Chan", title: "Officer", team: "community" },
  { name: "Alejandro Palacios", title: "Officer", team: "community" },
  { name: "Grant Ruhland", title: "Officer", team: "community", photo: "/images/officers/grant-ruhland.jpg" },

  { name: "Diane Chagoya", title: "Media Lead", team: "media", board: true, photo: "/images/officers/diane-chagoya.jpg" },
  { name: "Anuja Manjrekar", title: "Officer", team: "media" },
  { name: "Harshika Mandula", title: "Officer", team: "media", photo: "/images/officers/harshika-mandula.jpg" },
  { name: "Leisha Jhamnani", title: "Officer", team: "media" },
  { name: "Lauren Heyde", title: "Officer", team: "media" },

  { name: "Jaylon Collins", title: "Business Lead", team: "business", board: true, photo: "/images/officers/jaylon-collins.jpg" },
  { name: "Boen Kelly", title: "Nonprofit Compliance Lead", team: "business", photo: "/images/officers/boen-kelly.jpg" },
  { name: "Jose Varela", title: "Officer", team: "business" },
  { name: "Cooper Tomlin", title: "Officer", team: "business" },

  { name: "Gray Marshall", title: "Technology Lead", team: "technology", board: true, photo: "/images/officers/gray-marshall.jpg" },
  { name: "Alexander Spears", title: "Officer", team: "technology" },
  { name: "Arav Agarwal", title: "Officer", team: "technology" },
];
