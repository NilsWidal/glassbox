import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertNotSymlinkSync, within } from './util/safefs.js';

// Same directory as the graph store; kept local so reading the config never loads node:sqlite.
const STORE_DIR = '.glassbox';
export const PROJECT_CONFIG_FILE = 'config.json';

/**
 * Per-project settings in <repo>/.glassbox/config.json. The store directory is
 * git-ignored, so this is a local, per-checkout file. Every field is optional;
 * values of the wrong type are dropped rather than trusted.
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
 * Reads <root>/.glassbox/config.json. A missing file is an empty config. A
 * symlinked file, one outside the root, or invalid JSON throws (callers on a
 * hook path catch and fail open).
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
  try {
    return parseProjectConfig(JSON.parse(text));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
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
