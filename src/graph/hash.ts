import { sha256 } from '../util/hash.js';

/**
 * Normalizes source so whitespace-only edits and moving a block to another
 * indentation level do not change its hash: LF line endings, no trailing
 * spaces, no blank lines, common indentation removed.
 */
export function normalizeSource(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0);
  let indent = Infinity;
  for (const l of lines) indent = Math.min(indent, l.length - l.trimStart().length);
  if (!Number.isFinite(indent) || indent === 0) return lines.join('\n');
  return lines.map((l) => l.slice(indent)).join('\n');
}

export function contentHash(text: string): string {
  return sha256(normalizeSource(text));
}
