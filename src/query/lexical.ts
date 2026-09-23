import type { GraphNode, Tag } from '../types.js';

const STOPWORDS = new Set(
  (
    'a an and any are as at be by can code do does for from get has have how i if in into is it its of on or our ' +
    'should so that the their them then there these this to use used uses was we what when where which who why will ' +
    'with would you your implement implemented implements handle handled handles happen happens logic function'
  ).split(' '),
);

/** Tag question ids and the concept words that make a "yes" on them relevant. */
const TAG_WORDS: Readonly<Record<string, readonly string[]>> = {
  handles_auth: ['auth', 'login', 'logout', 'session', 'password', 'token', 'permission', 'credential', 'signin', 'jwt'],
  side_effects: ['write', 'save', 'send', 'network', 'database', 'db', 'io', 'persist', 'http', 'request'],
  touches_pii: ['pii', 'email', 'personal', 'address', 'phone', 'privacy', 'gdpr', 'name'],
};

/** Lowercase word tokens, with camelCase, snake_case and paths split. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Query terms: tokens minus stopwords, deduplicated. */
export function queryTerms(text: string): string[] {
  return [...new Set(tokenize(text).filter((t) => !STOPWORDS.has(t)))];
}

/** Loose word match that tolerates plurals and tense: "retried" ~ "retry", "billing" ~ "bill". */
export function termsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 3) return false;
  let cp = 0;
  while (cp < n && a[cp] === b[cp]) cp++;
  return cp >= Math.max(4, n - 1) || (cp === n && n >= 3 && Math.max(a.length, b.length) - n <= 3);
}

/** Crude English stem: sessions -> session, retries -> retry, charged -> charg. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
  }
  return w;
}

/**
 * Stricter than termsMatch, for context nobody asked for: the same word up to
 * a plural or tense ending ("sessions" ~ "session", "retries" ~ "retry"), but
 * not a shared prefix ("chart" is not "charge").
 */
export function strictTermsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 3) return false;
  const sa = stem(a);
  const sb = stem(b);
  return sa === sb || sa === b || a === sb;
}

type Matcher = (a: string, b: string) => boolean;

function anyMatch(term: string, words: Iterable<string>, match: Matcher): boolean {
  for (const w of words) if (match(term, w)) return true;
  return false;
}

export interface LexicalInput {
  node: Pick<GraphNode, 'id' | 'name' | 'file'>;
  /** Node source, if read. */
  text?: string;
  tags?: readonly Tag[];
}

/**
 * Cheap relevance of a node to query terms: name hits weigh most, then the
 * path, then the body, plus a boost when a stored tag says yes to a related
 * question or names a matching area. No model calls.
 */
export function lexicalScore(terms: readonly string[], input: LexicalInput, match: Matcher = termsMatch): number {
  if (terms.length === 0) return 0;
  const name = new Set(tokenize(input.node.name));
  const path = new Set(tokenize(input.node.file));
  const body = input.text ? new Set(tokenize(input.text)) : new Set<string>();
  let score = 0;
  for (const t of terms) {
    if (anyMatch(t, name, match)) score += 3;
    else if (anyMatch(t, path, match)) score += 2;
    if (anyMatch(t, body, match)) score += 1;
    for (const tag of input.tags ?? []) {
      if (tag.questionId === 'area' && match(t, tag.answer)) score += 2 * tag.p;
      const words = TAG_WORDS[tag.questionId];
      if (words && tag.answer === 'true' && words.some((w) => match(t, w))) score += 2 * tag.p;
    }
  }
  return Math.round(score * 1000) / 1000;
}
