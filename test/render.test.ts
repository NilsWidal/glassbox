import { describe, expect, it } from 'vitest';
import { callsText } from '../src/render.js';

describe('callsText', () => {
  it('shows the model runs a sampled CLI backend starts', () => {
    expect(callsText(2)).toBe('2 calls');
    expect(callsText(1, 1)).toBe('1 call');
    expect(callsText(2, 3)).toBe('2 calls x 3 samples = 6 model runs');
  });
});
