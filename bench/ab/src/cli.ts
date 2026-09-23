// glassbox A/B harness CLI. Run with Node 22.18+ (type stripping):
//   node bench/ab/src/cli.ts list
//   node bench/ab/src/cli.ts validate [--repo tomli]
//   node bench/ab/src/cli.ts run --pilot --agent claude --model haiku --out bench/ab/results/pilot
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildAgentCommand, type AgentName, type Arm } from './agents.ts';
import { runProc, type RunProc } from './proc.ts';
import { renderMarkdown, summarize, type ResultsFile } from './report.ts';
import { runAll, validateTasks } from './runner.ts';
import { loadTaskSet, selectTasks } from './tasks.ts';
import { defaultCacheDir } from './workspace.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AB_DIR = resolve(HERE, '..');
export const REPO_ROOT = resolve(AB_DIR, '..', '..');

const HELP = `usage: node bench/ab/src/cli.ts <list|validate|run> [options]

  list                       show the tasks
  validate                   check every task without an agent: its checks fail on the
                             starting state and pass after the reference fix
  run                        run the tasks in both arms and write results

options:
  --tasks a,b,c              task ids (default: all, or --pilot)
  --pilot                    only the tasks marked "pilot"
  --repo <name>              only tasks on this repo
  --agent claude|codex       agent CLI (default claude)
  --model <id>               model (default: haiku for claude, the CLI default for codex)
  --arms baseline,ambient    arms to run (default both)
  --repeats <n>              runs per task and arm (default 1)
  --timeout <sec>            per run (default 600)
  --max-budget-usd <x>       claude only: spend cap per run (default 1)
  --effort <level>           codex only: model_reasoning_effort (default low)
  --no-init-tags             build the ambient graph without model-made tags
  --concise                  ambient arm also uses the concise output style / rules
  --gate                     ambient arm also turns the end-of-turn gate on
  --keep                     keep workspaces (their paths go in the results)
  --label <text>             label stored with the results (default "unlabeled run")
  --caveat <text>            caveat stored with the results (repeatable)
  --out <path>               write <path>.json and <path>.md
  --dry-run                  print the agent command lines and exit
  --tasks-file <file>        default bench/ab/tasks.json
`;

export interface CliDeps {
  run: RunProc;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  tmpRoot?: string;
}

