import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertNotSymlinkSync, within } from './util/safefs.js';
import { storeTrackedByGit } from './util/tracked.js';

// Same directory as the graph store; kept local so reading the config never loads node:sqlite.
const STORE_DIR = '.glassbox';
export const PROJECT_CONFIG_FILE = 'config.json';

/**
 * Per-project settings in <repo>/.glassbox/config.json. glassbox git-ignores
 * the store directory it creates, so this is meant as a local, per-checkout
 * file. A config in a store directory that git tracks (in any letter case, or
 * as a submodule; see storeTrackedByGit) came with the repo, so someone else wrote it:
 * only its switches that turn a feature off are kept (see onlyDisables).
 * Every field is optional; values of the wrong type are dropped rather than
 * trusted, and the worker and gate limits are clamped where they are used.
 */
export interface ProjectConfig {
  /** Default mode for ask, where, triage and decide: fast, balanced, explained, strict or auto. */
  mode?: string;
  ambient?: {
    /** Turns the UserPromptSubmit hook on (the `glassbox context` command always works). */
    enabled?: boolean;
    /** Most characters of context per prompt. Default 1500. */
    maxChars?: number;
    /** Lowest graph match score shown. Default 3 (a name match, or a path match plus a tag). */
    minScore?: number;
    /** Most nodes listed. Default 6. */
    maxHits?: number;
  };
  gate?: {
    /** Turns the end-of-turn Stop hook on. */
    enabled?: boolean;
    /** fast or balanced. Default fast. */
    mode?: string;
    /** Longest the gate may take before it gives up and lets the turn end. Default 45000. */
    timeoutMs?: number;
  };
  /** Adds the concise answer rules to the AGENTS.md block. Default false. */
  conciseRules?: boolean;
  /**
   * false: never create CLAUDE.md when the AGENTS.md block is written (an
   * existing one still gets the import). `init --no-claude-md` sets it.
   */
  claudeMd?: boolean;
  /**
   * false: the session-start hook never builds the graph by itself in this
   * repo, and adds no code map. Default true (GLASSBOX_AUTO_INIT and the
   * plugin's auto_init option can also turn it off).
   */
  autoInit?: boolean;
  worker?: {
    /** false stops hooks and the launcher from starting the background re-tagging worker. Default true. */
    enabled?: boolean;
    /** Most model runs the worker may start per day. Default 100. */
    dailyCalls?: number;
    /** Fewest seconds between two worker runs. Default 60. */
    minIntervalSec?: number;
    /** Most nodes re-tagged per run. Default 24. */
    maxNodesPerRun?: number;
  };
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pick<T extends Obj>(src: unknown, spec: Record<keyof T & string, 'string' | 'boolean' | 'number'>): T | undefined {
  if (!isObj(src)) return undefined;
  const out: Obj = {};
  for (const [key, type] of Object.entries(spec)) {
    const v = src[key];
    if (type === 'number' ? typeof v === 'number' && Number.isFinite(v) && v >= 0 : typeof v === type) out[key] = v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

/** Keeps only known fields of the right type. */
export function parseProjectConfig(value: unknown): ProjectConfig {
  if (!isObj(value)) return {};
  const out: ProjectConfig = {};
  if (typeof value.mode === 'string') out.mode = value.mode;
  if (typeof value.conciseRules === 'boolean') out.conciseRules = value.conciseRules;
  if (typeof value.claudeMd === 'boolean') out.claudeMd = value.claudeMd;
  if (typeof value.autoInit === 'boolean') out.autoInit = value.autoInit;
  const ambient = pick<NonNullable<ProjectConfig['ambient']>>(value.ambient, {
    enabled: 'boolean',
    maxChars: 'number',
    minScore: 'number',
    maxHits: 'number',
  });
  if (ambient) out.ambient = ambient;
  const gate = pick<NonNullable<ProjectConfig['gate']>>(value.gate, { enabled: 'boolean', mode: 'string', timeoutMs: 'number' });
  if (gate) out.gate = gate;
  const worker = pick<NonNullable<ProjectConfig['worker']>>(value.worker, {
    enabled: 'boolean',
    dailyCalls: 'number',
    minIntervalSec: 'number',
    maxNodesPerRun: 'number',
  });
  if (worker) out.worker = worker;
  return out;
}

/**
 * What a config that git tracks may still do: turn features off. Everything
 * else (turning the gate or ambient context on, the mode, limits, timeouts)
 * is dropped, so a cloned repo cannot switch on model calls or raise budgets.
 */
export function onlyDisables(config: ProjectConfig): ProjectConfig {
  const out: ProjectConfig = {};
  if (config.ambient?.enabled === false) out.ambient = { enabled: false };
  if (config.gate?.enabled === false) out.gate = { enabled: false };
  if (config.worker?.enabled === false) out.worker = { enabled: false };
  if (config.conciseRules === false) out.conciseRules = false;
  if (config.claudeMd === false) out.claudeMd = false;
  if (config.autoInit === false) out.autoInit = false;
  return out;
}

/**
 * Sets top-level fields in <root>/.glassbox/config.json, keeping every other
 * field as written. An unreadable or non-object file is replaced. Refuses a
 * symlinked store directory or file.
 */
export function updateProjectConfig(root: string, fields: Record<string, unknown>): void {
  const dir = join(root, STORE_DIR);
  const file = join(dir, PROJECT_CONFIG_FILE);
  assertNotSymlinkSync(dir);
  assertNotSymlinkSync(file);
  if (!within(realpathSync(root), realpathSync(dir))) throw new Error(`refusing to write ${file}: it resolves outside ${root}`);
  let current: Record<string, unknown> = {};
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (isObj(v)) current = v;
  } catch {
    current = {};
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...current, ...fields }, null, 2)}\n`, { flag: 'w' });
  renameSync(tmp, file);
}

/**
 * Reads <root>/.glassbox/config.json. A missing file is an empty config. A
 * symlinked file, one outside the root, or invalid JSON throws (callers on a
 * hook path catch and fail open). A file in a store directory that git
 * tracks (storeTrackedByGit) is reduced to
 * onlyDisables().
 */
export function loadProjectConfig(root: string): ProjectConfig {
  const file = join(root, STORE_DIR, PROJECT_CONFIG_FILE);
  let text: string;
  try {
    assertNotSymlinkSync(join(root, STORE_DIR));
    assertNotSymlinkSync(file);
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (!within(realpathSync(root), realpathSync(dirname(file)))) throw new Error(`refusing to read ${file}: it resolves outside ${root}`);
  let config: ProjectConfig;
  try {
    config = parseProjectConfig(JSON.parse(text));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  return storeTrackedByGit(root) ? onlyDisables(config) : config;
}

/** Like loadProjectConfig, but an unreadable config is an empty one (for hooks, which must fail open). */
export function loadProjectConfigSafe(root: string): ProjectConfig {
  try {
    return loadProjectConfig(root);
  } catch {
    return {};
  }
}

/** "1"/"true"/"yes"/"on" is true, "0"/"false"/"no"/"off" is false, anything else undefined. */
export function envFlag(v: string | undefined): boolean | undefined {
  const t = v?.trim().toLowerCase();
  if (!t) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  return undefined;
}

/**
 * A feature switch, first set wins: the GLASSBOX_* variable, then the project
 * config, then the Claude Code plugin option (exported as
 * CLAUDE_PLUGIN_OPTION_<KEY>), then the default.
 */
export function featureEnabled(
  env: NodeJS.ProcessEnv,
  names: { env: string; plugin: string },
  project: boolean | undefined,
  fallback: boolean,
): boolean {
  return envFlag(env[names.env]) ?? project ?? envFlag(env[names.plugin]) ?? fallback;
}

/** The edit-hooks switch (post-edit refresh, session-start refresh, worker kicks): GLASSBOX_HOOKS, else the plugin's enable_hooks option. Default off. */
export function editHooksEnabled(env: NodeJS.ProcessEnv): boolean {
  return envFlag(env.GLASSBOX_HOOKS) ?? envFlag(env.CLAUDE_PLUGIN_OPTION_ENABLE_HOOKS) ?? false;
}
