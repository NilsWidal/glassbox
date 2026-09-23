import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ambientContext } from '../ambient/context.js';
import { MODE_SETTINGS } from '../modes.js';
import { envFlag, loadProjectConfigSafe } from '../project-config.js';
import { ambientEnabled, gateEnabled } from '../status.js';
import type { Backend } from '../types.js';
import { sha256 } from '../util/hash.js';
import { assertNotSymlinkSync } from '../util/safefs.js';
import { maybeStartWorker, resumePendingWorker, workerPending, type DetachedSpawner, type StartOptions } from '../worker/index.js';

/**
 * Entry points for agent hooks (`glassbox hook <event>`). Each reads the
 * host's hook JSON from stdin and returns what to print. They fail open: any
 * error, a nested glassbox call (GLASSBOX_NESTED=1) or a repo without
 * .glassbox/ gives empty output, and the caller always exits 0.
 */

const STORE_DIR = '.glassbox';
const STORE_FILE = 'graph.db';
export const GATE_STATE_FILE = 'gate.json';
export const MAX_HOOK_INPUT = 1024 * 1024;
const MAX_PROMPT = 20_000;
export const DEFAULT_GATE_TIMEOUT_MS = 45_000;
/**
 * Longest the gate may ever take, whatever the settings say: below the 60 s
 * the plugin's hooks.json gives the Stop hook, so glassbox stops its own
 * model calls (and their processes) before the host kills the hook.
 */
export const GATE_TIMEOUT_CAP_MS = 50_000;
/** Most graph matches the prompt hook may list, whatever the config says. */
const MAX_AMBIENT_HITS = 20;
const MAX_REASON_HUNKS = 6;

/** The fields glassbox reads from Claude Code and Codex hook input. */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: unknown;
}

/** Parses hook JSON; anything unreadable is an empty input. */
export function parseHookInput(text: string): HookInput {
  if (!text.trim() || text.length > MAX_HOOK_INPUT) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const o = v as Record<string, unknown>;
    const out: HookInput = {};
    for (const k of ['hook_event_name', 'session_id', 'cwd', 'prompt', 'tool_name'] as const) {
      if (typeof o[k] === 'string') out[k] = o[k];
    }
    if (typeof o.stop_hook_active === 'boolean') out.stop_hook_active = o.stop_hook_active;
    if (o.tool_input !== undefined) out.tool_input = o.tool_input;
    return out;
  } catch {
    return {};
  }
}

/**
 * The repo whose graph the hook works on: the nearest directory at or above
 * the start (an explicit root, CLAUDE_PROJECT_DIR, the input's cwd, else the
 * process cwd) that has .glassbox/graph.db, not going above a git root.
 * Undefined when there is none, so the hook does nothing.
 */
export function findGraphRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, STORE_DIR, STORE_FILE))) return dir;
    if (existsSync(join(dir, '.git'))) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

export interface HookContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** --root: skips the search. */
  root?: string;
  /** --host: claude-code or codex, passed to the worker and the gate's backend. */
  host?: string;
  /** CLI entry file, for starting the worker. */
  entry?: string;
  spawner?: DetachedSpawner;
  now?: () => number;
  /** Builds the gate's backend with the given samples per call. */
  backend?: (opts: { samples?: number; env: NodeJS.ProcessEnv }) => Backend;
  /** Aborted when the hook process is told to stop (SIGTERM from the host); the gate then stops its model calls. */
  signal?: AbortSignal;
}

function rootFor(input: HookInput, ctx: HookContext): string | undefined {
  const usable = (v: string | undefined) => (v?.trim() && !v.includes('${') ? v.trim() : undefined);
  const start = usable(ctx.root) ?? usable(ctx.env.CLAUDE_PROJECT_DIR) ?? usable(input.cwd) ?? ctx.cwd;
  return findGraphRoot(resolve(ctx.cwd, start));
}

function hostEnv(ctx: HookContext): NodeJS.ProcessEnv {
  return ctx.host && !ctx.env.GLASSBOX_HOST?.trim() ? { ...ctx.env, GLASSBOX_HOST: ctx.host } : ctx.env;
}

function startOptions(ctx: HookContext, entry: string): StartOptions {
  return {
    env: hostEnv(ctx),
    entry,
    ...(ctx.spawner ? { spawner: ctx.spawner } : {}),
    ...(ctx.now ? { now: ctx.now() } : {}),
    ...(ctx.host ? { host: ctx.host } : {}),
  };
}

