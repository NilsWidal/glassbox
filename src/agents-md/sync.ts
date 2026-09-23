import { join } from 'node:path';
import { readInsideOrNull, writeInside } from '../util/safefs.js';
import { END_MARKER, START_MARKER, renderBlock, withoutStamp } from './render.js';
import type {
  AgentsMdSummary,
  FileAction,
  SyncAgentsMdOptions,
  SyncAgentsMdResult,
} from './types.js';

const AGENTS_HEADER = '# AGENTS.md\n\nInstructions for coding agents working in this repository.\n';
const IMPORT_LINE = '@AGENTS.md';
const IMPORT_FORMS = new Set(['@AGENTS.md', '@./AGENTS.md']);

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
  const start = existing.indexOf(START_MARKER);
  if (start === -1) {
    // Append after existing text, separated by one blank line.
    const trimmed = existing.replace(/(\r?\n)+$/, '');
    const sep = trimmed.length === 0 ? '' : eol + eol;
    return `${trimmed}${sep}${withEol(block, eol)}${eol}`;
  }
  const end = existing.indexOf(END_MARKER, start);
  if (end === -1) {
    throw new Error(`AGENTS.md has '${START_MARKER}' without '${END_MARKER}'; fix it by hand`);
  }
  const old = existing.slice(start, end + END_MARKER.length);
  if (withoutStamp(old) === withoutStamp(block)) return existing;
  return existing.slice(0, start) + withEol(block, eol) + existing.slice(end + END_MARKER.length);
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
  const rendered = renderBlock(summary, opts.maxLines);

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
