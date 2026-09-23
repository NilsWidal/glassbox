import type { Answer, BandThresholds, Question } from '../types.js';
import { bandFor } from './bands.js';
import { argmax, confidence, expectedScore, normalize } from './confidence.js';
import { optionKeys } from './questions.js';

/** Builds the typed answer from probabilities in canonical option order (see optionKeys). */
export function buildAnswer(question: Question, probs: readonly number[], bands: BandThresholds): Answer {
  const keys = optionKeys(question);
  if (probs.length !== keys.length) {
    throw new RangeError(`expected ${keys.length} probabilities, got ${probs.length}`);
  }
  const p = normalize(probs);
  const conf = confidence(p);
  const band = bandFor(conf, bands);
  switch (question.type) {
    case 'yesno':
      return { type: 'yesno', p: p[0]!, confidence: conf, band };
    case 'choice':
      return {
        type: 'choice',
        choice: keys[argmax(p)]!,
        probabilities: toRecord(keys, p),
        confidence: conf,
        band,
      };
    case 'score':
      return {
        type: 'score',
        score: expectedScore(p),
        legend: toRecord(keys, question.criteria),
        probabilities: toRecord(keys, p),
        confidence: conf,
        band,
      };
  }
}

/** The winning option key of an answer ('true'/'false', a choice key, or the most likely level). */
export function winningOption(answer: Answer): string {
  switch (answer.type) {
    case 'yesno':
      return answer.p >= 0.5 ? 'true' : 'false';
    case 'choice':
      return answer.choice;
    case 'score': {
      const keys = Object.keys(answer.probabilities);
      return keys[argmax(keys.map((k) => answer.probabilities[k]!))]!;
    }
  }
}

export function toRecord<T>(keys: readonly string[], values: readonly T[]): Record<string, T> {
  return Object.fromEntries(keys.map((k, i) => [k, values[i]!]));
}
