import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockLineRange } from './agents-md/sync.js';
import { conciseRulesEnabled } from './style/concise.js';
import { resolveMode, type ResolvedMode } from './modes.js';
import { featureEnabled, loadProjectConfig, type ProjectConfig } from './project-config.js';
import { autoInitEnabled, autoInitRunning, checkAutoInit, countSourceFiles, readAutoInitState } from './autoinit/index.js';
import { lockHeld, readLock, readWorkerState, workerEnabled, workerLimits, type WorkerLimits, type WorkerLock, type WorkerState } from './worker/index.js';

const STORE_DIR = '.glassbox';
const STORE_FILE = 'graph.db';

export interface GraphStatus {
  files: number;
  nodes: number;
  edges: number;
  /** Nodes marked stale (changed, or a neighbour changed, since their tags). */
  stale: number;
  /** Tag targets (functions, methods, small files) and how many have fresh tags. */
  tagTargets: number;
  tagged: number;
  /** Epoch ms of the last full parse, when recorded. */
  indexedAt?: number;
}

export interface StatusReport {
  root: string;
  graph?: GraphStatus;
  /** Why the graph could not be read, when it exists but failed to open. */
  graphError?: string;
  mode: ResolvedMode | { error: string };
  ambient: boolean;
  gate: boolean;
  /** The AGENTS.md block carries the concise answer rules. */
  conciseRules: boolean;
  worker: {
    enabled: boolean;
    running?: WorkerLock;
    limits: WorkerLimits;
    state: WorkerState;
    /** Epoch ms when the rate limit next allows a run. */
    nextRunAt: number;
    budgetLeft: number;
  };
  agentsMdBlock: boolean;
  /** The backend glassbox would use here and its model, with where the model came from. */
  model: { backend: string; model?: string; source: string } | { error: string };
  /** How the graph got here: indexing, structure-only (auto-init, no tags yet), tagged, or none yet. */
  autoInit: AutoInitStatus;
  configError?: string;
}

export interface AutoInitStatus {
  /** GLASSBOX_AUTO_INIT, config `autoInit`, the plugin's auto_init option; default on. */
  enabled: boolean;
  state: 'indexing' | 'structure-only' | 'tagged' | 'none' | 'failed' | 'skipped';
  /** The graph came from a structure-only init (auto or manual) and no full init has run since. */
  structureOnly: boolean;
  /** Epoch ms: when the running auto-init started, else when the last one finished. */
  at?: number;
  tagged?: number;
  tagTargets?: number;
  detail?: string;
}

export function ambientEnabled(env: NodeJS.ProcessEnv, config: ProjectConfig): boolean {
  return featureEnabled(env, { env: 'GLASSBOX_AMBIENT', plugin: 'CLAUDE_PLUGIN_OPTION_AMBIENT' }, config.ambient?.enabled, false);
}

export function gateEnabled(env: NodeJS.ProcessEnv, config: ProjectConfig): boolean {
  return featureEnabled(env, { env: 'GLASSBOX_GATE', plugin: 'CLAUDE_PLUGIN_OPTION_GATE' }, config.gate?.enabled, false);
}

