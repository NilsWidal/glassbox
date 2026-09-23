const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Label for option i: A..Z, then AA, AB, ... (single tokens up to 26 options). */
export function labelFor(i: number): string {
  if (!Number.isInteger(i) || i < 0) throw new RangeError(`bad label index ${i}`);
  let n = i;
  let out = '';
  do {
    out = ALPHABET[n % 26] + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export function labelsFor(count: number): string[] {
  return Array.from({ length: count }, (_, i) => labelFor(i));
}
