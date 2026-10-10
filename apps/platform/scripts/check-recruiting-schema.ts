/* eslint-disable @typescript-eslint/no-explicit-any -- this check feeds deliberately malformed content */
// Dev check for the recruiting question schema and its validators.
// There is no test runner and CI does not run this: run it by hand after editing
// src/schemas/recruiting.schema.ts (especially when transcribing a team's questions):
//
//   npx tsx scripts/check-recruiting-schema.ts
//
// Exits non-zero if any check fails. The shipped content itself is also validated
// every time that module loads, which is what fails `next build` on a bad edit.

import * as S from '../src/schemas/recruiting.schema';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`);
}
function throwsWith(name: string, fn: () => void, text: string) {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (e) {
    const msg = (e as Error).message;
    check(name, msg.includes(text), `message was: ${msg.split('\n').slice(0, 3).join(' | ')}`);
  }
}

const q = (id: string, extra: object = {}) => ({ id, type: 'short_text', label: 'L', required: false, ...extra }) as any;
const base = () => ({
  tracks: [{ key: 'alpha', label: 'Alpha', blurb: '', interviewRequired: true }],
  genericQuestions: [] as any[],
  trackQuestions: { alpha: [q('a_one')] } as Record<string, any[]>,
});

console.log('--- validateContent: the shipped content is valid (module loaded) ---');
check('module loaded without throwing', true);

console.log('--- validateContent: lead rules are enforced at runtime ---');
{
  const c = base(); c.trackQuestions.alpha = [1, 2, 3, 4, 5, 6].map((n) => q(`a_${n}`));
  throwsWith('6 questions rejected', () => S.validateContent(c), 'maximum is 5');
  const ok = base(); ok.trackQuestions.alpha = [1, 2, 3, 4, 5].map((n) => q(`a_${n}`));
  try { S.validateContent(ok); check('exactly 5 questions accepted', true); } catch (e) { check('exactly 5 questions accepted', false, (e as Error).message); }
}
{ const c = base(); c.trackQuestions.alpha = [q('a_f', { type: 'file' })]; throwsWith('file question type rejected', () => S.validateContent(c), 'not allowed'); }
{ const c = base(); c.trackQuestions.alpha = [q('a_s', { type: 'scale', min: 1, max: 5 })]; throwsWith('scale rejected for team leads', () => S.validateContent(c), 'not allowed'); }
{ const c = base(); c.trackQuestions.alpha = [q('a_y', { type: 'yes_no' })]; throwsWith('yes_no rejected for team leads', () => S.validateContent(c), 'not allowed'); }
{ const c = base(); c.genericQuestions = [q('g_s', { type: 'scale', min: 1, max: 5 }), q('g_y', { type: 'yes_no' })]; try { S.validateContent(c); check('scale/yes_no allowed in the general set', true); } catch (e) { check('scale/yes_no allowed in the general set', false, (e as Error).message); } }
{ const c = base(); c.trackQuestions.alpha = [q('a_c', { type: 'single_choice', options: ['only one'] })]; throwsWith('1 option rejected', () => S.validateContent(c), '2 to 8 options'); }
{ const c = base(); c.trackQuestions.alpha = [q('a_c', { type: 'multi_choice', options: Array.from({ length: 9 }, (_, i) => `o${i}`) })]; throwsWith('9 options rejected', () => S.validateContent(c), '2 to 8 options'); }
{ const c = base(); c.trackQuestions.alpha = [q('a_c', { type: 'single_choice', options: ['ok', 'x'.repeat(101)] })]; throwsWith('101-char option rejected', () => S.validateContent(c), 'each option'); }
{ const c = base(); c.trackQuestions.alpha = [q('a_c', { type: 'single_choice', options: ['same', 'same'] })]; throwsWith('duplicate options rejected', () => S.validateContent(c), 'unique'); }
{ const c = base(); c.trackQuestions.alpha = [q('a_r', { required: undefined })]; throwsWith('missing "required" rejected', () => S.validateContent(c), 'required'); }
{ const c = base(); c.trackQuestions.alpha = [q('Bad-Id')]; throwsWith('bad question id rejected', () => S.validateContent(c), 'id must match'); }
{ const c = base(); c.genericQuestions = [q('dup')]; c.trackQuestions.alpha = [q('dup')]; throwsWith('id reused across lists rejected', () => S.validateContent(c), 'already used'); }
{ const c = base(); c.trackQuestions.ghost = []; throwsWith('questions for an unknown team rejected', () => S.validateContent(c), 'no such track'); }
{ const c = base(); delete (c.trackQuestions as any).alpha; throwsWith('team without a question entry rejected', () => S.validateContent(c), 'no entry in trackQuestions'); }
{ const c = base(); c.tracks.push({ ...c.tracks[0] }); c.trackQuestions.alpha = []; throwsWith('duplicate team key rejected', () => S.validateContent(c), 'duplicate key'); }
{ const c = base(); c.genericQuestions = [q('g_s', { type: 'scale', min: 5, max: 1 })]; throwsWith('scale with min >= max rejected', () => S.validateContent(c), 'min < max'); }
{ const c = base(); c.trackQuestions.alpha = [q('a_l', { label: '   ' })]; throwsWith('blank label rejected', () => S.validateContent(c), 'label must be'); }
{
  const c = base(); c.trackQuestions.alpha = [1, 2, 3, 4, 5, 6].map((n) => q(`A-${n}`, { type: 'file' }));
  try { S.validateContent(c); check('multiple problems are all reported', false, 'did not throw'); } catch (e) { const n = (e as Error).message.split('\n').length - 1; check('multiple problems are all reported', n >= 3, `only ${n} lines`); }
}

console.log('--- isSafeHttpsUrl ---');
const urls: [string, boolean][] = [
  ['https://example.com/me.pdf', true], ['https://drive.google.com/file/d/abc/view?usp=sharing', true],
  ['http://example.com', false], ['//evil.com', false], ['javascript:alert(1)', false], ['https://user:pw@example.com', false],
  ['https://exa mple.com', false], ['https://example.com/\nx', false], ['https://localhost', false], ['ftp://example.com', false], ['not a url', false], ['', false],
];
for (const [u, expected] of urls) check(`url ${JSON.stringify(u)} -> ${expected}`, S.isSafeHttpsUrl(u) === expected);
check('url over 2000 chars rejected', !S.httpsUrl.safeParse('https://example.com/' + 'a'.repeat(2000)).success);

console.log('--- parseAnswers ---');
const sample: S.GenericQuestion[] = [
  { id: 'txt', type: 'short_text', label: 'Short', required: true },
  { id: 'long', type: 'long_text', label: 'Long', required: false },
  { id: 'one', type: 'single_choice', label: 'One', options: ['A', 'B'], required: true },
  { id: 'many', type: 'multi_choice', label: 'Many', options: ['X', 'Y', 'Z'], required: false },
  { id: 'lnk', type: 'link', label: 'Link', required: false },
  { id: 'rate', type: 'scale', label: 'Rate', min: 1, max: 5, required: false },
  { id: 'flag', type: 'yes_no', label: 'Flag', required: true },
];
{
  const r = S.parseAnswers(sample, {}, 'draft');
  check('draft: empty answers are fine', Object.keys(r.errors).length === 0 && r.missing.length === 0);
  const s = S.parseAnswers(sample, {}, 'submit');
  check('submit: required questions reported missing', s.missing.join(',') === 'txt,one,flag', s.missing.join(','));
}
{
  const r = S.parseAnswers(sample, { txt: '  hello  ', one: 'A', flag: false, many: ['X', 'Z'], rate: 3, lnk: 'https://example.com' }, 'submit');
  check('valid answers parse with no problems', Object.keys(r.errors).length === 0 && r.missing.length === 0, JSON.stringify(r));
  check('text is trimmed', r.value.txt === 'hello');
  check('false counts as answered (yes_no)', r.missing.indexOf('flag') === -1 && r.value.flag === false);
}
check('whitespace-only text counts as unanswered', S.parseAnswers(sample, { txt: '   ', one: 'A', flag: true }, 'submit').missing.includes('txt'));
check('unknown question id is an error', 'zzz' in S.parseAnswers(sample, { zzz: 'x' }, 'draft').errors);
check('short text over 200 rejected', 'txt' in S.parseAnswers(sample, { txt: 'x'.repeat(201) }, 'draft').errors);
check('short text of 200 accepted', !('txt' in S.parseAnswers(sample, { txt: 'x'.repeat(200) }, 'draft').errors));
check('long text over 1500 rejected', 'long' in S.parseAnswers(sample, { long: 'x'.repeat(1501) }, 'draft').errors);
check('long text of 1500 accepted', !('long' in S.parseAnswers(sample, { long: 'x'.repeat(1500) }, 'draft').errors));
check('single choice: unlisted option rejected', 'one' in S.parseAnswers(sample, { one: 'C' }, 'draft').errors);
check('multi choice: unlisted option rejected', 'many' in S.parseAnswers(sample, { many: ['X', 'Q'] }, 'draft').errors);
check('multi choice: duplicates rejected', 'many' in S.parseAnswers(sample, { many: ['X', 'X'] }, 'draft').errors);
check('multi choice: empty selection counts as unanswered', S.parseAnswers(sample, { many: [] }, 'submit').missing.indexOf('many') === -1);
check('link: http rejected', 'lnk' in S.parseAnswers(sample, { lnk: 'http://example.com' }, 'draft').errors);
check('scale: 6 rejected', 'rate' in S.parseAnswers(sample, { rate: 6 }, 'draft').errors);
check('scale: 0 rejected', 'rate' in S.parseAnswers(sample, { rate: 0 }, 'draft').errors);
check('scale: 2.5 rejected', 'rate' in S.parseAnswers(sample, { rate: 2.5 }, 'draft').errors);
check('scale: string "3" rejected (no silent coercion)', 'rate' in S.parseAnswers(sample, { rate: '3' }, 'draft').errors);
check('yes_no: "yes" rejected', 'flag' in S.parseAnswers(sample, { flag: 'yes' }, 'draft').errors);
check('answers must be an object', '_' in S.parseAnswers(sample, ['x'], 'draft').errors);
check('null answers treated as empty', Object.keys(S.parseAnswers(sample, null, 'draft').errors).length === 0);
check('prototype keys are not special', 'constructor' in S.parseAnswers(sample, JSON.parse('{"constructor":"x","__proto__":"y"}'), 'draft').errors);

console.log('--- draftPatchSchema ---');
check('empty patch ok', S.draftPatchSchema.safeParse({}).success);
check('unknown field rejected (strict)', !S.draftPatchSchema.safeParse({ state: 'SUBMITTED' }).success);
check('cannot smuggle state/userId', !S.draftPatchSchema.safeParse({ userId: 'x' }).success);
check('blank resume url allowed in draft', S.draftPatchSchema.safeParse({ resumeUrl: '' }).success);
check('http resume url rejected', !S.draftPatchSchema.safeParse({ resumeUrl: 'http://x.com/a' }).success);
check('5 portfolio links ok', S.draftPatchSchema.safeParse({ portfolioLinks: Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, url: 'https://example.com' })) }).success);
check('6 portfolio links rejected', !S.draftPatchSchema.safeParse({ portfolioLinks: Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, url: 'https://example.com' })) }).success);
check('partial profile ok', S.draftPatchSchema.safeParse({ profile: { major: 'CS' } }).success);
check('bad grad year rejected', !S.draftPatchSchema.safeParse({ profile: { gradYear: 1850 } }).success);

console.log('--- checkCompleteness (shipped placeholder content) ---');
const goodProfile = { fullName: 'Ada Lovelace', email: 'ada@example.com', eid: 'al123', gradYear: 2028, major: 'Math' };
const goodGeneric = { why_join: 'Because.', sim_experience: 3 };
const empty = S.checkCompleteness({ tracks: [] });
check('empty draft is incomplete', !empty.complete);
check('empty draft reports profile, general, tracks and links problems', ['profile', 'general', 'tracks', 'links'].every((k) => empty.sections.some((s) => s.key === k && !s.complete)));
const full = S.checkCompleteness({ ...goodProfile, genericAnswers: goodGeneric, resumeUrl: 'https://example.com/r.pdf', portfolioLinks: [], tracks: [{ track: 'team-b', answers: {} }] });
check('complete single-team draft is complete', full.complete, JSON.stringify(full.sections.filter((s) => !s.complete)));
const noTrackRequired = S.checkCompleteness({ ...goodProfile, genericAnswers: goodGeneric, resumeUrl: 'https://example.com/r.pdf', tracks: [{ track: 'team-a', answers: {} }] });
check('team with an unanswered required question blocks the whole application', !noTrackRequired.complete && noTrackRequired.sections.find((s) => s.key === 'track:team-a')?.complete === false);
const twoTeams = S.checkCompleteness({ ...goodProfile, genericAnswers: goodGeneric, resumeUrl: 'https://example.com/r.pdf', tracks: [{ track: 'team-b', answers: {} }, { track: 'team-a', answers: {} }] });
check('one incomplete team of two -> all-or-nothing: not complete', !twoTeams.complete && twoTeams.sections.find((s) => s.key === 'track:team-b')?.complete === true);
const allThree = S.checkCompleteness({
  ...goodProfile, genericAnswers: goodGeneric, resumeUrl: 'https://example.com/r.pdf',
  tracks: [
    { track: 'team-a', answers: { a_experience: 'x' } },
    { track: 'team-b', answers: {} },
    { track: 'team-c', answers: { c_motivation: 'x', c_hours: '4 to 6', c_link: 'https://example.com' } },
  ],
});
check('three complete teams -> complete', allThree.complete, JSON.stringify(allThree.sections.filter((s) => !s.complete)));
check('unknown team key is a problem', !S.checkCompleteness({ ...goodProfile, genericAnswers: goodGeneric, resumeUrl: 'https://example.com/r.pdf', tracks: [{ track: 'nope', answers: {} }] }).complete);
check('same team twice is a problem', !S.checkCompleteness({ ...goodProfile, genericAnswers: goodGeneric, resumeUrl: 'https://example.com/r.pdf', tracks: [{ track: 'team-b', answers: {} }, { track: 'team-b', answers: {} }] }).complete);
check('http resume link blocks completion', !S.checkCompleteness({ ...goodProfile, genericAnswers: goodGeneric, resumeUrl: 'http://example.com/r.pdf', tracks: [{ track: 'team-b', answers: {} }] }).complete);
check('missing grad year blocks completion', !S.checkCompleteness({ ...goodProfile, gradYear: null, genericAnswers: goodGeneric, resumeUrl: 'https://example.com/r.pdf', tracks: [{ track: 'team-b', answers: {} }] }).complete);
check('invalid email blocks completion', !S.checkCompleteness({ ...goodProfile, email: 'not-an-email', genericAnswers: goodGeneric, resumeUrl: 'https://example.com/r.pdf', tracks: [{ track: 'team-b', answers: {} }] }).complete);
check('checklist problems are readable', full.sections.length === 5 && noTrackRequired.sections.find((s) => s.key === 'track:team-a')!.problems[0].startsWith('Missing: '), JSON.stringify(noTrackRequired.sections.find((s) => s.key === 'track:team-a')));

console.log('--- lookups ---');
check('isTrackKey accepts real key', S.isTrackKey('team-a'));
check('isTrackKey rejects junk', !S.isTrackKey('nope') && !S.isTrackKey(5 as any) && !S.isTrackKey('__proto__'));
check('questionsForTrack unknown -> []', S.questionsForTrack('nope').length === 0);
check('every placeholder team has <= 5 questions', S.tracks.every((t) => S.questionsForTrack(t.key).length <= 5));
check('team-c uses all five slots', S.questionsForTrack('team-c').length === 5);
check('PLACEHOLDER_CONTENT is still true (must be flipped at launch)', S.PLACEHOLDER_CONTENT === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