async function graphStatus(root: string): Promise<GraphStatus> {
  const [{ GraphStore }, { isTagTarget, tagsFresh, defaultTagQuestions, inferAreas }] = await Promise.all([
    import('./memory/store.js'),
    import('./memory/tags.js'),
  ]);
  const store = GraphStore.openForRead(root);
  if (!store) throw new Error('no graph');
  try {
    const nodes = store.getNodes();
    const qids = Object.keys(defaultTagQuestions(inferAreas(nodes.map((n) => n.file))));
    const targets = nodes.filter(isTagTarget);
    const indexedAt = store.indexedAt();
    return {
      files: nodes.filter((n) => n.kind === 'file').length,
      nodes: nodes.length,
      edges: Number((store.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c),
      stale: nodes.filter((n) => n.stale).length,
      tagTargets: targets.length,
      tagged: targets.filter((n) => tagsFresh(store, n, qids)).length,
      ...(indexedAt !== undefined ? { indexedAt } : {}),
    };
  } finally {
    store.close();
  }
}

/** Everything `glassbox status` shows. Reads only; no model calls. */
export async function status(root: string, env: NodeJS.ProcessEnv, now = Date.now()): Promise<StatusReport> {
  let config: ProjectConfig = {};
  let configError: string | undefined;
  try {
    config = loadProjectConfig(root);
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }
  let mode: StatusReport['mode'];
  try {
    mode = resolveMode({ env, root });
  } catch (err) {
    mode = { error: err instanceof Error ? err.message : String(err) };
  }
  let graph: GraphStatus | undefined;
  let graphError: string | undefined;
  if (existsSync(join(root, STORE_DIR, STORE_FILE))) {
    try {
      graph = await graphStatus(root);
    } catch (err) {
      graphError = err instanceof Error ? err.message : String(err);
    }
  }
  const limits = workerLimits(env, config);
  const state = existsSync(join(root, STORE_DIR)) ? readWorkerState(root, now) : { day: '', callsToday: 0 };
  const lock = existsSync(join(root, STORE_DIR)) ? readLock(root) : undefined;
  const last = Math.max(state.lastSpawnAt ?? 0, state.lastStartedAt ?? 0);
  const autoInit = autoInitStatus(root, env, config, graph, now);
  let agentsMdBlock = false;
  try {
    agentsMdBlock = blockLineRange(readFileSync(join(root, 'AGENTS.md'), 'utf8')) !== undefined;
  } catch {
    agentsMdBlock = false;
  }
  const model = await modelStatus(root, env);
  return {
    root,
    ...(graph ? { graph } : {}),
    ...(graphError ? { graphError } : {}),
    mode,
    ambient: ambientEnabled(env, config),
    gate: gateEnabled(env, config),
    conciseRules: conciseRulesEnabled(env, config),
    worker: {
      enabled: workerEnabled(env, config),
      ...(lock && lockHeld(lock, now, limits.lockMaxAgeMs) ? { running: lock } : {}),
      limits,
      state,
      nextRunAt: last ? last + limits.minIntervalMs : now,
      budgetLeft: Math.max(0, limits.dailyCalls - state.callsToday),
    },
    agentsMdBlock,
    model,
    autoInit,
    ...(configError ? { configError } : {}),
  };
}

/** Which backend and model the next call would use, without calling it. */
async function modelStatus(root: string, env: NodeJS.ProcessEnv): Promise<StatusReport['model']> {
  try {
    const [{ createBackend }, { withPluginOptions }] = await Promise.all([import('./backends/index.js'), import('./mcp/env.js')]);
    const e = withPluginOptions(env);
    const backend = createBackend({ env: e, claudeCli: { projectDir: usableProjectDir(e) ?? root } });
    const source = backend.modelSource ?? (backend.model ? backend.model : 'backend default');
    return { backend: backend.name, ...(backend.model !== undefined ? { model: backend.model } : {}), source };
  } catch (err) {
    return { error: (err instanceof Error ? err.message : String(err)).split('\n')[0]! };
  }
}

function usableProjectDir(env: NodeJS.ProcessEnv): string | undefined {
  const t = env.CLAUDE_PROJECT_DIR?.trim();
  return t && !t.includes('${') ? t : undefined;
}

function autoInitStatus(root: string, env: NodeJS.ProcessEnv, config: ProjectConfig, graph: GraphStatus | undefined, now: number): AutoInitStatus {
  const enabled = autoInitEnabled(env, config);
  const hasStore = existsSync(join(root, STORE_DIR));
  const running = hasStore ? autoInitRunning(root, now) : undefined;
  const st = hasStore ? readAutoInitState(root) : undefined;
  const structureOnly = st?.structureOnly === true;
  if (running) return { enabled, state: 'indexing', structureOnly, at: running.since };
  if (graph) {
    const counts = { tagged: graph.tagged, tagTargets: graph.tagTargets };
    const at = st?.finishedAt !== undefined ? { at: st.finishedAt } : {};
    return { enabled, state: graph.tagged === 0 ? 'structure-only' : 'tagged', structureOnly, ...at, ...counts };
  }
  if (st?.error) return { enabled, state: 'failed', structureOnly, ...(st.finishedAt !== undefined ? { at: st.finishedAt } : {}), detail: st.error };
  if (st?.skipped) return { enabled, state: 'skipped', structureOnly, ...(st.finishedAt !== undefined ? { at: st.finishedAt } : {}), detail: st.skipped };
  // Why the next session would not start it (the same checks the hook runs, without writing anything).
  const check = checkAutoInit(root, env, now, countSourceFiles, { record: false });
  return { enabled, state: 'none', structureOnly, ...(check.action === 'none' ? { detail: check.reason } : {}) };
}

function autoInitLine(a: AutoInitStatus): string {
  const onOff = `auto-init ${a.enabled ? 'on' : 'off'}`;
  const when = a.at ? ` ${time(a.at)}` : '';
  switch (a.state) {
    case 'indexing':
      return `init     indexing in the background (started${when}); ${onOff}`;
    case 'structure-only':
      return `init     structure-only (no tags yet${a.structureOnly && a.at ? `, built${when}` : ''}); tagged 0 of ${a.tagTargets ?? 0}; run /glassbox:init or \`glassbox init\` for tags and AGENTS.md; ${onOff}`;
    case 'tagged':
      return `init     tagged ${a.tagged} of ${a.tagTargets}${a.structureOnly ? ' (structure-only init, tags from the worker)' : ''}; ${onOff}`;
    case 'failed':
      return `init     last auto-init failed${when}: ${a.detail}; ${onOff}`;
    case 'skipped':
      return `init     last auto-init skipped${when}: ${a.detail}; ${onOff}`;
    default:
      return a.detail
        ? `init     no graph yet; auto-init will not run here: ${a.detail}; run \`glassbox init\` (or /glassbox:init) instead`
        : 'init     no graph yet; auto-init starts at the next session';
  }
}

function time(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function renderStatus(s: StatusReport, now = Date.now()): string {
  const out: string[] = [];
  if (s.graph) {
    const g = s.graph;
    out.push(
      `graph    ${g.files} files, ${g.nodes} nodes, ${g.edges} edges, ${g.stale} stale; ${g.tagged}/${g.tagTargets} tag targets tagged` +
        (g.indexedAt ? `; parsed ${time(g.indexedAt)}` : ''),
    );
  } else if (s.graphError) out.push(`graph    unreadable: ${s.graphError}`);
  else out.push('graph    none yet');
  out.push(autoInitLine(s.autoInit));
  out.push('mode' in s.mode ? `mode     ${s.mode.mode} (${s.mode.source === 'default' ? 'default' : `from ${s.mode.source}`})` : `mode     error: ${s.mode.error}`);
  out.push('error' in s.model ? `model    unknown: ${s.model.error}` : `model    ${s.model.source} (${s.model.backend})`);
  out.push(`hooks    ambient ${s.ambient ? 'on' : 'off'}, gate ${s.gate ? 'on' : 'off'}, concise rules ${s.conciseRules ? 'on' : 'off'}, worker ${s.worker.enabled ? 'on' : 'off'}`);
  const w = s.worker;
  out.push(
    `worker   ${w.running ? `running (pid ${w.running.pid}, since ${time(w.running.startedAt)})` : 'idle'}; ` +
      `today ${w.state.callsToday}/${w.limits.dailyCalls} model runs` +
      (w.nextRunAt > now ? `; next run allowed ${time(w.nextRunAt)}` : '') +
      (w.state.pending ? '; re-tag pending (starts on the next hook call)' : ''),
  );
  if (w.state.lastResult && w.state.lastFinishedAt) {
    const r = w.state.lastResult;
    out.push(
      `         last run ${time(w.state.lastFinishedAt)}: ${r.asked} nodes asked, ${r.modelRuns} model runs, ${r.failed} failed` +
        (r.deferred ? `, ${r.deferred} left for later` : ''),
    );
  }
  if (w.state.lastSkip) out.push(`         last skip: ${w.state.lastSkip}`);
  if (w.state.lastError) out.push(`         last error: ${w.state.lastError}`);
  out.push(`agents   AGENTS.md block ${s.agentsMdBlock ? 'present' : 'missing'}`);
  if (s.configError) out.push(`config   ${s.configError}`);
  return out.join('\n');
}
