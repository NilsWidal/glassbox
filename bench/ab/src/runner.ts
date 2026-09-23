// Runs tasks in both arms and records one result per (task, arm, repeat).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentEnv,
  answerLength,
  buildAgentCommand,
  parseAgentOutput,
  type AgentMetrics,
  type AgentName,
  type AgentOptions,
  type Arm,
} from './agents.ts';
import { runChecks, type CheckResult } from './checks.ts';
import type { RunProc } from './proc.ts';
import { referenceFix, type Task, type TaskSet } from './tasks.ts';
import { applyReplacements, copyTree, ensureRepo, gitSnapshot, restoreProtected } from './workspace.ts';

export interface RunConfig {
  set: TaskSet;
  tasks: Task[];
  agent: AgentName;
  arms: Arm[];
  repeats: number;
  model?: string;
  /** glassbox checkout: loaded with --plugin-dir, and its plugin-dist/glassbox.mjs runs `init`. */
  pluginDir: string;
  checksDir: string;
  cacheDir: string;
  timeoutSec: number;
  maxBudgetUsd?: number;
  codexEffort?: string;
  /** Tag the graph with model calls during `init` (the default), or build it without tags. */
  initTags: boolean;
  concise?: boolean;
  gate?: boolean;
  keepWorkspaces?: boolean;
  env: NodeJS.ProcessEnv;
}

export interface RunnerDeps {
  run: RunProc;
  log: (line: string) => void;
  /** Where workspaces go (default: the OS temp dir). */
  tmpRoot?: string;
}

export interface PrepRecord {
  repo: string;
  arm: Arm;
  ok: boolean;
  wallMs: number;
  detail?: string;
}

export interface RunRecord {
  taskId: string;
  repo: string;
  kind: Task['kind'];
  arm: Arm;
  agent: AgentName;
  model?: string;
  repeat: number;
  success: boolean;
  checks: CheckResult[];
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  answerChars: number;
  answerWords: number;
  /** The final answer, cut at 4,000 characters. */
  answer: string;
  metrics: Omit<AgentMetrics, 'answer'>;
  error?: string;
  workspace?: string;
}

const MAX_ANSWER = 4000;

function glassboxBin(pluginDir: string): string {
  return join(pluginDir, 'plugin-dist', 'glassbox.mjs');
}

/** Runs `glassbox init` in a directory with the agent's own CLI as backend. */
async function glassboxInit(dir: string, cfg: RunConfig, deps: RunnerDeps, tags: boolean): Promise<{ ok: boolean; wallMs: number; detail?: string }> {
  const args = [glassboxBin(cfg.pluginDir), 'init', '--root', dir, '--quiet'];
  if (!tags) args.push('--no-tags');
  else args.push('--samples', '1');
  const env = agentEnv(cfg.env, { arm: 'ambient', agent: cfg.agent, gate: false });
  if (cfg.concise) env.GLASSBOX_CONCISE_RULES = '1';
  if (cfg.agent === 'claude' && tags) env.GLASSBOX_MODEL = cfg.env.GLASSBOX_AB_TAG_MODEL ?? 'haiku';
  const r = await deps.run({ cmd: process.execPath, args, cwd: dir, env, timeoutMs: 30 * 60_000 });
  const ok = r.code === 0 && !r.timedOut;
  return { ok, wallMs: r.wallMs, ...(ok ? {} : { detail: (r.spawnError ?? r.stderr ?? r.stdout).trim().slice(-800) }) };
}

interface RepoBases {
  source: string;
  ambient?: string;
}

export function armOrder(arms: Arm[], taskIndex: number, repeat: number): Arm[] {
  return (taskIndex + repeat) % 2 === 0 ? [...arms] : [...arms].reverse();
}

