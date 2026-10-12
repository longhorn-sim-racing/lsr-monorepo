import { describe, expect, it } from "vitest";
import { genericQuestions, questionsForTrack, tracks } from "@/schemas/recruiting.schema";
import { answerEntries, formatAnswer, parsePortfolioLinks, readPortfolioLinks } from "./answers";
import { buildExportCsv, exportFilename, type ExportRow } from "./export";
import { BOOKING_LINK_HOSTS, domainOf, formatCentral, isGoogleBookingHost, parseTrackStatus, TRACK_STATUS_LABEL } from "./labels";

const BASE = "https://example.org/";
const teamA = tracks[0];
const teamB = tracks.find((t) => t.key !== teamA.key)!;

function row(over: Partial<ExportRow> = {}): ExportRow {
  return {
    applicationId: "app-1",
    email: "ada@account.test",
    fullName: "Ada Lovelace",
    eid: "al123",
    gradYear: 2028,
    major: "Math",
    track: teamA.key,
    status: "IN_REVIEW",
    submittedAt: new Date("2026-11-15T18:30:00Z"),
    autoSubmitted: false,
    reviewCount: 0,
    averageScore: null,
    resumeUrl: "https://example.com/resume.pdf",
    portfolioLinks: [],
    genericAnswers: {},
    trackAnswers: {},
    ...over,
  };
}

/** Tiny CSV reader for the tests: handles quoted cells, doubled quotes and CRLF. */
function parse(csv: string): string[][] {
  const text = csv.replace(/^﻿/, "");
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cur.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; i++; }
    else cell += ch;
  }
  return rows;
}

const col = (header: string[], name: string) => {
  const i = header.indexOf(name);
  expect(i, `column "${name}" should exist`).toBeGreaterThanOrEqual(0);
  return i;
};

