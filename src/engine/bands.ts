import type { Band, BandThresholds, Question } from '../types.js';

export const DEFAULT_BANDS: Readonly<BandThresholds> = Object.freeze({ act: 0.85, confirm: 0.6 });

/** Question bands override the defaults, which override DEFAULT_BANDS. */
export function resolveBands(question?: Pick<Question, 'bands'>, defaults?: Partial<BandThresholds>): BandThresholds {
  return {
    act: question?.bands?.act ?? defaults?.act ?? DEFAULT_BANDS.act,
    confirm: question?.bands?.confirm ?? defaults?.confirm ?? DEFAULT_BANDS.confirm,
  };
}

export function bandFor(confidence: number, thresholds: BandThresholds = DEFAULT_BANDS): Band {
  if (confidence >= thresholds.act) return 'act';
  if (confidence >= thresholds.confirm) return 'confirm';
  return 'escalate';
}
