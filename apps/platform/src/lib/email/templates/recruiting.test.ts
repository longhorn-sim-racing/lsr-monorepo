import { describe, expect, it } from "vitest";
import {
  EmailComposeError,
  LIMITS,
  RECRUITING_TOKENS,
  composeEmail,
  defaultDraft,
  escapeHtml,
  findTokens,
  findUnknownTokens,
  renderEmail,
  type RecruitingEmailTemplate,
} from "./recruiting";

const values = {
  applicantName: "Ada Lovelace",
  trackName: "Media",
  trackList: "Media, Racing",
  cycleName: "Fall 2026",
  schedulingLink: "https://calendar.app.google/abc123",
  statusUrl: "https://example.org/apply/status",
  replyToEmail: "recruiting@example.org",
};
const TEMPLATES: RecruitingEmailTemplate[] = ["RECEIVED", "INTERVIEW", "ACCEPTED", "REJECTED"];

function composeError(draft: { subject: string; body: string }, v: Parameters<typeof composeEmail>[1] = values) {
  try {
    composeEmail(draft, v);
  } catch (e) {
    return e as EmailComposeError;
  }
  return null;
}

describe("placeholders", () => {
  it("finds the names used, once each, tolerating spaces", () => {
    expect(findTokens("Hi {{applicantName}}, {{ trackName }} and {{applicantName}} again")).toEqual(["applicantName", "trackName"]);
  });

  it("separates known from unknown placeholders", () => {
    expect(findUnknownTokens("{{applicantName}} {{applicnatName}} {{foo}}")).toEqual(["applicnatName", "foo"]);
  });
});

describe("composeEmail", () => {
  it("fills the placeholders in the subject and body", () => {
    const out = composeEmail({ subject: "Hello {{applicantName}}", body: "Team: {{ trackName }}.\n\nSee {{statusUrl}}" }, values);
    expect(out.subject).toBe("Hello Ada Lovelace");
    expect(out.body).toBe("Team: Media.\n\nSee https://example.org/apply/status");
  });

  it("rejects a placeholder that doesn't exist, naming it", () => {
    const e = composeError({ subject: "s", body: "Hi {{applicnatName}}" });
    expect(e?.code).toBe("UNKNOWN_TOKEN");
    expect(e?.tokens).toEqual(["applicnatName"]);
  });

  it("rejects a placeholder with no value, e.g. a team without a booking link", () => {
    const e = composeError({ subject: "s", body: "Book: {{schedulingLink}}" }, { ...values, schedulingLink: null });
    expect(e?.code).toBe("MISSING_VALUE");
    expect(e?.tokens).toEqual(["schedulingLink"]);
    expect(composeError({ subject: "s", body: "Book: {{schedulingLink}}" }, { ...values, schedulingLink: "   " })?.code).toBe("MISSING_VALUE");
  });

  it("is a single pass: a value that looks like a placeholder stays literal text", () => {
    const out = composeEmail({ subject: "s", body: "Hi {{applicantName}}" }, { ...values, applicantName: "{{trackName}} {{statusUrl}}" });
    expect(out.body).toBe("Hi {{trackName}} {{statusUrl}}");
  });

  it("keeps substituted values on one line", () => {
    const sep = String.fromCharCode(0x2028);
    const out = composeEmail({ subject: "Hi {{applicantName}}", body: "{{applicantName}}" }, { ...values, applicantName: `Ada\r\nBcc: x@evil.test${sep}Lovelace` });
    expect(out.subject).not.toMatch(/[\r\n\u0085]/);
    expect(out.subject).not.toContain(sep);
    expect(out.body).not.toContain("\n");
  });

  it("strips line breaks from a subject typed by an officer (header injection)", () => {
    const out = composeEmail({ subject: "Line one\r\nBcc: attacker@evil.test", body: "b" }, values);
    expect(out.subject).toBe("Line one Bcc: attacker@evil.test");
  });

  it("replaces other control characters in a subject, not just line breaks", () => {
    const out = composeEmail({ subject: "a\u0000b\u001bc\u007fd", body: "b" }, values);
    expect(out.subject).toBe("a b c d");
  });

  it("normalizes the body: CRLF, trailing spaces, runs of blank lines, control characters", () => {
    const out = composeEmail({ subject: "s", body: "a  \r\n\r\n\r\n\r\nb\u0007c\r\n" }, values);
    expect(out.body).toBe("a\n\nbc");
  });

  it("caps long values", () => {
    const out = composeEmail({ subject: "s", body: "{{applicantName}}" }, { ...values, applicantName: "x".repeat(1000) });
    expect(out.body.length).toBe(LIMITS.value);
  });

  it("rejects an empty or oversized subject and body", () => {
    expect(composeError({ subject: "   ", body: "b" })?.code).toBe("EMPTY");
    expect(composeError({ subject: "s", body: "  \n " })?.code).toBe("EMPTY");
    expect(composeError({ subject: "s".repeat(LIMITS.subject + 1), body: "b" })?.code).toBe("TOO_LONG");
    expect(composeError({ subject: "s", body: "b".repeat(LIMITS.body + 1) })?.code).toBe("TOO_LONG");
  });
});