describe("buildExportCsv", () => {
  it("has one header row and one row per input row, all the same width", () => {
    const [header, ...rows] = parse(buildExportCsv([row(), row({ applicationId: "app-2", track: teamB.key })], { adminBaseUrl: BASE }));
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toHaveLength(header.length);
  });

  it("fills the profile columns from the row", () => {
    const [header, r] = parse(buildExportCsv([row({ averageScore: 4.3333, reviewCount: 3, autoSubmitted: true })], { adminBaseUrl: BASE }));
    expect(r[col(header, "Name")]).toBe("Ada Lovelace");
    expect(r[col(header, "Email")]).toBe("ada@account.test");
    expect(r[col(header, "UT EID")]).toBe("al123");
    expect(r[col(header, "Grad year")]).toBe("2028");
    expect(r[col(header, "Team")]).toBe(teamA.label);
    expect(r[col(header, "Team status")]).toBe(TRACK_STATUS_LABEL.IN_REVIEW);
    expect(r[col(header, "Submitted automatically")]).toBe("yes");
    expect(r[col(header, "Reviews")]).toBe("3");
    expect(r[col(header, "Average score")]).toBe("4.33");
    expect(r[col(header, "Resume link")]).toBe("https://example.com/resume.pdf");
  });

  it("writes submission time in Central time", () => {
    const [header, r] = parse(buildExportCsv([row()], { adminBaseUrl: BASE }));
    expect(r[col(header, "Submitted (CT)")]).toBe("2026-11-15 12:30");
  });

  it("leaves the score blank when there are no reviews", () => {
    const [header, r] = parse(buildExportCsv([row()], { adminBaseUrl: BASE }));
    expect(r[col(header, "Average score")]).toBe("");
  });

  it("links to the application in the admin area", () => {
    const [header, r] = parse(buildExportCsv([row()], { adminBaseUrl: "https://example.org///" }));
    expect(r[col(header, "Admin link")]).toBe("https://example.org/admin/recruiting/app-1");
  });

  it("joins portfolio links as 'label: url'", () => {
    const links = [{ label: "GitHub", url: "https://github.com/ada" }, { label: "Site", url: "https://ada.dev" }];
    const [header, r] = parse(buildExportCsv([row({ portfolioLinks: links })], { adminBaseUrl: BASE }));
    expect(r[col(header, "Portfolio links")]).toBe("GitHub: https://github.com/ada; Site: https://ada.dev");
  });

  it("exports the valid portfolio entries even when another entry is bad", () => {
    const links = [{ label: "Bad", url: "javascript:alert(1)" }, { label: "Good", url: "https://ada.dev" }];
    const [header, r] = parse(buildExportCsv([row({ portfolioLinks: links })], { adminBaseUrl: BASE }));
    expect(r[col(header, "Portfolio links")]).toBe("Good: https://ada.dev");
  });

  it("drops malformed portfolio data instead of exporting it", () => {
    const [header, r] = parse(buildExportCsv([row({ portfolioLinks: [{ label: "x", url: "javascript:alert(1)" }] })], { adminBaseUrl: BASE }));
    expect(r[col(header, "Portfolio links")]).toBe("");
  });

  it("neutralizes formulas an applicant typed, in every text column", () => {
    const out = buildExportCsv([row({ fullName: '=HYPERLINK("http://evil.test","x")', major: "+cmd", eid: "@x" })], { adminBaseUrl: BASE });
    const [header, r] = parse(out);
    expect(r[col(header, "Name")].startsWith("'=")).toBe(true);
    expect(r[col(header, "Major")]).toBe("'+cmd");
    expect(r[col(header, "UT EID")]).toBe("'@x");
  });

  it("neutralizes a formula typed into a free-text answer", () => {
    const q = genericQuestions.find((x) => x.type === "short_text" || x.type === "long_text");
    if (!q) return; // the general set has no text question
    const [header, r] = parse(buildExportCsv([row({ genericAnswers: { [q.id]: "=1+1" } })], { adminBaseUrl: BASE }));
    expect(r[col(header, q.label)]).toBe("'=1+1");
  });

  it("repeats the general answers on each of an applicant's rows", () => {
    const q = genericQuestions[0];
    if (!q) return; // no general questions today (covered with a mocked set in general-questions.test.ts)
    const general = { [q.id]: q.type === "scale" ? 4 : "same answer" };
    const rows = parse(buildExportCsv([row({ genericAnswers: general }), row({ track: teamB.key, genericAnswers: general })], { adminBaseUrl: BASE }));
    const i = col(rows[0], q.label);
    expect(rows[1][i]).toBe(rows[2][i]);
    expect(rows[1][i]).not.toBe("");
  });

  it("adds each present team's questions, blank on rows for other teams", () => {
    const aq = questionsForTrack(teamA.key)[0];
    const bq = questionsForTrack(teamB.key)[0];
    if (!aq || !bq) return;
    const rows = parse(
      buildExportCsv(
        [
          row({ trackAnswers: { [aq.id]: aq.type === "multi_choice" ? [aq.options[0]] : aq.type === "single_choice" ? aq.options[0] : "A's answer" } }),
          row({ track: teamB.key, trackAnswers: { [bq.id]: bq.type === "multi_choice" ? [bq.options[0]] : bq.type === "single_choice" ? bq.options[0] : "B's answer" } }),
        ],
        { adminBaseUrl: BASE },
      ),
    );
    const [header, a, b] = rows;
    const aCol = col(header, `${teamA.label}: ${aq.label}`);
    const bCol = col(header, `${teamB.label}: ${bq.label}`);
    expect(a[aCol]).not.toBe("");
    expect(a[bCol]).toBe("");
    expect(b[bCol]).not.toBe("");
    expect(b[aCol]).toBe("");
  });

  it("only includes question columns for teams that appear in the export", () => {
    const [header] = parse(buildExportCsv([row()], { adminBaseUrl: BASE }));
    for (const q of questionsForTrack(teamB.key)) expect(header).not.toContain(`${teamB.label}: ${q.label}`);
  });

  it("still exports a team that is no longer on the form", () => {
    const [header, r] = parse(buildExportCsv([row({ track: "retired-team" })], { adminBaseUrl: BASE }));
    expect(r[col(header, "Team")]).toBe("retired-team");
  });

  it("exports just the header for no rows", () => {
    expect(parse(buildExportCsv([], { adminBaseUrl: BASE }))).toHaveLength(1);
  });
});

describe("exportFilename", () => {
  it("names the round and uses the Central date", () => {
    // 03:30 UTC on Oct 17 is still the evening of Oct 16 in Austin
    expect(exportFilename("fall-2026", new Date("2026-10-17T03:30:00Z"))).toBe("lsr-recruiting-fall-2026-2026-10-16.csv");
  });
});

