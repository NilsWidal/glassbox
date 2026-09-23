import { join } from 'node:path';
import { loadProjectConfigSafe } from '../project-config.js';
import { conciseRulesEnabled } from '../style/concise.js';
import { readInsideOrNull, writeInside } from '../util/safefs.js';
import { END_MARKER, START_MARKER, renderBlock, withoutStamp } from './render.js';
import type {
  AgentsMdSummary,
  FileAction,
  SyncAgentsMdOptions,
  SyncAgentsMdResult,
} from './types.js';

export const AGENTS_HEADER = '# AGENTS.md\n\nInstructions for coding agents working in this repository.\n';
export const IMPORT_LINE = '@AGENTS.md';
const IMPORT_FORMS = new Set(['@AGENTS.md', '@./AGENTS.md']);

/** Where a marker sits: character offsets of the marker line's text (without its line break). */
export interface MarkerSpan {
  start: number;
  end: number;
  /** 1-based line number. */
  line: number;
}

/**
 * Lines that hold only `marker` (spaces around it allowed). A marker quoted
 * inside other text, e.g. in prose or a code span, does not count.
 */
export function markerLines(text: string, marker: string): MarkerSpan[] {
  const out: MarkerSpan[] = [];
  let offset = 0;
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === marker) out.push({ start: offset, end: offset + line.length, line: i + 1 });
    offset += raw.length + 1;
  });
  return out;
}

/** The glassbox block's line range (1-based, markers included), when there is exactly one well-formed block. */
export function blockLineRange(text: string): { start: number; end: number } | undefined {
  const starts = markerLines(text, START_MARKER);
  if (starts.length !== 1) return undefined;
  const end = markerLines(text, END_MARKER).find((e) => e.start > starts[0]!.start);
  return end ? { start: starts[0]!.line, end: end.line } : undefined;
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function withEol(text: string, eol: string): string {
  return eol === '\n' ? text : text.replace(/\r?\n/g, eol);
}

/** Pure: the new AGENTS.md content, or the same string when nothing changed. */
export function upsertBlock(existing: string | null, block: string): string {
  if (existing === null) return `${AGENTS_HEADER}\n${block}\n`;
  const eol = eolOf(existing);
  const starts = markerLines(existing, START_MARKER);
  if (starts.length > 1) {
    throw new Error(
      `AGENTS.md has ${starts.length} '${START_MARKER}' lines (lines ${starts.map((m) => m.line).join(', ')}); ` +
        'keep one glassbox block and remove the others by hand',
    );
  }
  if (starts.length === 0) {
    // Append after existing text, separated by one blank line.
    const trimmed = existing.replace(/(\r?\n)+$/, '');
    const sep = trimmed.length === 0 ? '' : eol + eol;
    return `${trimmed}${sep}${withEol(block, eol)}${eol}`;
  }
  const start = starts[0]!;
  const end = markerLines(existing, END_MARKER).find((m) => m.start > start.start);
  if (!end) {
    throw new Error(`AGENTS.md has '${START_MARKER}' without '${END_MARKER}'; fix it by hand`);
  }
  const old = existing.slice(start.start, end.end);
  if (withoutStamp(old.replace(/\r\n/g, '\n')) === withoutStamp(block)) return existing;
  return existing.slice(0, start.start) + withEol(block, eol) + existing.slice(end.end);
}

export function hasAgentsImport(claudeMd: string): boolean {
  return claudeMd.split(/\r?\n/).some((l) => IMPORT_FORMS.has(l.trim()));
}

/** Pure: CLAUDE.md with the import appended, or unchanged when already present. */
export function addAgentsImport(existing: string): string {
  if (hasAgentsImport(existing)) return existing;
  const eol = eolOf(existing);
  const trimmed = existing.replace(/(\r?\n)+$/, '');
  const sep = trimmed.length === 0 ? '' : eol + eol;
  return `${trimmed}${sep}${IMPORT_LINE}${eol}`;
}

/**
 * Writes the glassbox block into AGENTS.md and makes CLAUDE.md import it.
 * Text outside the markers is never changed; a second run with the same summary writes nothing.
 * Symlinked files, or files that resolve outside the repo, are refused.
 */
export async function syncAgentsMd(
  repoRoot: string,
  summary: AgentsMdSummary,
  opts: SyncAgentsMdOptions = {},
): Promise<SyncAgentsMdResult> {
  const agentsMdPath = join(repoRoot, 'AGENTS.md');
  const claudeMdPath = join(repoRoot, 'CLAUDE.md');
  const conciseRules = opts.conciseRules ?? conciseRulesEnabled(process.env, loadProjectConfigSafe(repoRoot));
  const rendered = renderBlock(summary, { ...(opts.maxLines !== undefined ? { maxLines: opts.maxLines } : {}), conciseRules });

  const agentsOld = await readInsideOrNull(repoRoot, agentsMdPath);
  const agentsNew = upsertBlock(agentsOld, rendered.text);
  let agentsMd: FileAction = 'unchanged';
  if (agentsNew !== agentsOld) {
    await writeInside(repoRoot, agentsMdPath, agentsNew);
    agentsMd = agentsOld === null ? 'created' : 'updated';
  }

  const claudeOld = await readInsideOrNull(repoRoot, claudeMdPath);
  let claudeMd: FileAction;
  if (claudeOld === null) {
    if (opts.claudeMd === false) {
      claudeMd = 'skipped';
    } else {
      await writeInside(repoRoot, claudeMdPath, `${IMPORT_LINE}\n`);
      claudeMd = 'created';
    }
  } else {
    const claudeNew = addAgentsImport(claudeOld);
    claudeMd = claudeNew === claudeOld ? 'unchanged' : 'updated';
    if (claudeMd === 'updated') await writeInside(repoRoot, claudeMdPath, claudeNew);
  }

  return {
    agentsMdPath,
    claudeMdPath,
    agentsMd,
    claudeMd,
    truncated: rendered.truncated,
    lines: rendered.lines,
  };
}