async function versionOf(run: RunProc, cmd: string): Promise<string | undefined> {
  const r = await run({ cmd, args: ['--version'], cwd: process.cwd(), timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim().split('\n')[0] : undefined;
}

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tasks: { type: 'string' },
      pilot: { type: 'boolean' },
      repo: { type: 'string' },
      agent: { type: 'string', default: 'claude' },
      model: { type: 'string' },
      arms: { type: 'string', default: 'baseline,ambient' },
      repeats: { type: 'string', default: '1' },
      timeout: { type: 'string', default: '600' },
      'max-budget-usd': { type: 'string', default: '1' },
      effort: { type: 'string', default: 'low' },
      'no-init-tags': { type: 'boolean' },
      concise: { type: 'boolean' },
      gate: { type: 'boolean' },
      keep: { type: 'boolean' },
      label: { type: 'string', default: 'unlabeled run' },
      caveat: { type: 'string', multiple: true },
      out: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'tasks-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    deps.stdout(HELP);
    return command || values.help ? 0 : 2;
  }
  const set = loadTaskSet(values['tasks-file'] ?? join(AB_DIR, 'tasks.json'));
  const tasks = selectTasks(set, {
    ...(values.tasks ? { ids: values.tasks.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    ...(values.pilot ? { pilot: true } : {}),
    ...(values.repo ? { repo: values.repo } : {}),
  });
  const cacheDir = defaultCacheDir(deps.env);
  const checksDir = join(AB_DIR, 'checks');

  if (command === 'list') {
    for (const t of tasks) deps.stdout(`${t.id.padEnd(28)} ${t.repo.padEnd(10)} ${t.kind.padEnd(9)} ${t.pilot ? 'pilot ' : '      '}${t.prompt.slice(0, 70).replaceAll('\n', ' ')}\n`);
    deps.stdout(`${tasks.length} tasks\n`);
    return 0;
  }

  if (command === 'validate') {
    const res = await validateTasks({ set, tasks, checksDir, cacheDir }, { run: deps.run, log: deps.stderr, ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}) });
    let bad = 0;
    for (const v of res) {
      const ok = v.failsBefore && v.passesAfter;
      if (!ok) bad++;
      deps.stdout(`${ok ? 'ok  ' : 'BAD '} ${v.taskId.padEnd(28)} fails before: ${v.failsBefore ? 'yes' : 'NO'}, passes after fix: ${v.passesAfter ? 'yes' : 'NO'}${v.detail ? `  (${v.detail})` : ''}\n`);
    }
    deps.stdout(`${res.length - bad}/${res.length} tasks valid\n`);
    return bad ? 1 : 0;
  }

  if (command !== 'run') {
    deps.stderr(`unknown command ${command}\n${HELP}`);
    return 2;
  }

  const agent = values.agent as AgentName;
  if (agent !== 'claude' && agent !== 'codex') throw new Error('--agent must be claude or codex');
  const arms = values.arms.split(',').map((s) => s.trim()) as Arm[];
  if (!arms.length || arms.some((a) => a !== 'baseline' && a !== 'ambient')) throw new Error('--arms takes baseline and/or ambient');
  const repeats = Number(values.repeats);
  const timeoutSec = Number(values.timeout);
  const maxBudgetUsd = Number(values['max-budget-usd']);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a positive integer');
  if (!(timeoutSec > 0)) throw new Error('--timeout must be positive');
  if (!(maxBudgetUsd > 0)) throw new Error('--max-budget-usd must be positive');
  const model = values.model ?? (agent === 'claude' ? 'haiku' : undefined);

  if (values['dry-run']) {
    for (const t of tasks) {
      for (const arm of arms) {
        const c = buildAgentCommand(t.prompt, '<workspace>', { agent, arm, pluginDir: REPO_ROOT, ...(model ? { model } : {}), maxBudgetUsd, codexEffort: values.effort, ...(values.concise ? { concise: true } : {}), ...(values.gate ? { gate: true } : {}) }, deps.env);
        deps.stdout(`${t.id} ${arm}: ${c.cmd} ${c.args.map((a) => (/[\s"'()*]/.test(a) ? JSON.stringify(a) : a)).join(' ')}  (prompt on stdin)\n`);
      }
    }
    return 0;
  }

  const started = deps.now();
  const { prep, runs } = await runAll(
    {
      set,
      tasks,
      agent,
      arms,
      repeats,
      ...(model ? { model } : {}),
      pluginDir: REPO_ROOT,
      checksDir,
      cacheDir,
      timeoutSec,
      ...(agent === 'claude' ? { maxBudgetUsd } : { codexEffort: values.effort }),
      initTags: !values['no-init-tags'],
      ...(values.concise ? { concise: true } : {}),
      ...(values.gate ? { gate: true } : {}),
      ...(values.keep ? { keepWorkspaces: true } : {}),
      env: deps.env,
    },
    { run: deps.run, log: (l) => deps.stderr(`${l}\n`), ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}) },
  );
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: string };
  const agentVersion = await versionOf(deps.run, agent);
  const results: ResultsFile = {
    label: values.label,
    date: started.toISOString().slice(0, 10),
    agent,
    ...(model ? { model } : {}),
    ...(agentVersion ? { agentVersion } : {}),
    ...(pkg.version ? { glassboxVersion: pkg.version } : {}),
    arms,
    repeats,
    caveats: values.caveat ?? [],
    settings: {
      timeoutSec,
      ...(agent === 'claude' ? { maxBudgetUsd } : { codexEffort: values.effort }),
      initTags: !values['no-init-tags'],
      concise: values.concise === true,
      gate: values.gate === true,
      tasks: tasks.map((t) => t.id),
    },
    prep,
    runs,
    summary: summarize(runs, arms),
  };
  const md = renderMarkdown(results);
  if (values.out) {
    const base = resolve(values.out);
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}.json`, `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(`${base}.md`, md);
    deps.stderr(`wrote ${base}.json and ${base}.md\n`);
  } else {
    deps.stdout(md);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), {
    run: runProc,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    now: () => new Date(),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
