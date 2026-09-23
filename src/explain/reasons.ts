import type { ReasonCode, YesNoQuestion } from '../types.js';

/** A reason code and the yes/no question that checks it. */
export interface ReasonSpec {
  code: string;
  question: string;
}

/** Generic reasons for questions about code. Users can replace or extend them. */
export const DEFAULT_REASONS: readonly ReasonSpec[] = Object.freeze([
  { code: 'changes-behavior', question: 'Does the code change or define runtime behavior (not only comments, formatting or types)?' },
  { code: 'reads-config', question: 'Does the code read configuration or environment variables?' },
  { code: 'side-effects', question: 'Does the code have side effects such as I/O, network, database or global state?' },
  { code: 'auth-or-permissions', question: 'Does the code deal with authentication, sessions or permissions?' },
  { code: 'missing-check', question: 'Is a validation, fallback or error check missing where one would be expected?' },
]);

export const REASON_PREFIX = 'reason:';

/**
 * Parses "code=question" items. A bare code picks the default reason with
 * that code; an unknown bare code becomes a generic "does this apply" check.
 */
export function parseReasons(items: readonly string[]): ReasonSpec[] {
  const out: ReasonSpec[] = [];
  for (const item of items) {
    const raw = item.trim();
    if (!raw) continue;
    const eq = raw.indexOf('=');
    if (eq > 0) {
      out.push({ code: raw.slice(0, eq).trim(), question: raw.slice(eq + 1).trim() });
      continue;
    }
    const known = DEFAULT_REASONS.find((r) => r.code === raw);
    out.push(known ?? { code: raw, question: `Does "${raw}" apply to this code?` });
  }
  return out;
}

/** Hidden yes/no questions, keyed `reason:<code>`, framed by the main question. */
export function reasonQuestions(reasons: readonly ReasonSpec[], mainQuestion: string): Record<string, YesNoQuestion> {
  const out: Record<string, YesNoQuestion> = {};
  for (const r of reasons) {
    out[`${REASON_PREFIX}${r.code}`] = {
      type: 'yesno',
      instructions: `Context: this checks one possible reason behind the answer to "${mainQuestion.trim()}".\n${r.question}`,
    };
  }
  return out;
}

/** Reason codes from P(yes) per code (prefix already stripped), most likely first. */
export function collectReasons(reasons: readonly ReasonSpec[], pYes: Readonly<Record<string, number>>): ReasonCode[] {
  return reasons
    .filter((r) => pYes[r.code] !== undefined)
    .map((r): ReasonCode => ({ code: r.code, p: pYes[r.code]!, kind: 'causal' }))
    .sort((a, b) => b.p - a.p);
}
