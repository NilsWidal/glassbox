import { describe, expect, it } from 'vitest';
import { QuestionError, labelFor, labelsFor, optionDescription, optionKeys, validateQuestion } from '../src/index.js';
import type { Question } from '../src/index.js';

describe('optionKeys', () => {
  it('uses true/false for yesno', () => {
    expect(optionKeys({ type: 'yesno', instructions: 'x' })).toEqual(['true', 'false']);
  });
  it('uses criteria keys in insertion order for choice', () => {
    expect(optionKeys({ type: 'choice', instructions: 'x', criteria: { bug: 'a', feature: 'b', chore: 'c' } })).toEqual([
      'bug',
      'feature',
      'chore',
    ]);
  });
  it('uses level indexes for score', () => {
    expect(optionKeys({ type: 'score', instructions: 'x', criteria: ['low', 'mid', 'high'] })).toEqual(['0', '1', '2']);
  });
});

describe('optionDescription', () => {
  it('describes yesno with and without criteria', () => {
    expect(optionDescription({ type: 'yesno', instructions: 'x' }, 'true')).toBe('yes');
    expect(optionDescription({ type: 'yesno', instructions: 'x', criteria: { false: 'no auth code' } }, 'false')).toBe(
      'no: no auth code',
    );
  });
  it('describes choice and score options', () => {
    expect(optionDescription({ type: 'choice', instructions: 'x', criteria: { bug: 'broken' } }, 'bug')).toBe('bug: broken');
    expect(optionDescription({ type: 'score', instructions: 'x', criteria: ['calm', 'angry'] }, '1')).toBe('level 1: angry');
  });
});

describe('validateQuestion', () => {
  const ok: Question[] = [
    { type: 'yesno', instructions: 'Is it async?' },
    { type: 'choice', instructions: 'Kind?', criteria: { a: '', b: '' } },
    { type: 'score', instructions: 'Risk?', criteria: ['low', 'high'] },
    { type: 'score', instructions: 'Risk?', criteria: Array.from({ length: 10 }, (_, i) => `l${i}`) },
  ];
  it.each(ok)('accepts %#', (q) => expect(() => validateQuestion('q', q)).not.toThrow());

  const bad: Array<[string, unknown]> = [
    ['empty instructions', { type: 'yesno', instructions: '  ' }],
    ['one choice option', { type: 'choice', instructions: 'x', criteria: { a: '' } }],
    ['one score level', { type: 'score', instructions: 'x', criteria: ['a'] }],
    ['eleven score levels', { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, () => 'l') }],
    ['unknown type', { type: 'noul', instructions: 'x' }],
    ['band out of range', { type: 'yesno', instructions: 'x', bands: { act: 1.5 } }],
  ];
  it.each(bad)('rejects %s', (_name, q) => {
    expect(() => validateQuestion('q', q as Question)).toThrow(QuestionError);
  });
});

describe('labels', () => {
  it('produces A..Z then AA', () => {
    expect(labelsFor(3)).toEqual(['A', 'B', 'C']);
    expect(labelFor(25)).toBe('Z');
    expect(labelFor(26)).toBe('AA');
    expect(labelFor(27)).toBe('AB');
    expect(labelFor(26 + 26)).toBe('BA');
  });
  it('labels are unique for many options', () => {
    const ls = labelsFor(300);
    expect(new Set(ls).size).toBe(300);
  });
  it('rejects bad indexes', () => {
    expect(() => labelFor(-1)).toThrow(RangeError);
  });
});
