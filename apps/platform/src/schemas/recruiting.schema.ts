// src/schemas/recruiting.schema.ts
//
// Everything applicants are asked in the recruiting form lives in this one file:
// the teams ("tracks"), the general questions, each team's questions, and the
// validators built from them. The form renderer, the server-side validation and the
// CSV export all read these definitions, so changing a question here changes all three.
//
// Team leads send their questions as text; a developer transcribes them below
// (one commit per team). The rules for lead questions are enforced in code, not just
// by convention, so a violation fails typecheck/build (and therefore CI):
//   - at most 5 questions per team            (type `Upto5` + validateContent)
//   - only these types: short_text, long_text, single_choice, multi_choice, link
//   - every question says whether it is required
//   - choice questions list 2 to 8 options of at most 100 characters
//   - no file uploads anywhere: the resume and portfolio are links
// See docs/recruiting-build-plan.md and docs/recruiting-system-design.md (local docs).

import { z } from 'zod';

export const RECRUITING_LIMITS = {
  maxQuestionsPerTrack: 5,
  minOptions: 2,
  maxOptions: 8,
  maxOptionLength: 100,
  maxLabelLength: 300,
  shortTextMax: 200,
  longTextMax: 1500,
  urlMax: 2000,
  maxPortfolioLinks: 5,
  portfolioLabelMax: 60,
} as const;

/** Bump when a question is removed or changes meaning (copied onto each application). */
export const FORM_VERSION = 1;

/**
 * True while the tracks and questions below are placeholders. Launch checklist (Push 10):
 * set to false only after every team's real content is in. The apply pages must refuse
 * to open for real applicants while this is true.
 */
export const PLACEHOLDER_CONTENT = true;

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

type BaseQuestion = {
  /** Lowercase letters, digits and underscores; unique across ALL questions (it is also a CSV column). */
  id: string;
  label: string;
  /** Optional hint shown under the question. */
  help?: string;
  /** No default on purpose: every question must say. */
  required: boolean;
};

export type ShortTextQuestion = BaseQuestion & { type: 'short_text' };
export type LongTextQuestion = BaseQuestion & { type: 'long_text' };
export type SingleChoiceQuestion = BaseQuestion & { type: 'single_choice'; options: readonly string[] };
export type MultiChoiceQuestion = BaseQuestion & { type: 'multi_choice'; options: readonly string[] };
export type LinkQuestion = BaseQuestion & { type: 'link' };

/** What team leads may use. */
export type TrackQuestion =
  | ShortTextQuestion
  | LongTextQuestion
  | SingleChoiceQuestion
  | MultiChoiceQuestion
  | LinkQuestion;

/** Only the general (platform-owned) set may use these. */
export type ScaleQuestion = BaseQuestion & { type: 'scale'; min: number; max: number };
export type YesNoQuestion = BaseQuestion & { type: 'yes_no' };

export type GenericQuestion = TrackQuestion | ScaleQuestion | YesNoQuestion;
export type Question = GenericQuestion;

export const TRACK_QUESTION_TYPES = ['short_text', 'long_text', 'single_choice', 'multi_choice', 'link'] as const;
export const GENERIC_QUESTION_TYPES = [...TRACK_QUESTION_TYPES, 'scale', 'yes_no'] as const;

/** A tuple of 0 to 5 items: a sixth question is a compile error. */
type Upto5<T> =
  | readonly []
  | readonly [T]
  | readonly [T, T]
  | readonly [T, T, T]
  | readonly [T, T, T, T]
  | readonly [T, T, T, T, T];

// ---------------------------------------------------------------------------
// Teams ("tracks")
// ---------------------------------------------------------------------------

export type TrackDefinition = {
  /** Stored in the database; lowercase letters, digits and hyphens. Do not rename once applications exist. */
  key: string;
  label: string;
  /** One or two sentences shown when choosing teams. */
  blurb: string;
  /** From the team lead. When false, the Interview status/email/scheduling link do not apply. */
  interviewRequired: boolean;
};

