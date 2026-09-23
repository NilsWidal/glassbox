import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { MODEL_ID } from './backends/process.js';
import { assertNotSymlinkSync } from './util/safefs.js';

/**
 * Which model glassbox runs on, and where that choice came from.
 *
 * glassbox never picks a model of its own for the host CLIs: it mirrors the
 * model the user selected in Claude Code or Codex. `model` undefined means no
 * model flag is passed, so the CLI uses its own default.
 */
export interface ModelChoice {
  model?: string;
  /** Where the model came from, for status and cost lines, e.g. "~/.claude/settings.json". */
  source: string;
}

export interface ModelChoiceOptions {
  env?: NodeJS.ProcessEnv;
  /** Claude Code project dir. Default CLAUDE_PROJECT_DIR, else the current directory. */
  projectDir?: string;
  /** Managed settings file (highest precedence in Claude Code). Default the platform path. */
  managedSettings?: string;
}

const SESSIONS_DIR = join('.glassbox', 'sessions');
/** Session files older than this are removed when a new one is written. */
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A usable model id, or undefined. Same rule as checkModelId, without throwing. */
export function validModel(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t && t.length <= 200 && MODEL_ID.test(t) ? t : undefined;
}

function usableDir(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && !t.includes('${') ? t : undefined;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return usableDir(env.HOME) ?? homedir();
}

/** Claude Code's config dir: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return usableDir(env.CLAUDE_CONFIG_DIR) ?? join(homeDir(env), '.claude');
}

/** The project dir Claude Code reads project settings from. */
export function claudeProjectDir(env: NodeJS.ProcessEnv, fallback?: string): string {
  return resolve(usableDir(env.CLAUDE_PROJECT_DIR) ?? fallback ?? process.cwd());
}

