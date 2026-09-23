import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockLineRange } from './agents-md/sync.js';
import { resolveMode, type ResolvedMode } from './modes.js';
import { featureEnabled, loadProjectConfig, type ProjectConfig } from './project-config.js';
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
  configError?: string;
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
  let agentsMdBlock = false;
  try {
    agentsMdBlock = blockLineRange(readFileSync(join(root, 'AGENTS.md'), 'utf8')) !== undefined;
  } catch {
    agentsMdBlock = false;
  }
  return {
    root,
    ...(graph ? { graph } : {}),
    ...(graphError ? { graphError } : {}),
    mode,
    ambient: ambientEnabled(env, config),
    gate: gateEnabled(env, config),
    worker: {
      enabled: workerEnabled(env, config),
      ...(lock && lockHeld(lock, now, limits.lockMaxAgeMs) ? { running: lock } : {}),
      limits,
      state,
      nextRunAt: last ? last + limits.minIntervalMs : now,
      budgetLeft: Math.max(0, limits.dailyCalls - state.callsToday),
    },
    agentsMdBlock,
    ...(configError ? { configError } : {}),
  };
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
  else out.push('graph    none (run `glassbox init`)');
  out.push('mode' in s.mode ? `mode     ${s.mode.mode} (${s.mode.source === 'default' ? 'default' : `from ${s.mode.source}`})` : `mode     error: ${s.mode.error}`);
  out.push(`hooks    ambient ${s.ambient ? 'on' : 'off'}, gate ${s.gate ? 'on' : 'off'}, worker ${s.worker.enabled ? 'on' : 'off'}`);
  const w = s.worker;
  out.push(
    `worker   ${w.running ? `running (pid ${w.running.pid}, since ${time(w.running.startedAt)})` : 'idle'}; ` +
      `today ${w.state.callsToday}/${w.limits.dailyCalls} model runs` +
      (w.nextRunAt > now ? `; next run allowed ${time(w.nextRunAt)}` : ''),
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