export async function runAll(cfg: RunConfig, deps: RunnerDeps): Promise<{ prep: PrepRecord[]; runs: RunRecord[] }> {
  const tmpRoot = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'glassbox-ab-'));
  const prep: PrepRecord[] = [];
  const runs: RunRecord[] = [];
  const bases = new Map<string, RepoBases>();
  try {
    for (const name of [...new Set(cfg.tasks.map((t) => t.repo))]) {
      const repo = cfg.set.repos[name];
      if (!repo) throw new Error(`unknown repo ${name}`);
      const source = await ensureRepo(name, repo, cfg.set.baseDir, cfg.cacheDir, deps.run);
      const b: RepoBases = { source };
      if (cfg.arms.includes('ambient')) {
        const dir = join(tmpRoot, 'bases', name);
        mkdirSync(join(tmpRoot, 'bases'), { recursive: true });
        copyTree(source, dir);
        deps.log(`prep  ${name}: glassbox init${cfg.initTags ? ' (with tags)' : ' --no-tags'}`);
        const r = await glassboxInit(dir, cfg, deps, cfg.initTags);
        prep.push({ repo: name, arm: 'ambient', ...r });
        if (r.ok) b.ambient = dir;
        else deps.log(`prep  ${name}: init failed: ${r.detail ?? ''}`);
      }
      bases.set(name, b);
    }

    for (const [ti, task] of cfg.tasks.entries()) {
      for (let rep = 0; rep < cfg.repeats; rep++) {
        for (const arm of armOrder(cfg.arms, ti, rep)) {
          const rec = await runOne(task, arm, rep, cfg, deps, bases.get(task.repo) as RepoBases, tmpRoot);
          runs.push(rec);
          const cost = rec.metrics.costUsd !== undefined ? ` $${rec.metrics.costUsd.toFixed(4)}` : '';
          deps.log(
            `run   ${task.id} ${arm.padEnd(8)} r${rep} ${rec.success ? 'PASS' : 'FAIL'} ${(rec.wallMs / 1000).toFixed(1)}s tools=${rec.metrics.toolCalls}${cost}${rec.error ? ` error=${rec.error}` : ''}`,
          );
        }
      }
    }
  } finally {
    if (!cfg.keepWorkspaces) rmSync(tmpRoot, { recursive: true, force: true });
  }
  return { prep, runs };
}