/** Starts a re-tag run that an earlier hook had to put off, once it is allowed. Never throws. */
function resumeWorker(root: string, ctx: HookContext): void {
  if (ctx.entry) resumePendingWorker(root, startOptions(ctx, ctx.entry));
}

/** The v0.1 edit hooks switch: GLASSBOX_HOOKS, else the plugin's enable_hooks option. Default off. */
export function editHooksEnabled(env: NodeJS.ProcessEnv): boolean {
  return envFlag(env.GLASSBOX_HOOKS) ?? envFlag(env.CLAUDE_PLUGIN_OPTION_ENABLE_HOOKS) ?? false;
}

// ------------------------------------------------------------ UserPromptSubmit

/**
 * UserPromptSubmit: graph-only context for the prompt (no model call), as
 * `hookSpecificOutput.additionalContext`, which both Claude Code and Codex read.
 */
export function promptHook(input: HookInput, ctx: HookContext): string {
  if (ctx.env.GLASSBOX_NESTED === '1') return '';
  const root = rootFor(input, ctx);
  if (!root) return '';
  resumeWorker(root, ctx);
  const config = loadProjectConfigSafe(root);
  if (!ambientEnabled(ctx.env, config)) return '';
  const prompt = (input.prompt ?? '').slice(0, MAX_PROMPT);
  if (!prompt.trim()) return '';
  const a = config.ambient ?? {};
  const r = ambientContext({
    root,
    prompt,
    ...(a.maxChars !== undefined ? { maxChars: Math.min(a.maxChars, 4000) } : {}),
    ...(a.minScore !== undefined ? { minScore: a.minScore } : {}),
    ...(a.maxHits !== undefined ? { maxHits: Math.min(a.maxHits, MAX_AMBIENT_HITS) } : {}),
  });
  if (!r.text) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.text } });
}

// ------------------------------------------------------------ PostToolUse

/** Edited file paths in a tool call: Claude Code's file_path, or the headers of a Codex apply_patch. */
export function editedFiles(toolInput: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      for (const m of v.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
        const p = (m[1] ?? m[2])?.trim();
        if (p) out.add(p);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 100)) visit(x, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if ((k === 'file_path' || k === 'notebook_path' || k === 'path') && typeof x === 'string' && depth === 0) out.add(x);
        else visit(x, depth + 1);
      }
    }
  };
  visit(toolInput, 0);
  return [...out].filter((p) => p.length > 0 && p.length < 1024);
}

/** PostToolUse on edits: marks the edited files' nodes stale (no parsing), then maybe starts the worker. */
export async function postEditHook(input: HookInput, ctx: HookContext): Promise<string> {
  if (ctx.env.GLASSBOX_NESTED === '1' || !editHooksEnabled(ctx.env)) return '';
  const root = rootFor(input, ctx);
  if (!root) return '';
  const files = editedFiles(input.tool_input);
  if (files.length === 0) return '';
  const { refresh } = await import('../memory/refresh.js');
  const r = await refresh(root, { files: files.map((f) => resolve(input.cwd ?? root, f)) });
  if (ctx.entry && (r.stale.length || workerPending(root))) maybeStartWorker(root, startOptions(ctx, ctx.entry));
  return '';
}

// ------------------------------------------------------------ SessionStart

/** SessionStart: re-parses changed files, rewrites the AGENTS.md block (never creates CLAUDE.md), maybe starts the worker. */
export async function sessionStartHook(input: HookInput, ctx: HookContext): Promise<string> {
  if (ctx.env.GLASSBOX_NESTED === '1' || !editHooksEnabled(ctx.env)) return '';
  const root = rootFor(input, ctx);
  if (!root) return '';
  const { refresh } = await import('../memory/refresh.js');
  const r = await refresh(root, { syncMd: { claudeMd: false } });
  if (ctx.entry && (r.stale.length || workerPending(root))) maybeStartWorker(root, startOptions(ctx, ctx.entry));
  return '';
}

// ------------------------------------------------------------ Stop