/** Shortens a path under the home directory to ~/... for display. */
export function displayPath(path: string, env: NodeJS.ProcessEnv): string {
  const home = homeDir(env);
  return path === home ? '~' : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

function defaultManagedSettings(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(file) || statSync(file).size > 1024 * 1024) return undefined;
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code settings files that can set `model`, highest precedence first,
 * as Claude Code reads them: managed, then the project's settings.local.json,
 * the project's settings.json, then the user's settings.json.
 */
export function claudeSettingsFiles(opts: ModelChoiceOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const project = claudeProjectDir(env, opts.projectDir);
  return [
    opts.managedSettings ?? defaultManagedSettings(),
    join(project, '.claude', 'settings.local.json'),
    join(project, '.claude', 'settings.json'),
    join(claudeConfigDir(env), 'settings.json'),
  ];
}

/** The `model` (or env.ANTHROPIC_MODEL) from Claude Code's settings files, with the file it came from. */
export function claudeSettingsModel(opts: ModelChoiceOptions = {}): ModelChoice | undefined {
  const env = opts.env ?? process.env;
  const files = claudeSettingsFiles(opts).map((file) => ({ file, json: readJson(file) }));
  // An ANTHROPIC_MODEL in a settings `env` block is an env var for Claude Code, which beats `model`.
  for (const { file, json } of files) {
    const e = json?.env;
    const m = typeof e === 'object' && e !== null ? validModel((e as Record<string, unknown>).ANTHROPIC_MODEL) : undefined;
    if (m) return { model: m, source: `ANTHROPIC_MODEL in ${displayPath(file, env)}` };
  }
  for (const { file, json } of files) {
    const m = validModel(json?.model);
    if (m) return { model: m, source: displayPath(file, env) };
  }
  return undefined;
}

// ------------------------------------------------------------ session files

function safeSessionId(id: string | undefined): string | undefined {
  const t = id?.trim();
  return t && /^[A-Za-z0-9_-]{1,128}$/.test(t) ? t : undefined;
}

function sessionFile(projectDir: string, sessionId: string): string {
  return join(projectDir, SESSIONS_DIR, `${sessionId}.json`);
}

/**
 * Records the live session's model (from a SessionStart `model` or a
 * PostModelSwitch `to_model` hook input) in <project>/.glassbox/sessions.
 * Only writes into an existing .glassbox directory; never throws.
 */
export function recordSessionModel(projectDir: string, sessionId: string | undefined, model: unknown, now = Date.now()): boolean {
  const id = safeSessionId(sessionId);
  const m = validModel(model);
  if (!id || !m) return false;
  const store = join(projectDir, '.glassbox');
  try {
    if (!existsSync(store)) return false;
    assertNotSymlinkSync(store);
    const dir = join(projectDir, SESSIONS_DIR);
    assertNotSymlinkSync(dir);
    mkdirSync(dir, { recursive: true });
    const file = sessionFile(projectDir, id);
    assertNotSymlinkSync(file);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ sessionId: id, model: m, at: now })}\n`);
    renameSync(tmp, file);
    pruneSessions(dir, now);
    return true;
  } catch {
    return false;
  }
}

function pruneSessions(dir: string, now: number): void {
  try {
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      if (now - statSync(f).mtimeMs > SESSION_MAX_AGE_MS) rmSync(f, { force: true });
    }
  } catch {
    // Best effort.
  }
}

/** The model recorded for this Claude Code session (CLAUDE_CODE_SESSION_ID), if any. */
export function sessionModel(opts: ModelChoiceOptions = {}): ModelChoice | undefined {
  const env = opts.env ?? process.env;
  const id = safeSessionId(env.CLAUDE_CODE_SESSION_ID);
  if (!id) return undefined;
  const file = sessionFile(claudeProjectDir(env, opts.projectDir), id);
  const json = readJson(file);
  if (json?.sessionId !== id) return undefined;
  const m = validModel(json.model);
  return m ? { model: m, source: 'this Claude Code session' } : undefined;
}

// ------------------------------------------------------------ resolvers

/** GLASSBOX_MODEL, else the plugin's `model` option. */
export function explicitModel(env: NodeJS.ProcessEnv): ModelChoice | undefined {
  const g = env.GLASSBOX_MODEL?.trim();
  const p = env.CLAUDE_PLUGIN_OPTION_MODEL?.trim();
  // The MCP server copies the plugin option into GLASSBOX_MODEL, so equal values name both.
  if (g) return { model: g, source: g === p ? 'the plugin model option' : 'GLASSBOX_MODEL' };
  if (p) return { model: p, source: 'the plugin model option' };
  return undefined;
}

/**
 * The model for `claude -p`, resolved fresh on every call:
 * 1. GLASSBOX_MODEL or the plugin `model` option (only when the user set one);
 * 2. the live session's model, recorded by the SessionStart / PostModelSwitch hooks;
 * 3. ANTHROPIC_MODEL;
 * 4. the `model` in Claude Code's settings (managed, project local, project, user);
 * 5. none: no --model flag, so Claude Code uses its own default.
 */
export function resolveClaudeModel(opts: ModelChoiceOptions = {}): ModelChoice {
  const env = opts.env ?? process.env;
  const explicit = explicitModel(env);
  if (explicit) return explicit;
  const session = sessionModel(opts);
  if (session) return session;
  const am = validModel(env.ANTHROPIC_MODEL);
  if (am) return { model: am, source: 'ANTHROPIC_MODEL' };
  return claudeSettingsModel(opts) ?? { source: 'Claude Code default' };
}

/** Top-level keys and [section] tables of a TOML file, as far as `key = "string"` lines go. */
function tomlStrings(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>([['', new Map()]]);
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = /^\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      section = header[1]!.trim().replace(/"/g, '');
      if (!out.has(section)) out.set(section, new Map());
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*"([^"\n]*)"\s*(#.*)?$/.exec(line);
    if (kv) out.get(section)!.set(kv[1]!, kv[2]!);
  }
  return out;
}

/**
 * The model the Codex CLI will use, for display only (glassbox passes no -m
 * unless GLASSBOX_MODEL is set): from $CODEX_HOME/config.toml (default
 * ~/.codex), the active `profile`'s model when that profile sets one, else
 * the top-level `model`.
 */
export function resolveCodexModel(env: NodeJS.ProcessEnv = process.env): ModelChoice {
  const explicit = explicitModel(env);
  if (explicit) return explicit;
  const file = join(usableDir(env.CODEX_HOME) ?? join(homeDir(env), '.codex'), 'config.toml');
  try {
    const toml = tomlStrings(readFileSync(file, 'utf8'));
    const top = toml.get('')!;
    const profile = top.get('profile');
    const fromProfile = profile ? validModel(toml.get(`profiles.${profile}`)?.get('model')) : undefined;
    if (fromProfile) return { model: fromProfile, source: `profile ${profile} in ${displayPath(file, env)}` };
    const m = validModel(top.get('model'));
    if (m) return { model: m, source: displayPath(file, env) };
  } catch {
    // No config: Codex's own default.
  }
  return { source: 'Codex default' };
}

/** An Anthropic API model id from a Claude Code model value: full ids only (aliases are not API ids); a [1m] suffix is dropped. */
export function apiModelId(model: string | undefined): string | undefined {
  const base = model?.replace(/\[[A-Za-z0-9]+\]$/, '');
  return base && /^claude-[a-z0-9.-]+$/.test(base) ? base : undefined;
}

/** Thrown when the anthropic API backend finds no model id: glassbox has no model default of its own. */
export const NO_API_MODEL_MESSAGE =
  'the anthropic backend needs a model id and none of yours is an API id. Set GLASSBOX_MODEL to an Anthropic API model id, ' +
  'or set ANTHROPIC_MODEL or the model in your Claude Code settings to a full API id. glassbox does not pick a model for you.';

/**
 * Model for the optional anthropic API backend: GLASSBOX_MODEL, else
 * ANTHROPIC_MODEL or the Claude Code settings model when it is a full API id.
 * Throws NO_API_MODEL_MESSAGE when none resolves (no glassbox default).
 */
export function resolveAnthropicModel(opts: ModelChoiceOptions = {}): { model: string; source: string } {
  const env = opts.env ?? process.env;
  const explicit = explicitModel(env);
  if (explicit?.model) return { model: explicit.model, source: explicit.source };
  const am = apiModelId(validModel(env.ANTHROPIC_MODEL));
  if (am) return { model: am, source: 'ANTHROPIC_MODEL' };
  const s = claudeSettingsModel(opts);
  const sm = apiModelId(s?.model);
  if (sm && s) return { model: sm, source: s.source };
  throw new Error(NO_API_MODEL_MESSAGE);
}

/** "opus[1m] from ~/.claude/settings.json", or "Claude Code default". */
export function describeChoice(c: ModelChoice): string {
  return c.model ? `${c.model} from ${c.source}` : c.source;
}
