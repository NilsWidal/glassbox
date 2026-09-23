import { answerLabel } from '../render.js';
import { spanLabel, type Chunk } from '../scope.js';
import type { Answer, Backend, Highlight, Question } from '../types.js';

export const WHY_MAX_WORDS = 12;
/** Most state text included in the why prompt. */
const MAX_STATE_CHARS = 8000;
// Built from code points so the source itself stays free of dash characters.
const EM_DASH = new RegExp(`\\s*${String.fromCharCode(0x2014)}\\s*`, 'g');
const EN_DASH = new RegExp(String.fromCharCode(0x2013), 'g');

export interface WhyInput {
  question: Question;
  answer: Answer;
  /** The chunks the answer was made from. */
  chunks: readonly Chunk[];
  highlights?: readonly Highlight[];
  signal?: AbortSignal;
}

export interface WhyResult {
  why?: { text: string; kind: 'narrative' };
  /** One comment per highlight, same order; undefined where the model gave none. */
  comments: (string | undefined)[];
}

/** Generate the why only on request, or when the answer is not confident enough to act on. */
export function shouldExplainWhy(answer: Answer, requested: boolean | undefined): boolean {
  if (requested !== undefined) return requested;
  return answer.band !== 'act';
}

/** Trims to at most `max` words and swaps dashes and quotes for plain punctuation. */
export function clampWords(text: string, max = WHY_MAX_WORDS): string {
  const clean = text
    .replace(EM_DASH, ', ')
    .replace(EN_DASH, '-')
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = clean.split(' ').filter(Boolean);
  return words.length <= max ? clean : words.slice(0, max).join(' ').replace(/[,;:]$/, '');
}

// Data first, then a concrete instruction: small models read a leading
// "you explain..." line as a setup message and ask for the code instead.
export function buildWhyPrompt(input: WhyInput): string {
  const { question, answer } = input;
  const highlights = input.highlights ?? [];
  const label = answerLabel(answer);
  const lines = [
    'Below is a finished decision about some code. Write short plain-English notes for it.',
    '',
    `<question>${question.instructions.trim()}</question>`,
    `<answer>${label} (confidence ${answer.confidence.toFixed(2)})</answer>`,
  ];
  if (highlights.length > 0) {
    lines.push('<evidence>');
    highlights.forEach((h, i) => {
      const chunk = input.chunks.find((c) => c.file === h.file && c.startLine === h.startLine && c.endLine === h.endLine);
      lines.push(`[H${i + 1}] ${spanLabel(h.file, h.startLine, h.endLine)} (hiding this span changed the probability by ${h.deltaP.toFixed(2)})`);
      if (chunk) lines.push(chunk.text);
    });
    lines.push('</evidence>');
  } else {
    let text = input.chunks.map((c) => `### ${spanLabel(c.file, c.startLine, c.endLine)}\n${c.text}`).join('\n\n');
    if (text.length > MAX_STATE_CHARS) text = `${text.slice(0, MAX_STATE_CHARS)}\n...`;
    lines.push('<code>', text, '</code>');
  }
  lines.push(
    '',
    `Now write exactly these lines and nothing else. Each note has at most ${WHY_MAX_WORDS} words and uses only facts visible in the code above.`,
    `WHY: <why the answer is ${label}>`,
    ...highlights.map((_, i) => `H${i + 1}: <what span H${i + 1} does that matters>`),
  );
  return lines.join('\n');
}

/** Parses "WHY: ..." and "H1: ..." lines. Anything else is ignored. */
export function parseWhy(text: string, highlightCount: number): WhyResult {
  const comments: (string | undefined)[] = Array.from({ length: highlightCount }, () => undefined);
  let why: string | undefined;
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?\**(WHY|H(\d+))\**\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const body = clampWords(m[3]!);
    if (!body) continue;
    if (m[2] === undefined) why ??= body;
    else {
      const i = Number(m[2]) - 1;
      if (i >= 0 && i < highlightCount) comments[i] ??= body;
    }
  }
  // A model that ignored the format still gave a usable first line.
  if (why === undefined && highlightCount === 0) {
    const first = text.split('\n').map((l) => l.trim()).find(Boolean);
    if (first) why = clampWords(first);
  }
  return { ...(why ? { why: { text: why, kind: 'narrative' as const } } : {}), comments };
}

/**
 * The lazy one-line why (and one comment per highlight) in ONE generate call.
 * Returns nothing when the backend cannot generate text or the call fails:
 * the why is optional narrative and must never break a decision.
 */
export async function explainWhy(backend: Backend, input: WhyInput): Promise<WhyResult | undefined> {
  if (!backend.capabilities.generate || !backend.generate) return undefined;
  try {
    const text = await backend.generate(buildWhyPrompt(input), {
      maxTokens: 64 + 32 * (input.highlights?.length ?? 0),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return parseWhy(text, input.highlights?.length ?? 0);
  } catch {
    return undefined;
  }
}