describe("answers", () => {
  it("formats each kind of answer", () => {
    expect(formatAnswer({ type: "multi_choice" }, ["A", "B"])).toBe("A; B");
    expect(formatAnswer({ type: "yes_no" }, true)).toBe("Yes");
    expect(formatAnswer({ type: "yes_no" }, false)).toBe("No");
    expect(formatAnswer({ type: "scale" }, 4)).toBe("4");
    expect(formatAnswer({ type: "short_text" }, undefined)).toBe("");
    expect(formatAnswer({ type: "short_text" }, null)).toBe("");
  });

  it("lists every question in order, with blanks for unanswered ones", () => {
    const entries = answerEntries(genericQuestions, {});
    expect(entries.map((e) => e.id)).toEqual(genericQuestions.map((q) => q.id));
    expect(entries.every((e) => e.known && e.text === "")).toBe(true);
  });

  it("keeps an answer whose question was removed, clearly marked", () => {
    const entries = answerEntries(genericQuestions, { gone_question: "still here", nested: { a: 1 } });
    const extra = entries.filter((e) => !e.known);
    expect(extra.map((e) => e.id)).toEqual(["gone_question", "nested"]);
    expect(extra[0].text).toBe("still here");
    expect(extra[1].text).toBe('{"a":1}');
  });

  it("copes with answers that aren't an object", () => {
    expect(answerEntries(genericQuestions, null).every((e) => e.text === "")).toBe(true);
    expect(answerEntries(genericQuestions, ["x"]).every((e) => e.known)).toBe(true);
  });

  it("parses portfolio links for the export, checking each entry on its own", () => {
    expect(parsePortfolioLinks([{ label: "Site", url: "https://ada.dev" }])).toEqual([{ label: "Site", url: "https://ada.dev" }]);
    expect(parsePortfolioLinks("nope")).toEqual([]);
    expect(parsePortfolioLinks([{ label: "x", url: "http://insecure.test" }])).toEqual([]);
  });

  it("keeps the valid portfolio entries when another one is bad (one bad entry must not hide the rest)", () => {
    const mixed = [{ label: "Bad", url: "http://insecure.test" }, { label: "Good", url: "https://ada.dev" }, "junk", null, { label: "No url" }];
    expect(parsePortfolioLinks(mixed)).toEqual([{ label: "Good", url: "https://ada.dev" }]);
  });

  it("shows every portfolio entry to an officer, leaving the link-or-not decision to the display", () => {
    const mixed = [{ label: "Bad", url: "javascript:alert(1)" }, { label: "Good", url: "https://ada.dev" }, "junk", null, { label: "No url" }, { url: "https://nolabel.dev" }];
    expect(readPortfolioLinks(mixed)).toEqual([
      { label: "Bad", url: "javascript:alert(1)" },
      { label: "Good", url: "https://ada.dev" },
      { label: "https://nolabel.dev", url: "https://nolabel.dev" },
    ]);
    expect(readPortfolioLinks("nope")).toEqual([]);
    expect(readPortfolioLinks([{ label: "x".repeat(500), url: "https://a.dev/" + "y".repeat(5000) }])[0].label).toHaveLength(100);
  });
});

describe("labels", () => {
  it("shows only the host of a clean https link", () => {
    expect(domainOf("https://www.github.com/ada")).toBe("github.com");
    expect(domainOf("https://calendar.app.google/abc")).toBe("calendar.app.google");
    expect(domainOf("http://insecure.test")).toBeNull();
    expect(domainOf("javascript:alert(1)")).toBeNull();
    expect(domainOf("https://user:pw@evil.test")).toBeNull();
  });

  it("recognizes Google Calendar booking hosts, and not look-alikes", () => {
    for (const h of BOOKING_LINK_HOSTS) expect(isGoogleBookingHost(`https://${h}/x`)).toBe(true);
    expect(isGoogleBookingHost("https://calendar.app.google.evil.test/x")).toBe(false);
    expect(isGoogleBookingHost("https://evil.test/calendar.app.google")).toBe(false);
    expect(isGoogleBookingHost("not a url")).toBe(false);
  });

  it("formats times in Central time with a CT label", () => {
    expect(formatCentral(new Date("2026-10-17T04:59:00Z"))).toBe("Oct 16, 2026, 11:59 PM CT");
    expect(formatCentral("2026-12-31T23:59:00Z")).toBe("Dec 31, 2026, 5:59 PM CT");
    expect(formatCentral(null)).toBe("");
    expect(formatCentral("not a date")).toBe("");
  });

  it("parses statuses from URLs and rejects the rest", () => {
    expect(parseTrackStatus("INTERVIEW")).toBe("INTERVIEW");
    expect(parseTrackStatus("interview")).toBeUndefined();
    expect(parseTrackStatus("WAITLISTED")).toBeUndefined();
    expect(parseTrackStatus(null)).toBeUndefined();
  });
});