// Technology and Community are real (transcribed from the leads' questions). The three
// "(placeholder)" teams stand in for teams that haven't sent theirs yet; replace each one when it does
// (see PLACEHOLDER_CONTENT). Their keys are used by the tests, so keep them until they are replaced.
export const tracks = [
  { key: 'technology', label: 'Technology', blurb: 'Web, data, infrastructure and broadcast tech behind the club.', interviewRequired: true },
  { key: 'community', label: 'Community', blurb: 'Events, socials and growing the club community.', interviewRequired: true },
  { key: 'team-a', label: 'Team A (placeholder)', blurb: 'Placeholder for a team whose questions are not in yet. Interviews.', interviewRequired: true },
  { key: 'team-b', label: 'Team B (placeholder)', blurb: 'Placeholder for a team whose questions are not in yet. No interview.', interviewRequired: false },
  { key: 'team-c', label: 'Team C (placeholder)', blurb: 'Placeholder for a team whose questions are not in yet. Five questions.', interviewRequired: true },
] as const satisfies readonly TrackDefinition[];

export type TrackKey = (typeof tracks)[number]['key'];

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

// General (platform-owned) questions. There are none: name, email, UT EID, graduation year and
// major are collected on the "About you" page, and everything else is asked per team. If a general
// question is ever added, the form shows a "General questions" page again by itself.
export const genericQuestions: readonly GenericQuestion[] = [];