export interface GateState {
  lastHash: string;
  at: number;
  /** pass, block, timeout or error. */
  outcome?: string;
  /**
   * Hunks the gate already blocked on, as `file#hash` keys (hash of the hunk's
   * added and removed lines). A later turn whose diff still holds the same
   * change is not blocked again for it; a new change in the same function is.
   */
  flagged?: string[];
}

const MAX_FLAGGED = 200;

function gateFile(root: string): string {
  const dir = join(root, STORE_DIR);
  assertNotSymlinkSync(dir);
  const file = join(dir, GATE_STATE_FILE);
  assertNotSymlinkSync(file);
  return file;
}

export function readGateState(root: string): GateState | undefined {
  try {
    const v = JSON.parse(readFileSync(gateFile(root), 'utf8')) as Partial<GateState>;
    if (typeof v.lastHash !== 'string' || typeof v.at !== 'number') return undefined;
    const flagged = Array.isArray(v.flagged) ? v.flagged.filter((k): k is string => typeof k === 'string').slice(-MAX_FLAGGED) : [];
    return { lastHash: v.lastHash, at: v.at, ...(v.outcome !== undefined ? { outcome: v.outcome } : {}), ...(flagged.length ? { flagged } : {}) };
  } catch {
    return undefined;
  }
}

export function writeGateState(root: string, state: GateState): void {
  const file = gateFile(root);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { flag: 'wx' });
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
  }
}

class GateTimeout extends Error {}

/**
 * Stop: when the working diff changed since the last gate, rates it with
 * triage in fast mode (or balanced, from config) without evidence. If a hunk
 * scores High risk in the act band, it blocks the stop once with a short
 * reason naming the lines. Never blocks twice for the same diff, never when
 * stop_hook_active is set, and never when the check fails or times out.
 */
export async function stopHook(input: HookInput, ctx: HookContext): Promise<string> {
  if (ctx.env.GLASSBOX_NESTED === '1' || input.stop_hook_active === true) return '';
  const root = rootFor(input, ctx);
  if (!root) return '';
  resumeWorker(root, ctx);
  const config = loadProjectConfigSafe(root);
  if (!gateEnabled(ctx.env, config)) return '';
  const mode = config.gate?.mode === 'balanced' ? 'balanced' : 'fast';
  const settings = MODE_SETTINGS[mode];
  const timeoutMs = gateTimeoutMs(ctx.env, config.gate?.timeoutMs);
  const now = ctx.now ?? Date.now;

  // The timer starts before the diff is read, so git counts against the timeout too.
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    const stop = (err: Error) => {
      abort.abort(err);
      reject(err);
    };
    timer = setTimeout(() => stop(new GateTimeout('gate timed out')), timeoutMs);
    if (ctx.signal?.aborted) stop(new GateTimeout('gate stopped'));
    else ctx.signal?.addEventListener('abort', () => stop(new GateTimeout('gate stopped')), { once: true });
  });
  timeout.catch(() => {});
  let hash: string | undefined;
  let flagged: string[] = [];
  try {
    const { workingDiff } = await import('../util/git.js');
    const diff = await Promise.race([workingDiff(root, { signal: abort.signal }), timeout]);
    if (!diff.trim()) return '';
    hash = sha256(diff);
    const prev = readGateState(root);
    if (prev?.lastHash === hash) return '';
    flagged = prev?.flagged ?? [];
    // Recorded before the check, so a slow or failing check is not retried on the same diff.
    writeGateState(root, { lastHash: hash, at: now(), ...(flagged.length ? { flagged } : {}) });

    const r = await Promise.race([gate(root, diff, ctx, settings, abort.signal, new Set(flagged)), timeout]);
    const all = [...flagged, ...r.flagged].slice(-MAX_FLAGGED);
    writeGateState(root, { lastHash: hash, at: now(), outcome: r.reason ? 'block' : 'pass', ...(all.length ? { flagged: all } : {}) });
    return r.reason ? JSON.stringify({ decision: 'block', reason: r.reason }) : '';
  } catch (err) {
    if (hash !== undefined) {
      writeGateState(root, { lastHash: hash, at: now(), outcome: err instanceof GateTimeout ? 'timeout' : 'error', ...(flagged.length ? { flagged } : {}) });
    }
    return '';
  } finally {
    clearTimeout(timer);
    // Stops any model call still running (and its child processes) once the gate is done.
    if (!abort.signal.aborted) abort.abort(new GateTimeout('gate finished'));
  }
}