describe("default drafts", () => {
  it.each(TEMPLATES)("%s only uses known placeholders and composes with full values", (template) => {
    const draft = defaultDraft(template, { hasSchedulingLink: true });
    expect(findUnknownTokens(`${draft.subject}\n${draft.body}`)).toEqual([]);
    expect(() => composeEmail(draft, values)).not.toThrow();
  });

  it("only mentions placeholders from the published list", () => {
    for (const template of TEMPLATES) {
      const draft = defaultDraft(template, { hasSchedulingLink: true, autoSubmitted: true });
      for (const t of findTokens(`${draft.subject}\n${draft.body}`)) expect(RECRUITING_TOKENS as readonly string[]).toContain(t);
    }
  });

  it("uses the booking link when the team has one, and a reply-to-schedule line when it doesn't", () => {
    const withLink = defaultDraft("INTERVIEW", { hasSchedulingLink: true });
    const without = defaultDraft("INTERVIEW", { hasSchedulingLink: false });
    expect(withLink.body).toContain("{{schedulingLink}}");
    expect(without.body).not.toContain("{{schedulingLink}}");
    expect(composeEmail(without, { ...values, schedulingLink: null }).body).toContain("Reply to this email");
  });

  it("explains an auto-submission only when it was one", () => {
    expect(defaultDraft("RECEIVED", { autoSubmitted: true }).body).toContain("we submitted it for you");
    expect(defaultDraft("RECEIVED").body).not.toContain("we submitted it for you");
  });

  it("names the team in decision emails and lists every team in the confirmation", () => {
    for (const t of ["INTERVIEW", "ACCEPTED", "REJECTED"] as const) {
      expect(composeEmail(defaultDraft(t, { hasSchedulingLink: true }), values).subject).toContain("Media");
    }
    expect(composeEmail(defaultDraft("RECEIVED"), values).body).toContain("Media, Racing");
  });
});

describe("renderEmail", () => {
  const hostile = '<script>alert(1)</script> & "quotes" <img src=x onerror=alert(1)>';

  it("has no email-preferences link, since these emails ignore those preferences", () => {
    expect(renderEmail({ subject: "Hi", body: "Hello there" }).html).not.toContain("Manage email preferences");
  });

  it("escapes everything: applicant-controlled text can't become markup", () => {
    const composed = composeEmail(
      { subject: "Hi {{applicantName}}", body: "Dear {{applicantName}},\n\nsecond <b>paragraph</b>" },
      { ...values, applicantName: hostile },
    );
    const { html } = renderEmail(composed);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>paragraph</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quotes&quot;");
  });

  it("splits paragraphs on blank lines and keeps single newlines as line breaks", () => {
    const { html } = renderEmail({ subject: "s", body: "one\ntwo\n\nthree" });
    expect(html).toContain("one<br>two");
    // Our paragraphs carry this style; the surrounding branded template has <p> elements of its own
    expect(html.match(/font-size:15px;line-height:1\.6;color:#e5e5e5/g)).toHaveLength(2);
  });

  it("returns a plain-text version with the body and no markup", () => {
    const { text, subject } = renderEmail({ subject: "Hello", body: "Plain <b>text</b>" });
    expect(subject).toBe("Hello");
    expect(text).toContain("Plain <b>text</b>");
    expect(text).not.toContain("<p");
  });

  it("escapes the preview text and title too", () => {
    const { html } = renderEmail({ subject: "A <i>subject</i>", body: "<u>first</u> paragraph" });
    expect(html).not.toContain("<i>subject</i>");
    expect(html).not.toContain("<u>first</u>");
    expect(html).toContain("A &lt;i&gt;subject&lt;/i&gt;");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