// Team questions. Ids must be unique across every list in this file, so prefix them with the team.
// Technology and Community are the leads' wording, verbatim; the `[Placeholder]` ones are stand-ins.
export const trackQuestions: Record<TrackKey, Upto5<TrackQuestion>> = {
  technology: [
    {
      id: 'tech_areas',
      type: 'multi_choice',
      label: 'Which areas of the Tech Team interest you most?',
      options: [
        'Web development (front end)',
        'Back end and databases',
        'UI/UX design',
        'Race data and stats (results, live timing)',
        'Infrastructure and DevOps',
        'AI tools and automation',
        'Stream and broadcast tech (overlays, OBS)',
      ],
      required: true,
    },
    {
      id: 'tech_experience',
      type: 'single_choice',
      label: 'How much experience do you have building software?',
      options: ['None yet, but I want to learn', 'Classes or tutorials', 'Personal or class projects', 'Internship or job experience'],
      required: true,
    },
    { id: 'tech_built', type: 'long_text', label: "Tell us about something you've built or worked on, and what you'd like to build at LSR.", required: true },
    { id: 'tech_link', type: 'link', label: 'GitHub, portfolio, or project link', required: false },
    { id: 'tech_hours', type: 'single_choice', label: 'How many hours a week could you give the Tech Team?', options: ['1–3', '3–5', '5–8', '8+'], required: true },
  ],
  community: [
    {
      id: 'comm_interest',
      type: 'multi_choice',
      label: 'What is your primary interest in our club?',
      options: ['Sim Racing', 'Real Life Racing Events', 'Formula 1', 'Meeting new Motorsports Fans'],
      required: true,
    },
    { id: 'comm_why', type: 'long_text', label: 'Why are you interested in becoming a Community Officer at LSR?', required: true },
    { id: 'comm_organized', type: 'long_text', label: 'Tell us about a time you were in charge of organizing events, planning, or engaging a community?', required: true },
    {
      id: 'comm_event',
      type: 'long_text',
      label: 'If you were in charge of creating one event for LSR relating to sim racing, motorsports, or a fun social activity, what would you choose to plan?',
      required: true,
    },
    { id: 'comm_hours', type: 'single_choice', label: 'Roughly how many hours a week would you be able to work for LSR?', options: ['1–3', '3–5', '5–8', '8+'], required: true },
  ],
  'team-a': [
    { id: 'a_experience', type: 'long_text', label: '[Placeholder] Describe your relevant experience.', required: true },
    { id: 'a_portfolio', type: 'link', label: '[Placeholder] Link to a past project.', required: false },
  ],
  'team-b': [
    { id: 'b_tools', type: 'multi_choice', label: '[Placeholder] Which tools do you use?', options: ['Tool 1', 'Tool 2', 'Tool 3', 'Other'], required: false },
  ],
  'team-c': [
    { id: 'c_motivation', type: 'long_text', label: '[Placeholder] Why this team?', required: true },
    { id: 'c_hours', type: 'single_choice', label: '[Placeholder] Hours per week you can commit', options: ['1 to 3', '4 to 6', '7 or more'], required: true },
    { id: 'c_skills', type: 'multi_choice', label: '[Placeholder] Which skills apply to you?', options: ['Skill 1', 'Skill 2', 'Skill 3'], required: false },
    { id: 'c_headline', type: 'short_text', label: '[Placeholder] Describe yourself in one line.', required: false },
    { id: 'c_link', type: 'link', label: '[Placeholder] Link to your best work.', required: true },
  ],
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function isTrackKey(value: unknown): value is TrackKey {
  return typeof value === 'string' && tracks.some((t) => t.key === value);
}

export function getTrack(key: string): (typeof tracks)[number] | undefined {
  return tracks.find((t) => t.key === key);
}

export function questionsForTrack(key: string): readonly TrackQuestion[] {
  return isTrackKey(key) ? trackQuestions[key] : [];
}

// ---------------------------------------------------------------------------
// Content validation (runs when this module loads, so a bad edit fails the build)
// ---------------------------------------------------------------------------

export type RecruitingContent = {
  tracks: readonly TrackDefinition[];
  genericQuestions: readonly GenericQuestion[];
  trackQuestions: Readonly<Record<string, readonly TrackQuestion[]>>;
};

const QUESTION_ID = /^[a-z][a-z0-9_]{0,39}$/;
const TRACK_KEY = /^[a-z][a-z0-9-]{0,39}$/;

/** Throws one Error listing every problem found. Exported so it can be exercised with bad input. */
export function validateContent(content: RecruitingContent): void {
  const problems: string[] = [];
  const L = RECRUITING_LIMITS;
  const seenIds = new Map<string, string>();

  const checkQuestion = (q: GenericQuestion, where: string, allowedTypes: readonly string[]) => {
    const at = `${where} question "${q.id}"`;
    if (!QUESTION_ID.test(q.id)) problems.push(`${at}: id must match ${QUESTION_ID}`);
    const prior = seenIds.get(q.id);
    if (prior) problems.push(`${at}: id is already used in ${prior}`);
    else seenIds.set(q.id, where);
    if (!allowedTypes.includes(q.type)) problems.push(`${at}: type "${q.type}" is not allowed here`);
    if (typeof q.required !== 'boolean') problems.push(`${at}: "required" must be true or false`);
    if (!q.label.trim() || q.label.length > L.maxLabelLength) problems.push(`${at}: label must be 1 to ${L.maxLabelLength} characters`);
    if (q.type === 'single_choice' || q.type === 'multi_choice') {
      const o = q.options;
      if (o.length < L.minOptions || o.length > L.maxOptions) problems.push(`${at}: needs ${L.minOptions} to ${L.maxOptions} options (has ${o.length})`);
      if (o.some((x) => !x.trim() || x.length > L.maxOptionLength)) problems.push(`${at}: each option must be 1 to ${L.maxOptionLength} characters`);
      if (new Set(o).size !== o.length) problems.push(`${at}: options must be unique`);
    }
    if (q.type === 'scale') {
      if (!Number.isInteger(q.min) || !Number.isInteger(q.max) || q.min >= q.max || q.max - q.min > 10) {
        problems.push(`${at}: scale needs whole numbers with min < max and a range of at most 10`);
      }
    }
  };

  const seenKeys = new Set<string>();
  for (const t of content.tracks) {
    if (!TRACK_KEY.test(t.key)) problems.push(`track "${t.key}": key must match ${TRACK_KEY}`);
    if (seenKeys.has(t.key)) problems.push(`track "${t.key}": duplicate key`);
    seenKeys.add(t.key);
    if (!t.label.trim()) problems.push(`track "${t.key}": label is empty`);
    if (typeof t.interviewRequired !== 'boolean') problems.push(`track "${t.key}": interviewRequired must be true or false`);
  }

  content.genericQuestions.forEach((q) => checkQuestion(q, 'general', GENERIC_QUESTION_TYPES));

  for (const key of Object.keys(content.trackQuestions)) {
    if (!seenKeys.has(key)) problems.push(`trackQuestions has "${key}" but no such track exists`);
  }
  for (const t of content.tracks) {
    const qs = content.trackQuestions[t.key];
    if (!qs) {
      problems.push(`track "${t.key}": no entry in trackQuestions (use an empty list for no questions)`);
      continue;
    }
    if (qs.length > L.maxQuestionsPerTrack) {
      problems.push(`track "${t.key}": ${qs.length} questions, the maximum is ${L.maxQuestionsPerTrack}`);
    }
    qs.forEach((q) => checkQuestion(q, `track ${t.key}`, TRACK_QUESTION_TYPES));
  }

  if (problems.length > 0) {
    throw new Error(`Invalid recruiting content:\n- ${problems.join('\n- ')}`);
  }
}

validateContent({ tracks, genericQuestions, trackQuestions });

// ---------------------------------------------------------------------------
// Value validators
// ---------------------------------------------------------------------------

/** An https link with no whitespace and no embedded credentials. */
export function isSafeHttpsUrl(value: string): boolean {
  if (/[\s\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.');
  } catch {
    return false;
  }
}

export const httpsUrl = z
  .string()
  .trim()
  .max(RECRUITING_LIMITS.urlMax, 'That link is too long.')
  .refine(isSafeHttpsUrl, { error: 'Enter a full link that starts with https://' });

export const portfolioLinkSchema = z.object({
  label: z.string().trim().min(1, 'Add a short label.').max(RECRUITING_LIMITS.portfolioLabelMax),
  url: httpsUrl,
});

export const portfolioLinksSchema = z.array(portfolioLinkSchema).max(RECRUITING_LIMITS.maxPortfolioLinks);

/** Profile fields, pre-filled from the account and copied onto the application. All required at submit. */
export const profileSchema = z.object({
  fullName: z.string().trim().min(1, 'Enter your name.').max(120),
  email: z.string().trim().max(254).pipe(z.email('Enter a valid email.')),
  eid: z.string().trim().min(1, 'Enter your UT EID.').max(16),
  gradYear: z.number().int().min(2000).max(2100),
  major: z.string().trim().min(1, 'Enter your major.').max(120),
});

function valueSchema(q: GenericQuestion): z.ZodType {
  const L = RECRUITING_LIMITS;
  switch (q.type) {
    case 'short_text':
      return z.string().trim().max(L.shortTextMax, `Keep it under ${L.shortTextMax} characters.`);
    case 'long_text':
      return z.string().trim().max(L.longTextMax, `Keep it under ${L.longTextMax} characters.`);
    case 'single_choice':
      return z.enum(q.options as unknown as [string, ...string[]], { error: 'Pick one of the listed options.' });
    case 'multi_choice':
      return z
        .array(z.enum(q.options as unknown as [string, ...string[]], { error: 'Pick from the listed options.' }))
        .refine((a) => new Set(a).size === a.length, { error: 'Each option can only be picked once.' });
    case 'link':
      return httpsUrl;
    case 'scale':
      return z.number().int().min(q.min).max(q.max);
    case 'yes_no':
      return z.boolean();
    default: {
      const unreachable: never = q;
      throw new Error(`Unknown question type: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Unanswered: missing, null, blank text, or an empty selection. (`false` and `0` are answers.) */
export function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

export type ParsedAnswers = {
  /** Cleaned answers: trimmed, blanks dropped. Safe to store. */
  value: Record<string, unknown>;
  /** Per-question problems (wrong type, too long, not a listed option, unknown question). */
  errors: Record<string, string>;
  /** Required questions with no answer. Only reported in 'submit' mode. */
  missing: string[];
};

/**
 * Checks a set of answers against its question list.
 *  - 'draft':  only shape and limits are checked; blanks are fine (used for saving progress)
 *  - 'submit': required questions must also be answered
 */
export function parseAnswers(
  questions: readonly GenericQuestion[],
  answers: unknown,
  mode: 'draft' | 'submit',
): ParsedAnswers {
  const result: ParsedAnswers = { value: {}, errors: {}, missing: [] };
  if (answers === null || answers === undefined) answers = {};
  if (typeof answers !== 'object' || Array.isArray(answers)) {
    result.errors._ = 'Answers must be an object.';
    return result;
  }
  const record = answers as Record<string, unknown>;
  const known = new Set(questions.map((q) => q.id));
  for (const key of Object.keys(record)) {
    if (!known.has(key)) result.errors[key] = 'Unknown question.';
  }
  for (const q of questions) {
    const raw = record[q.id];
    if (isBlank(raw)) {
      if (mode === 'submit' && q.required) result.missing.push(q.id);
      continue;
    }
    const parsed = valueSchema(q).safeParse(raw);
    if (parsed.success) result.value[q.id] = parsed.data;
    else result.errors[q.id] = parsed.error.issues[0]?.message ?? 'Invalid answer.';
  }
  return result;
}

// ---------------------------------------------------------------------------
// Saving progress (draft)
// ---------------------------------------------------------------------------

/**
 * Shape of one "Save and continue". Loose on purpose: no required-field checks, and
 * question answers are validated afterwards with parseAnswers(..., 'draft').
 */
export const draftPatchSchema = z
  .object({
    step: z.string().max(40).optional(),
    profile: profileSchema.partial().optional(),
    genericAnswers: z.record(z.string(), z.unknown()).optional(),
    trackAnswers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    resumeUrl: z.union([z.literal(''), httpsUrl]).optional(),
    portfolioLinks: portfolioLinksSchema.optional(),
  })
  .strict();

export type DraftPatch = z.infer<typeof draftPatchSchema>;

// ---------------------------------------------------------------------------
// "Is this application complete?" (the single definition used by Submit, the
// review checklist, and the deadline sweep)
// ---------------------------------------------------------------------------

export type DraftSnapshot = {
  fullName?: string | null;
  email?: string | null;
  eid?: string | null;
  gradYear?: number | null;
  major?: string | null;
  resumeUrl?: string | null;
  genericAnswers?: unknown;
  portfolioLinks?: unknown;
  tracks: ReadonlyArray<{ track: string; answers: unknown }>;
};

export type CompletenessSection = {
  /** 'profile' | 'general' | 'tracks' | 'track:<key>' | 'links' */
  key: string;
  label: string;
  complete: boolean;
  problems: string[];
};

export type CompletenessReport = {
  complete: boolean;
  sections: CompletenessSection[];
};

function describeAnswerProblems(questions: readonly GenericQuestion[], parsed: ParsedAnswers): string[] {
  const label = (id: string) => questions.find((q) => q.id === id)?.label ?? id;
  return [
    ...parsed.missing.map((id) => `Missing: ${label(id)}`),
    ...Object.entries(parsed.errors).map(([id, msg]) => `${label(id)}: ${msg}`),
  ];
}

export function checkCompleteness(draft: DraftSnapshot): CompletenessReport {
  const sections: CompletenessSection[] = [];
  const add = (key: string, label: string, problems: string[]) =>
    sections.push({ key, label, complete: problems.length === 0, problems });

  // About you
  const profile = profileSchema.safeParse({
    fullName: draft.fullName ?? '',
    email: draft.email ?? '',
    eid: draft.eid ?? '',
    gradYear: draft.gradYear ?? undefined,
    major: draft.major ?? '',
  });
  add(
    'profile',
    'About you',
    profile.success ? [] : [...new Set(profile.error.issues.map((i) => i.message))],
  );

  // General questions
  add(
    'general',
    'General questions',
    describeAnswerProblems(genericQuestions, parseAnswers(genericQuestions, draft.genericAnswers, 'submit')),
  );

  // Team selection
  const keys = draft.tracks.map((t) => t.track);
  const trackProblems: string[] = [];
  if (keys.length === 0) trackProblems.push('Choose at least one team.');
  if (new Set(keys).size !== keys.length) trackProblems.push('A team was chosen twice.');
  for (const k of keys) if (!isTrackKey(k)) trackProblems.push(`Unknown team: ${k}`);
  add('tracks', 'Choose teams', trackProblems);

  // One page per chosen team
  for (const t of draft.tracks) {
    if (!isTrackKey(t.track)) continue;
    const qs = questionsForTrack(t.track);
    add(
      `track:${t.track}`,
      getTrack(t.track)?.label ?? t.track,
      describeAnswerProblems(qs, parseAnswers(qs, t.answers, 'submit')),
    );
  }

  // Resume and portfolio links
  const linkProblems: string[] = [];
  if (isBlank(draft.resumeUrl)) linkProblems.push('Missing: link to your resume');
  else if (!httpsUrl.safeParse(draft.resumeUrl).success) linkProblems.push('Resume link: enter a full link that starts with https://');
  const portfolio = portfolioLinksSchema.safeParse(draft.portfolioLinks ?? []);
  if (!portfolio.success) linkProblems.push(`Portfolio links: ${portfolio.error.issues[0]?.message ?? 'invalid'}`);
  add('links', 'Resume & portfolio', linkProblems);

  return { complete: sections.every((s) => s.complete), sections };
}

export function isComplete(draft: DraftSnapshot): boolean {
  return checkCompleteness(draft).complete;
}
