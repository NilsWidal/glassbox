import { optionKeys } from '../engine/questions.js';
import type {
  Backend,
  BackendCapabilities,
  BatchQuestion,
  GenerateOptions,
  LabelDistribution,
  Question,
  State,
} from '../types.js';
import { fnv1a, seededRandom, stateText } from '../util/hash.js';

export interface FakeRuleContext {
  state: State;
  /** The state as prompt text (objects are stable-stringified). */
  text: string;
  questionId: string;
  question: Question;
  /** Option keys in canonical order. */
  options: string[];
}

/**
 * A scripted answer: a number is P(true) for yesno questions; a record maps
 * option keys to (unnormalized) probabilities. Return undefined to fall through.
 */
export type FakeRuleResult = number | Record<string, number> | undefined;
export type FakeRule = (ctx: FakeRuleContext) => FakeRuleResult;

export interface FakeBackendOptions {
  name?: string;
  model?: string;
  seed?: number;
  /** Tried in order; the first defined result wins. */
  rules?: FakeRule[];
  /** Extra mass added to whichever option is shown first (label A), to test shuffling. */
  positionBias?: number;
  /** Set false to force one call per question. Default true. */
  batch?: boolean;
  delayMs?: number;
  /** Throw from answerBatch for these call numbers (0-based). */
  failCalls?: number[];
  generate?: (prompt: string) => string;
}

export interface FakeCall {
  state: State;
  questions: Record<string, BatchQuestion>;
}

/** Deterministic, offline backend for tests. */
export class FakeBackend implements Backend {
  readonly name: string;
  readonly model: string;
  readonly capabilities: BackendCapabilities;
  readonly calls: FakeCall[] = [];
  readonly generated: string[] = [];
  private readonly opts: FakeBackendOptions;

  constructor(opts: FakeBackendOptions = {}) {
    this.opts = opts;
    this.name = opts.name ?? 'fake';
    this.model = opts.model ?? 'fake-1';
    this.capabilities = { hasLogprobs: true, batch: opts.batch ?? true, generate: true };
  }

  async answerBatch(
    state: State,
    questions: Record<string, BatchQuestion>,
  ): Promise<Record<string, LabelDistribution>> {
    const callNo = this.calls.length;
    this.calls.push({ state, questions });
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (this.opts.failCalls?.includes(callNo)) throw new Error(`fake failure on call ${callNo}`);

    const text = stateText(state);
    const out: Record<string, LabelDistribution> = {};
    for (const [id, item] of Object.entries(questions)) {
      const byOption = this.distribution({ state, text, questionId: id, question: item.question, options: optionKeys(item.question) });
      const shown = item.options.map((k) => byOption[k] ?? 0);
      if (this.opts.positionBias && shown.length > 0) shown[0] = shown[0]! + this.opts.positionBias;
      const sum = shown.reduce((a, b) => a + b, 0) || 1;
      out[id] = Object.fromEntries(item.labels.map((l, j) => [l, shown[j]! / sum]));
    }
    return out;
  }

  async generate(prompt: string, _opts?: GenerateOptions): Promise<string> {
    this.generated.push(prompt);
    return this.opts.generate ? this.opts.generate(prompt) : `fake answer ${fnv1a(prompt).toString(16)}`;
  }

  /** Probabilities by option key, independent of display order, so shuffling cancels only positionBias. */
  distribution(ctx: FakeRuleContext): Record<string, number> {
    for (const rule of this.opts.rules ?? []) {
      const r = rule(ctx);
      if (r === undefined) continue;
      if (typeof r === 'number') {
        if (ctx.question.type !== 'yesno') throw new Error('numeric fake rule results are only for yesno questions');
        return { true: r, false: 1 - r };
      }
      return normalizeRecord(ctx.options, r);
    }
    // Seeded by the question text and state, so the same prompt always gets the same answer.
    const base = fnv1a(`${this.opts.seed ?? 0}\u0000${ctx.text}\u0000${ctx.question.instructions}`);
    const weights = ctx.options.map((k) => {
      const rand = seededRandom((base ^ fnv1a(k)) >>> 0);
      return Math.pow(rand() + 0.05, 3);
    });
    return normalizeRecord(ctx.options, Object.fromEntries(ctx.options.map((k, i) => [k, weights[i]!])));
  }
}

function normalizeRecord(options: string[], r: Record<string, number>): Record<string, number> {
  const vals = options.map((k) => Math.max(0, r[k] ?? 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  return Object.fromEntries(options.map((k, i) => [k, sum > 0 ? vals[i]! / sum : 1 / options.length]));
}

/**
 * Rule: answer depends on whether `substring` appears in the state text.
 * Useful for hide-and-re-ask tests: hiding the span flips the probability.
 */
export function whenContains(
  substring: string,
  present: Exclude<FakeRuleResult, undefined>,
  absent: Exclude<FakeRuleResult, undefined>,
  questionId?: string,
): FakeRule {
  return (ctx) => {
    if (questionId !== undefined && ctx.questionId !== questionId) return undefined;
    return ctx.text.includes(substring) ? present : absent;
  };
}

/** Rule: fixed answer for one question id. */
export function fixedAnswer(questionId: string, result: Exclude<FakeRuleResult, undefined>): FakeRule {
  return (ctx) => (ctx.questionId === questionId ? result : undefined);
}

export function createFakeBackend(opts?: FakeBackendOptions): FakeBackend {
  return new FakeBackend(opts);
}
