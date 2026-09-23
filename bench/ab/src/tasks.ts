// Task file format for the A/B harness, and its loader.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const Replace = z.object({
  file: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
});
export type Replace = z.infer<typeof Replace>;

const AnswerCheck = z.object({
  type: z.literal('answer'),
  /** Regular expression the final answer must match. */
  pattern: z.string().min(1),
  flags: z.string().regex(/^[imsu]*$/).optional(),
});
const CommandCheck = z.object({
  type: z.literal('command'),
  /**
   * Program and arguments, spawned without a shell in the workspace. `{checks}` is replaced
   * by the absolute path of bench/ab/checks and `{answerFile}` by a file holding the answer.
   */
  argv: z.array(z.string().min(1)).min(1),
  timeoutSec: z.number().positive().max(600).optional(),
});
const Check = z.discriminatedUnion('type', [AnswerCheck, CommandCheck]);
export type Check = z.infer<typeof Check>;

const PathRepo = z.object({
  type: z.literal('path'),
  /** Relative to the task file, or absolute. */
  path: z.string().min(1),
  license: z.string().min(1),
});
const GitRepo = z.object({
  type: z.literal('git'),
  url: z.string().regex(/^https:\/\/[^\s]+$/),
  /** Full 40-character commit hash: the run always uses exactly this tree. */
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  license: z.string().min(1),
});
const Repo = z.discriminatedUnion('type', [PathRepo, GitRepo]);
export type Repo = z.infer<typeof Repo>;

const TaskId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const Task = z.object({
  id: TaskId,
  repo: z.string().min(1),
  kind: z.enum(['question', 'bugfix', 'edit', 'feature']),
  prompt: z.string().min(1),
  /** Edits applied before the agent starts (for example, the bug a bugfix task asks to find). */
  setup: z.array(Replace).optional(),
  /** Paths restored to their pre-agent content before the checks run, so an agent cannot pass by editing tests. */
  protect: z.array(z.string().min(1)).optional(),
  checks: z.array(Check).min(1),
  /** A known-good fix, used by `validate`. A bugfix task without one uses its setup in reverse. */
  solution: z.array(Replace).optional(),
  /** A known-good answer, used by `validate` for answer checks. */
  referenceAnswer: z.string().optional(),
  pilot: z.boolean().optional(),
  note: z.string().optional(),
});
export type Task = z.infer<typeof Task>;

const TaskFile = z.object({
  repos: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), Repo),
  tasks: z.array(Task).min(1),
});

export interface TaskSet {
  /** Directory of the task file; relative repo paths resolve against it. */
  baseDir: string;
  repos: Record<string, Repo>;
  tasks: Task[];
}

/** Parses and cross-checks a task file's JSON. Throws with every problem found. */
export function parseTaskSet(json: unknown, baseDir: string): TaskSet {
  const parsed = TaskFile.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid task file:\n${lines.join('\n')}`);
  }
  const { repos, tasks } = parsed.data;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) problems.push(`${t.id}: duplicate id`);
    seen.add(t.id);
    if (!repos[t.repo]) problems.push(`${t.id}: unknown repo "${t.repo}"`);
    for (const c of t.checks) {
      if (c.type === 'answer') {
        try {
          new RegExp(c.pattern, c.flags);
        } catch (err) {
          problems.push(`${t.id}: bad pattern ${c.pattern}: ${(err as Error).message}`);
        }
      }
    }
    for (const r of [...(t.setup ?? []), ...(t.solution ?? [])]) {
      if (!safeRelative(r.file)) problems.push(`${t.id}: path must stay inside the repo: ${r.file}`);
    }
    for (const p of t.protect ?? []) {
      if (!safeRelative(p)) problems.push(`${t.id}: path must stay inside the repo: ${p}`);
    }
    if (t.kind === 'question' && !t.checks.some((c) => c.type === 'answer')) {
      problems.push(`${t.id}: a question needs an answer check`);
    }
    if (t.kind === 'bugfix' && !t.setup?.length && !t.solution?.length) {
      problems.push(`${t.id}: a bugfix task needs setup (the bug) or a solution`);
    }
  }
  if (problems.length) throw new Error(`invalid task file:\n${problems.join('\n')}`);
  return { baseDir, repos, tasks };
}

export function loadTaskSet(file: string): TaskSet {
  const abs = resolve(file);
  return parseTaskSet(JSON.parse(readFileSync(abs, 'utf8')) as unknown, dirname(abs));
}

/** True for a relative path that cannot climb out of its root. */
export function safeRelative(p: string): boolean {
  if (isAbsolute(p) || p.includes('\\')) return false;
  return !p.split('/').some((part) => part === '..' || part === '');
}

/**
 * Picks tasks by id list, or the tasks marked `pilot`, or all of them. Unknown ids throw,
 * so a typo never silently shrinks a run.
 */
export function selectTasks(set: TaskSet, opts: { ids?: string[]; pilot?: boolean; repo?: string }): Task[] {
  let out = set.tasks;
  if (opts.ids?.length) {
    const byId = new Map(set.tasks.map((t) => [t.id, t]));
    const missing = opts.ids.filter((id) => !byId.has(id));
    if (missing.length) throw new Error(`unknown task id(s): ${missing.join(', ')}`);
    out = opts.ids.map((id) => byId.get(id) as Task);
  } else if (opts.pilot) {
    out = out.filter((t) => t.pilot);
  }
  if (opts.repo) out = out.filter((t) => t.repo === opts.repo);
  return out;
}

/** The fix `validate` applies: the task's solution, else its setup in reverse. */
export function referenceFix(task: Task): Replace[] {
  if (task.solution?.length) return task.solution;
  return (task.setup ?? []).map((r) => ({ file: r.file, find: r.replace, replace: r.find })).reverse();
}
