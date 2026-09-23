import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ambientContext } from '../ambient/context.js';
import { MODE_SETTINGS } from '../modes.js';
import { envFlag, loadProjectConfigSafe } from '../project-config.js';
import { ambientEnabled, gateEnabled } from '../status.js';
import type { Backend } from '../types.js';
import { sha256 } from '../util/hash.js';
import { assertNotSymlinkSync } from '../util/safefs.js';
import { maybeStartWorker, type DetachedSpawner } from '../worker/index.js';

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
}

function rootFor(input: HookInput, ctx: HookContext): string | undefined {
  const usable = (v: string | undefined) => (v?.trim() && !v.includes('${') ? v.trim() : undefined);
  const start = usable(ctx.root) ?? usable(ctx.env.CLAUDE_PROJECT_DIR) ?? usable(input.cwd) ?? ctx.cwd;
  return findGraphRoot(resolve(ctx.cwd, start));
}

function hostEnv(ctx: HookContext): NodeJS.ProcessEnv {
  return ctx.host && !ctx.env.GLASSBOX_HOST?.trim() ? { ...ctx.env, GLASSBOX_HOST: ctx.host } : ctx.env;
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
    ...(a.maxHits !== undefined ? { maxHits: a.maxHits } : {}),
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
  if (r.stale.length && ctx.entry) {
    maybeStartWorker(root, {
      env: hostEnv(ctx),
      entry: ctx.entry,
      ...(ctx.spawner ? { spawner: ctx.spawner } : {}),
      ...(ctx.now ? { now: ctx.now() } : {}),
      ...(ctx.host ? { host: ctx.host } : {}),
    });
  }
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
  if (r.stale.length && ctx.entry) {
    maybeStartWorker(root, {
      env: hostEnv(ctx),
      entry: ctx.entry,
      ...(ctx.spawner ? { spawner: ctx.spawner } : {}),
      ...(ctx.now ? { now: ctx.now() } : {}),
      ...(ctx.host ? { host: ctx.host } : {}),
    });
  }
  return '';
}

// ------------------------------------------------------------ Stop

export interface GateState {
  lastHash: string;
  at: number;
  /** pass, block, timeout or error. */
  outcome?: string;
}

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
    return typeof v.lastHash === 'string' && typeof v.at === 'number' ? (v as GateState) : undefined;
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
  const config = loadProjectConfigSafe(root);
  if (!gateEnabled(ctx.env, config)) return '';
  const { workingDiff } = await import('../util/git.js');
  const diff = await workingDiff(root);
  if (!diff.trim()) return '';
  const hash = sha256(diff);
  const now = ctx.now ?? Date.now;
  if (readGateState(root)?.lastHash === hash) return '';
  // Recorded before the check, so a slow or failing check is not retried on the same diff.
  writeGateState(root, { lastHash: hash, at: now() });

  const mode = config.gate?.mode === 'balanced' ? 'balanced' : 'fast';
  const settings = MODE_SETTINGS[mode];
  const timeoutMs = Math.max(1000, Math.min(config.gate?.timeoutMs ?? envMs(ctx.env.GLASSBOX_GATE_TIMEOUT_MS) ?? DEFAULT_GATE_TIMEOUT_MS, 600_000));
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort(new GateTimeout('gate timed out'));
      reject(new GateTimeout('gate timed out'));
    }, timeoutMs);
  });
  try {
    const reason = await Promise.race([gate(root, diff, ctx, settings, abort.signal), timeout]);
    writeGateState(root, { lastHash: hash, at: now(), outcome: reason ? 'block' : 'pass' });
    return reason ? JSON.stringify({ decision: 'block', reason }) : '';
  } catch (err) {
    writeGateState(root, { lastHash: hash, at: now(), outcome: err instanceof GateTimeout ? 'timeout' : 'error' });
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function envMs(v: string | undefined): number | undefined {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function gate(
  root: string,
  diff: string,
  ctx: HookContext,
  settings: (typeof MODE_SETTINGS)[keyof typeof MODE_SETTINGS],
  signal: AbortSignal,
): Promise<string> {
  if (!ctx.backend) return '';
  const [{ GraphStore }, { triage }] = await Promise.all([import('../memory/store.js'), import('../query/triage.js')]);
  const store = GraphStore.open(root);
  try {
    // The gate never indexes: an empty graph means `glassbox init` has not run here.
    if (store.getNodes({ kind: 'file' }).length === 0) return '';
    const backend = ctx.backend({ env: hostEnv(ctx), ...(settings.samples !== undefined ? { samples: settings.samples } : {}) });
    const r = await triage(diff, {
      store,
      root,
      backend,
      explain: false,
      decide: { ...(settings.permutations !== undefined ? { permutations: settings.permutations } : {}), signal },
    });
    const risky = r.hunks.filter((h) => h.level === 'High' && h.answer.band === 'act');
    if (risky.length === 0) return '';
    const lines = risky.slice(0, MAX_REASON_HUNKS).map((h) => {
      const names = h.nodes.map((id) => store.getNode(id)?.name ?? id).slice(0, 3).join(', ');
      return `- ${h.file}:${h.startLine}-${h.endLine} (${names}) High risk, p=${h.p.toFixed(2)}`;
    });
    if (risky.length > MAX_REASON_HUNKS) lines.push(`- and ${risky.length - MAX_REASON_HUNKS} more`);
    const callers = r.affected.slice(0, 5).map((a) => `${a.name} (${a.file}:${a.line})`);
    return [
      `glassbox gate: ${risky.length} changed hunk${risky.length === 1 ? '' : 's'} rated High risk with high confidence (decision ${r.record.id ?? 'unlogged'}):`,
      ...lines,
      ...(callers.length ? [`Direct callers: ${callers.join(', ')}.`] : []),
      'Check these lines (and their tests) before finishing, or state why they are safe. This check runs once per diff.',
    ].join('\n');
  } finally {
    store.close();
  }
}