/**
 * The gate's timeout: GLASSBOX_GATE_TIMEOUT_MS, then `gate.timeoutMs` from
 * .glassbox/config.json, then 45 s; never under 1 s or over GATE_TIMEOUT_CAP_MS.
 */
export function gateTimeoutMs(env: NodeJS.ProcessEnv, configured?: number): number {
  const ms = envMs(env.GLASSBOX_GATE_TIMEOUT_MS) ?? configured ?? DEFAULT_GATE_TIMEOUT_MS;
  return Math.max(1000, Math.min(ms, GATE_TIMEOUT_CAP_MS));
}

function envMs(v: string | undefined): number | undefined {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Key of a triage hunk: its file plus a hash of its added and removed lines.
 * Line numbers are left out, so the key stays the same when edits elsewhere
 * move the hunk. Triage numbers hunks h1, h2, ... in the order of the diff's
 * chunks after secret files are dropped, so the chunks are rebuilt the same way.
 */
export function hunkKeys(
  diff: string,
  chunkDiff: typeof import('../scope.js').chunkDiff,
  safeDiffChunks: typeof import('../scope.js').safeDiffChunks,
): (h: { id: string; file: string; startLine: number; endLine: number }) => string {
  const chunks = new Map(safeDiffChunks(chunkDiff(diff)).map((c, i) => [`h${i + 1}`, c]));
  return (h) => {
    const c = chunks.get(h.id);
    const changed = c
      ? c.text
          .split('\n')
          .filter((l) => l.startsWith('+') || l.startsWith('-'))
          .join('\n')
      : `${h.startLine}-${h.endLine}`;
    return `${h.file}#${sha256(changed).slice(0, 16)}`;
  };
}

async function gate(
  root: string,
  diff: string,
  ctx: HookContext,
  settings: (typeof MODE_SETTINGS)[keyof typeof MODE_SETTINGS],
  signal: AbortSignal,
  seen: ReadonlySet<string>,
): Promise<{ reason: string; flagged: string[] }> {
  const none = { reason: '', flagged: [] };
  if (!ctx.backend) return none;
  const [{ GraphStore }, { triage }, { chunkDiff, safeDiffChunks }] = await Promise.all([
    import('../memory/store.js'),
    import('../query/triage.js'),
    import('../scope.js'),
  ]);
  const store = GraphStore.open(root);
  try {
    // The gate never indexes: an empty graph means `glassbox init` has not run here.
    if (store.getNodes({ kind: 'file' }).length === 0) return none;
    const backend = ctx.backend({ env: hostEnv(ctx), ...(settings.samples !== undefined ? { samples: settings.samples } : {}) });
    const r = await triage(diff, {
      store,
      root,
      backend,
      explain: false,
      decide: { ...(settings.permutations !== undefined ? { permutations: settings.permutations } : {}), signal },
    });
    const keyOf = hunkKeys(diff, chunkDiff, safeDiffChunks);
    // Only hunks not blocked on before: a risky change the agent already looked at does not stop every later turn.
    const risky = r.hunks.filter((h) => h.level === 'High' && h.answer.band === 'act' && !seen.has(keyOf(h)));
    if (risky.length === 0) return none;
    const lines = risky.slice(0, MAX_REASON_HUNKS).map((h) => {
      const names = h.nodes.map((id) => store.getNode(id)?.name ?? id).slice(0, 3).join(', ');
      return `- ${h.file}:${h.startLine}-${h.endLine} (${names}) High risk, p=${h.p.toFixed(2)}`;
    });
    if (risky.length > MAX_REASON_HUNKS) lines.push(`- and ${risky.length - MAX_REASON_HUNKS} more`);
    const callers = r.affected.slice(0, 5).map((a) => `${a.name} (${a.file}:${a.line})`);
    const reason = [
      `glassbox gate: ${risky.length} changed hunk${risky.length === 1 ? '' : 's'} rated High risk with high confidence (decision ${r.record.id ?? 'unlogged'}):`,
      ...lines,
      ...(callers.length ? [`Direct callers: ${callers.join(', ')}.`] : []),
      'Check these lines (and their tests) before finishing, or state why they are safe. glassbox asks once per change.',
    ].join('\n');
    return { reason, flagged: [...new Set(risky.map(keyOf))] };
  } finally {
    store.close();
  }
}
