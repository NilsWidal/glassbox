import type { Question } from '../types.js';

export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

export class QuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionError';
  }
}

/** Option keys in canonical order: 'true','false' / criteria keys / level indexes. */
export function optionKeys(question: Question): string[] {
  switch (question.type) {
    case 'yesno':
      return ['true', 'false'];
    case 'choice':
      return Object.keys(question.criteria);
    case 'score':
      return question.criteria.map((_, i) => String(i));
  }
}

/** Human description of one option, for the prompt. */
export function optionDescription(question: Question, key: string): string {
  switch (question.type) {
    case 'yesno': {
      const base = key === 'true' ? 'yes' : 'no';
      const desc = key === 'true' ? question.criteria?.true : question.criteria?.false;
      return desc ? `${base}: ${desc}` : base;
    }
    case 'choice': {
      const desc = question.criteria[key];
      return desc ? `${key}: ${desc}` : key;
    }
    case 'score':
      return `level ${key}: ${question.criteria[Number(key)] ?? ''}`;
  }
}

/** Throws QuestionError when a question is malformed. */
export function validateQuestion(id: string, question: Question): void {
  const where = `question "${id}"`;
  if (!question || typeof question !== 'object') throw new QuestionError(`${where}: not an object`);
  if (typeof question.instructions !== 'string' || question.instructions.trim() === '') {
    throw new QuestionError(`${where}: instructions must be a non-empty string`);
  }
  switch (question.type) {
    case 'yesno':
      break;
    case 'choice': {
      const keys = Object.keys(question.criteria ?? {});
      if (keys.length < 2) throw new QuestionError(`${where}: choice needs at least 2 options`);
      break;
    }
    case 'score': {
      const levels = question.criteria;
      if (!Array.isArray(levels) || levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS) {
        throw new QuestionError(`${where}: score needs ${MIN_SCORE_LEVELS} to ${MAX_SCORE_LEVELS} ordered levels`);
      }
      break;
    }
    default:
      throw new QuestionError(`${where}: unknown type ${JSON.stringify((question as { type?: unknown }).type)}`);
  }
  const bands = question.bands;
  if (bands) {
    for (const k of ['act', 'confirm'] as const) {
      const v = bands[k];
      if (v !== undefined && (typeof v !== 'number' || v < 0 || v > 1)) {
        throw new QuestionError(`${where}: bands.${k} must be in [0, 1]`);
      }
    }
  }
}