async function runOne(task: Task, arm: Arm, repeat: number, cfg: RunConfig, deps: RunnerDeps, bases: RepoBases, tmpRoot: string): Promise<RunRecord> {
  const base: Omit<RunRecord, 'success' | 'checks' | 'exitCode' | 'timedOut' | 'wallMs' | 'answerChars' | 'answerWords' | 'answer' | 'metrics'> = {
    taskId: task.id,
    repo: task.repo,
    kind: task.kind,
    arm,
    agent: cfg.agent,
    ...(cfg.model ? { model: cfg.model } : {}),
    repeat,
  };
  const failed = (error: string, extra: Partial<RunRecord> = {}): RunRecord => ({
    ...base,
    success: false,
    checks: [],
    exitCode: null,
    timedOut: false,
    wallMs: 0,
    answerChars: 0,
    answerWords: 0,
    answer: '',
    metrics: { isError: true, toolCalls: 0, toolsByName: {} },
    error,
    ...extra,
  });
  if (arm === 'ambient' && !bases.ambient) return failed('glassbox init failed for this repo');

  const ws = mkdtempSync(join(tmpRoot, `${task.id}-${arm}-`));
  const scratch = mkdtempSync(join(tmpRoot, `${task.id}-${arm}-check-`));
  try {
    copyTree(arm === 'ambient' ? (bases.ambient as string) : bases.source, ws, { keepGlassbox: arm === 'ambient' });
    applyReplacements(ws, task.setup ?? []);
    if (arm === 'ambient') {
      // Re-parse the files the setup changed and rewrite AGENTS.md. No model call: tags of
      // unchanged code come from the base graph.
      const r = await glassboxInit(ws, cfg, deps, false);
      if (!r.ok) return failed(`glassbox init --no-tags failed: ${r.detail ?? ''}`);
    }
    await gitSnapshot(ws, deps.run);

    const opts: AgentOptions = {
      agent: cfg.agent,
      arm,
      pluginDir: cfg.pluginDir,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.maxBudgetUsd !== undefined ? { maxBudgetUsd: cfg.maxBudgetUsd } : {}),
      ...(cfg.codexEffort ? { codexEffort: cfg.codexEffort } : {}),
      ...(cfg.concise ? { concise: true } : {}),
      ...(cfg.gate ? { gate: true } : {}),
    };
    const cmd = buildAgentCommand(task.prompt, ws, opts, cfg.env);
    const proc = await deps.run({ cmd: cmd.cmd, args: cmd.args, cwd: ws, env: cmd.env, timeoutMs: cfg.timeoutSec * 1000, ...(cmd.stdin !== undefined ? { stdin: cmd.stdin } : {}) });
    const parsed = parseAgentOutput(cfg.agent, proc.stdout);
    const { answer, ...metrics } = parsed;

    restoreProtected(ws, bases.source, task.protect ?? []);
    const checks = await runChecks(task.checks, { workspace: ws, answer, checksDir: cfg.checksDir, scratchDir: scratch, run: deps.run });
    const len = answerLength(answer);
    let error: string | undefined;
    if (proc.spawnError) error = `could not start ${cmd.cmd}: ${proc.spawnError}`;
    else if (proc.timedOut) error = `timed out after ${cfg.timeoutSec}s`;
    else if (parsed.isError) error = parsed.errorText ?? `exit ${proc.code}`;
    return {
      ...base,
      success: checks.every((c) => c.pass),
      checks,
      exitCode: proc.code,
      timedOut: proc.timedOut,
      wallMs: proc.wallMs,
      answerChars: len.chars,
      answerWords: len.words,
      answer: answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}...` : answer,
      metrics,
      ...(error ? { error } : {}),
      ...(cfg.keepWorkspaces ? { workspace: ws } : {}),
    };
  } catch (err) {
    return failed((err as Error).message);
  } finally {
    if (!cfg.keepWorkspaces) {
      rmSync(ws, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

export interface ValidateRecord {
  taskId: string;
  /** Some check fails on the task's starting state with an empty answer. */
  failsBefore: boolean;
  /** The checks pass after the reference fix (and with the reference answer). */
  passesAfter: boolean;
  detail?: string;
}

/**
 * Checks the tasks themselves, with no agent: every check must fail on the starting state and
 * pass after the reference fix (a bugfix task's setup in reverse, or its `solution`), and the
 * answer checks must accept the reference answer and reject an empty one.
 */
export async function validateTasks(
  cfg: Pick<RunConfig, 'set' | 'tasks' | 'checksDir' | 'cacheDir'>,
  deps: RunnerDeps,
): Promise<ValidateRecord[]> {
  const tmpRoot = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'glassbox-ab-validate-'));
  const out: ValidateRecord[] = [];
  const sources = new Map<string, string>();
  try {
    for (const task of cfg.tasks) {
      const repo = cfg.set.repos[task.repo];
      if (!repo) throw new Error(`unknown repo ${task.repo}`);
      let source = sources.get(task.repo);
      if (!source) {
        source = await ensureRepo(task.repo, repo, cfg.set.baseDir, cfg.cacheDir, deps.run);
        sources.set(task.repo, source);
      }
      const ws = mkdtempSync(join(tmpRoot, `${task.id}-`));
      const scratch = mkdtempSync(join(tmpRoot, `${task.id}-check-`));
      try {
        copyTree(source, ws);
        applyReplacements(ws, task.setup ?? []);
        const before = await runChecks(task.checks, { workspace: ws, answer: '', checksDir: cfg.checksDir, scratchDir: scratch, run: deps.run });
        const failsBefore = before.some((c) => !c.pass);
        applyReplacements(ws, referenceFix(task));
        const after = await runChecks(task.checks, {
          workspace: ws,
          answer: task.referenceAnswer ?? '',
          checksDir: cfg.checksDir,
          scratchDir: scratch,
          run: deps.run,
        });
        const passesAfter = after.every((c) => c.pass);
        const bad = after.find((c) => !c.pass);
        out.push({ taskId: task.id, failsBefore, passesAfter, ...(bad ? { detail: `${bad.label}: ${bad.detail ?? 'no match'}` } : {}) });
      } catch (err) {
        out.push({ taskId: task.id, failsBefore: false, passesAfter: false, detail: (err as Error).message });
      } finally {
        rmSync(ws, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  return out;
}
