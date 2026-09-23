#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { safeNodeId } from '../agents-md/render.js';
import { ask, makeQuestion, type AskOptions } from '../ask.js';
import { createBackend, type BackendConfig } from '../backends/index.js';
import { isBackendName } from '../config.js';
import { runBenchCommand, runCalibrate, runLabel, type BenchFlags, type CalibrateFlags } from '../calibrate/cli.js';
import { loadCalibrators } from '../calibrate/store.js';
import { packageVersion } from '../util/build.js';
import { workingDiff } from '../util/git.js';
import { parseReasons } from '../explain/reasons.js';
import { renderJson, renderPretty } from '../render.js';
import { buildAgentsSummary } from '../memory/summary.js';
import { indexRepo } from '../memory/source.js';
import type { GraphStore } from '../memory/store.js';
import { nodeTagLabels, tagPass, type TagPassResult } from '../memory/tags.js';
import { decide as decideWithGraph } from '../query/decide.js';
import { explainDecision } from '../query/explain.js';
import { renderDecide, renderExplained, renderGraph, renderTriage, renderWhere } from '../query/render.js';
import { triage } from '../query/triage.js';
import { where } from '../query/where.js';
import { syncAgentsMd } from '../agents-md/sync.js';
import {
  MODES,
  modeDecideOptions,
  modeReport,
  resolveMode,
  runWithMode,
  whereBand,
  withModeJson,
  withModeText,
  type ModeSettings,
  type ResolvedMode,
} from '../modes.js';
import type { AskScope } from '../scope.js';
import type { Backend, Calibrator, QuestionType } from '../types.js';
import type { DetachedSpawner } from '../worker/index.js';
import type { ForegroundSpawner } from '../launcher.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * Reads all of stdin (for --diff -). With `maxBytes`, stops reading once
   * more than that arrived and returns undefined, so an oversized input is
   * never held in memory.
   */
  readStdin: (maxBytes?: number) => Promise<string | undefined>;
  /**
   * Calls `onStop` when the process is told to stop (SIGTERM, SIGINT or
   * SIGHUP) and returns a function that removes the handler. Used by the Stop
   * hook to end its model calls before the host kills it.
   */
  onTerminate?: (onStop: () => void) => () => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Test hook: extra backend config merged into the one built from flags. */
  backendConfig?: BackendConfig;
  /** Test hooks: how the worker and `glassbox run` start processes, and the clock. */
  spawnDetached?: DetachedSpawner;
  spawnForeground?: ForegroundSpawner;
  now?: () => number;
}

/** The events `glassbox hook` handles; any other event exits 0 without output. */
export const HOOK_EVENTS = ['prompt', 'stop', 'post-edit', 'session-start', 'model-switch'] as const;

/** This file, which `node <entry> worker run` starts again as the background worker. */
export const CLI_ENTRY = fileURLToPath(import.meta.url);

function version(): string {
  return packageVersion();
}

/**
 * Reads a stream to the end as UTF-8. With `maxBytes`, stops as soon as more
 * than that arrived: the stream is destroyed and the result is undefined.
 */
export async function readStreamCapped(stream: NodeJS.ReadableStream, maxBytes = Infinity): Promise<string | undefined> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > maxBytes) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      return undefined;
    }
    parts.push(b);
  }
  return Buffer.concat(parts).toString('utf8');
}

const TERMINATE_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

const defaultIo: CliIo = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  readStdin: (maxBytes) => readStreamCapped(process.stdin, maxBytes),
  onTerminate: (onStop) => {
    const handler = () => {
      onStop();
      // The abort ends the work; if anything still holds the process, leave anyway.
      setTimeout(() => process.exit(0), 3000).unref();
    };
    for (const sig of TERMINATE_SIGNALS) process.once(sig, handler);
    return () => {
      for (const sig of TERMINATE_SIGNALS) process.removeListener(sig, handler);
    };
  },
  env: process.env,
  cwd: process.cwd(),
};

/** Reads all of stdin; the commands that take a diff or prompt from stdin have no size cap. */
async function readStdinAll(io: CliIo): Promise<string> {
  return (await io.readStdin()) ?? '';
}

function int(name: string, min: number) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new InvalidArgumentError(`${name} must be an integer >= ${min}`);
    return n;
  };
}

function fraction(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new InvalidArgumentError('must be a number from 0 to 1');
  return n;
}

/** Repeatable list option; a value without "=" may also hold several comma-separated items. */
function collect(v: string, prev: string[] = []): string[] {
  return [...prev, ...(v.includes('=') ? [v] : v.split(',').map((s) => s.trim()).filter(Boolean))];
}

interface AskFlags {
  type: QuestionType;
  options?: string[];
  path?: string[];
  diff?: string;
  node?: string[];
  explain?: boolean;
  why?: boolean;
  reasons?: string[];
  budget?: number;
  topK?: number;
  minDelta?: number;
  backend?: string;
  model?: string;
  samples?: number;
  permutations?: number;
  chunkLines?: number;
  root?: string;
  log: boolean;
  json?: boolean;
  mode?: string;
}

async function runAsk(words: string[], flags: AskFlags, io: CliIo): Promise<number> {
  const root = resolve(io.cwd, flags.root ?? '.');
  const scope: AskScope = {};
  if (flags.path?.length) scope.paths = flags.path;
  if (flags.node?.length) scope.nodes = flags.node;
  if (flags.diff !== undefined) scope.diff = flags.diff === '-' ? await readStdinAll(io) : await readFile(resolve(io.cwd, flags.diff), 'utf8');
  if (!scope.paths && !scope.nodes && scope.diff === undefined) scope.paths = ['.'];

  if (flags.backend !== undefined && !isBackendName(flags.backend)) {
    io.stderr(`glassbox: unknown backend "${flags.backend}"\n`);
    return 2;
  }
  const resolved = modeOf(flags, io, root);
  const question = makeQuestion(words.join(' '), flags.type, flags.options ?? []);
  const run = await runWithMode(
    resolved.mode,
    async (_m, s) => {
      const backend = backendFrom(flags, io, s);
      const explainOn = flags.explain ?? s.explain ?? false;
      const explain = explainOn
        ? {
            ...(flags.budget !== undefined ? { budget: flags.budget } : {}),
            ...(flags.topK !== undefined ? { topK: flags.topK } : {}),
            ...(flags.minDelta !== undefined ? { minDelta: flags.minDelta } : {}),
          }
        : false;
      const why = flags.why ?? s.why;
      const decide = modeDecideOptions(s, flags.permutations, await loadCalibrators(root, backend));
      const opts: AskOptions = {
        backend,
        root,
        explain,
        log: flags.log,
        ...(why !== undefined ? { why } : {}),
        ...(flags.reasons?.length ? { reasons: parseReasons(flags.reasons) } : {}),
        ...(decide ? { decide } : {}),
        ...(flags.chunkLines !== undefined ? { chunkLines: flags.chunkLines } : {}),
      };
      return ask(scope, question, opts);
    },
    (r) => r.answer.band,
  );
  const report = modeReport(resolved, run);
  const result = run.result;
  io.stdout(
    `${flags.json ? JSON.stringify(withModeJson(JSON.parse(renderJson(result)) as object, report), null, 2) : withModeText(renderPretty(result), report)}\n`,
  );
  return 0;
}

/** The mode for a command: --mode, then GLASSBOX_MODE, .glassbox/config.json, the plugin option. */
function modeOf(flags: { mode?: string }, io: CliIo, root: string): ResolvedMode {
  try {
    return resolveMode({ explicit: flags.mode, env: io.env, root });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

interface BackendFlags {
  backend?: string;
  model?: string;
  samples?: number;
  permutations?: number;
  root?: string;
  json?: boolean;
  mode?: string;
}

/** Builds the backend from flags (an explicit --samples wins over the mode's); throws a usage error for an unknown name. */
function backendFrom(flags: BackendFlags, io: CliIo, mode: Readonly<ModeSettings> = {}): Backend {
  if (flags.backend !== undefined && !isBackendName(flags.backend)) throw new UsageError(`unknown backend "${flags.backend}"`);
  const samples = flags.samples ?? mode.samples;
  return createBackend({
    env: io.env,
    ...(flags.backend ? { backend: flags.backend as BackendConfig['backend'] & string } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(samples !== undefined ? { samples } : {}),
    ...io.backendConfig,
  });
}

class UsageError extends Error {}

/** node:sqlite is loaded only by commands that use the graph (store.ts loads it lazily), so `ask` stays warning-free. */
async function openStore(root: string): Promise<GraphStore> {
  return (await import('../memory/store.js')).GraphStore.open(root);
}

function rootOf(flags: { root?: string }, io: CliIo): string {
  return resolve(io.cwd, flags.root ?? '.');
}

/** Decide options from flags, plus the fitted calibrators from .glassbox/calibration.json when there are any. */
function permutations(flags: BackendFlags, calibrators: Record<string, Calibrator> = {}) {
  const has = Object.keys(calibrators).length > 0;
  if (flags.permutations === undefined && !has) return {};
  return { decide: { ...(flags.permutations !== undefined ? { permutations: flags.permutations } : {}), ...(has ? { calibrators } : {}) } };
}

/** Opens the store, indexing the graph first (without tags) when it is empty. */
async function openIndexed(root: string, io: CliIo, quiet = false): Promise<GraphStore> {
  const store = await openStore(root);
  if (store.rebuilt && !quiet) io.stderr(`glassbox: rebuilt .glassbox/graph.db, the existing one was not used: ${store.rebuilt}\n`);
  if (store.getNodes({ kind: 'file' }).length === 0) {
    if (!quiet) io.stderr('glassbox: no index yet, indexing the code graph (run `glassbox index` to add tags)\n');
    await indexRepo(root, store);
  }
  return store;
}

async function withStore<T>(store: GraphStore, fn: (s: GraphStore) => Promise<T>): Promise<T> {
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

interface IndexFlags extends BackendFlags {
  tags: boolean;
  force?: boolean;
  concurrency?: number;
  groupSize?: number;
  limit?: number;
  quiet?: boolean;
  claudeMd?: boolean;
  structureOnly?: boolean;
  auto?: boolean;
}

/** Index the graph, then (unless --no-tags) run the tag pass. Returns the report lines and JSON. */
async function runIndex(flags: IndexFlags, io: CliIo, store: GraphStore, root: string) {
  const { graph, sync } = await indexRepo(root, store);
  const lines = [
    `graph  ${graph.files.length} files, ${graph.nodes.length} nodes, ${graph.edges.length} edges` +
      `  (+${sync.added.length} ~${sync.changed.length} -${sync.removed.length}, ${sync.stale.length} stale)`,
  ];
  if (graph.skipped.length) lines.push(`skipped  ${graph.skipped.map((s) => `${s.file} (${s.reason})`).join(', ')}`);
  let tags: TagPassResult | undefined;
  if (flags.tags) {
    const backend = backendFrom(flags, io);
    const progress = !flags.quiet && !flags.json;
    let lastPct = -1;
    tags = await tagPass(root, backend, {
      store,
      ...(flags.force ? { force: true } : {}),
      ...(flags.concurrency !== undefined ? { concurrency: flags.concurrency } : {}),
      ...(flags.groupSize !== undefined ? { groupSize: flags.groupSize } : {}),
      ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
      ...permutations(flags, await loadCalibrators(root, backend)),
      onProgress: (p) => {
        const pct = Math.floor((p.done / p.total) * 10);
        if (progress && (pct !== lastPct || p.done === p.total)) {
          lastPct = pct;
          io.stderr(`tags  ${p.done}/${p.total} nodes\n`);
        }
      },
    });
    lines.push(
      `tags   ${tags.asked} nodes asked, ${tags.cached} cached${tags.deferred ? `, ${tags.deferred} deferred` : ''}` +
        `, ${tags.calls} calls, ${(tags.latencyMs / 1000).toFixed(1)} s, ${backend.name}${backend.model ? ` (${backend.model})` : ''}`,
    );
    for (const f of tags.failed) lines.push(`failed ${f.nodeIds.join(', ')}: ${f.error}`);
  }
  return { lines, json: { graph: { files: graph.files.length, nodes: graph.nodes.length, edges: graph.edges.length, skipped: graph.skipped }, sync, ...(tags ? { tags } : {}) } };
}

async function readDiff(flags: { diff?: string }, io: CliIo, root: string): Promise<string> {
  if (flags.diff === '-') return readStdinAll(io);
  if (flags.diff !== undefined) return readFile(resolve(io.cwd, flags.diff), 'utf8');
  // Default: uncommitted changes against HEAD, plus new untracked files.
  return workingDiff(root);
}

/** Finds a node by exact id, else by a unique name or id suffix. */
function findNode(store: GraphStore, ref: string) {
  const exact = store.getNode(ref);
  if (exact) return { node: exact, matches: [exact] };
  const matches = store.getNodes().filter((n) => n.name === ref || n.name.endsWith(`.${ref}`) || n.id.endsWith(`#${ref}`));
  return { node: matches.length === 1 ? matches[0] : undefined, matches };
}

const MODE_HELP = `${MODES.join(' | ')} (default GLASSBOX_MODE, .glassbox/config.json, else balanced)`;

function addModeOption(cmd: Command): Command {
  return cmd.addOption(new Option('--mode <mode>', MODE_HELP).choices([...MODES]));
}

function addBackendOptions(cmd: Command): Command {
  return cmd
    .option('-b, --backend <name>', 'auto | claude-cli | codex-cli | anthropic | openai-compat | fake (default GLASSBOX_BACKEND or auto)')
    .option('-m, --model <id>', 'model id override (default: GLASSBOX_MODEL, else the model you selected in Claude Code or Codex)')
    .option('--samples <k>', 'samples averaged per call on sampling backends', int('samples', 1))
    .option('--permutations <n>', 'option orders averaged per question (default 2)', int('permutations', 1));
}

export function buildProgram(io: CliIo, setCode: (code: number) => void): Command {
  const program = new Command('glassbox')
    .description("Fast typed decisions about code, with reasons. Runs on the host agent's own model.")
    .enablePositionalOptions()
    .version(version(), '-v, --version')
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command('ask')
    .description('answer a typed question about files, a diff or graph nodes')
    .argument('<question...>', 'the question, e.g. "does this change auth behavior?"')
    .addOption(new Option('-t, --type <type>', 'question type').choices(['yesno', 'choice', 'score']).default('yesno'))
    .option('-o, --options <items>', 'choice: key or key=description; score: levels lowest first (repeatable or comma-separated)', collect)
    .option('-p, --path <paths...>', 'files or directories to ask about (default: the root)')
    .option('-d, --diff <file>', 'a unified diff file to ask about ("-" reads stdin)')
    .option('-n, --node <ids...>', 'graph node ids, e.g. src/auth/session.ts#verifySession')
    .option('-e, --explain', 'find evidence by hiding spans and re-asking, plus reasons and a summary')
    .option('--why', 'always add a one-line why (default: only when confidence is below the act band)')
    .option('--no-why', 'never add the one-line why')
    .option('-r, --reasons <codes>', 'reason codes to check: code or code=question (repeatable or comma-separated)', collect)
    .option('--budget <calls>', 'most backend calls the explanation may spend (default 24)', int('budget', 0))
    .option('--top-k <n>', 'spans to hide and re-ask, most relevant first (default 12)', int('top-k', 0))
    .option('--min-delta <p>', 'smallest |delta p| kept as a highlight (default 0.05)', fraction)
    .option('-b, --backend <name>', 'auto | claude-cli | codex-cli | anthropic | openai-compat | fake (default GLASSBOX_BACKEND or auto)')
    .option('-m, --model <id>', 'model id override (default: GLASSBOX_MODEL, else the model you selected in Claude Code or Codex)')
    .option('--samples <k>', 'samples averaged per call on sampling backends', int('samples', 1))
    .option('--permutations <n>', 'option orders averaged per question (default 2)', int('permutations', 1))
    .option('--chunk-lines <n>', 'longest span in lines (default 8)', int('chunk-lines', 1))
    .addOption(new Option('--mode <mode>', MODE_HELP).choices([...MODES]))
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--no-log', 'do not append to .glassbox/decisions.jsonl')
    .option('--json', 'print JSON instead of the readable format')
    .action(async (words: string[], flags: AskFlags) => {
      setCode(await runAsk(words, flags, io));
    });

  const indexCmd = (name: string, description: string, sync: boolean) => {
    const cmd = addBackendOptions(program.command(name).description(description))
      .option('--no-tags', 'only build the code graph, skip the tag questions')
      .option('--force', 're-ask tags for every node, cached or not')
      .option('--concurrency <n>', 'tag calls in flight at once (default 4)', int('concurrency', 1))
      .option('--group-size <n>', 'nodes asked about in one call (default 4)', int('group-size', 1))
      .option('--limit <n>', 'ask about at most this many nodes now; the rest stay stale', int('limit', 0))
      .option('--root <dir>', 'repo root (default: the current directory)')
      .option('-q, --quiet', 'no progress lines')
      .option('--json', 'print JSON');
    if (sync) {
      cmd
        .option('--no-claude-md', 'do not create CLAUDE.md (an existing one still gets the @AGENTS.md import)')
        .option('--structure-only', 'only parse the code graph: no model calls, no AGENTS.md or CLAUDE.md writes (what auto-init runs)')
        // Set by the session-start hook's detached auto-init: file cap, lock hand-over, worker start.
        .addOption(new Option('--auto').hideHelp());
    }
    return cmd.action(async (flags: IndexFlags) => {
      const root = rootOf(flags, io);
      if (sync && flags.structureOnly) {
        const { structureOnlyInit } = await import('../autoinit/index.js');
        const r = await structureOnlyInit(root, {
          env: io.env,
          ...(flags.auto ? { auto: true, entry: CLI_ENTRY } : {}),
          ...(io.spawnDetached ? { spawner: io.spawnDetached } : {}),
          ...(io.now ? { now: io.now } : {}),
        });
        if (flags.json) io.stdout(`${JSON.stringify({ structureOnly: true, ...r }, null, 2)}\n`);
        else if (r.skipped) io.stderr(`glassbox: structure-only init skipped: ${r.skipped}\n`);
        else if (!flags.quiet) {
          io.stdout(`graph  ${r.files} files, ${r.nodes} nodes, ${r.edges} edges (structure only: no tags, AGENTS.md and CLAUDE.md untouched)\n`);
        }
        return;
      }
      await withStore(await openStore(root), async (store) => {
        const r = await runIndex(flags, io, store, root);
        let md: Awaited<ReturnType<typeof syncAgentsMd>> | undefined;
        if (sync) {
          // Kept in .glassbox/config.json, so later syncs (sync-md, refresh, hooks, launcher) honor it too.
          if (flags.claudeMd === false) {
            const { updateProjectConfig } = await import('../project-config.js');
            updateProjectConfig(root, { claudeMd: false });
          }
          md = await syncAgentsMd(root, buildAgentsSummary(store), { claudeMd: flags.claudeMd !== false });
          r.lines.push(`sync   AGENTS.md ${md.agentsMd}, CLAUDE.md ${md.claudeMd} (${md.lines} lines${md.truncated ? ', truncated' : ''})`);
          const { markFullInit } = await import('../autoinit/index.js');
          markFullInit(root, io.now?.() ?? Date.now());
        }
        io.stdout(`${flags.json ? JSON.stringify({ ...r.json, ...(md ? { sync: md } : {}) }, null, 2) : r.lines.join('\n')}\n`);
      });
    });
  };
  indexCmd('init', 'index the code graph, tag it, and write the AGENTS.md block (plus the CLAUDE.md import)', true);
  indexCmd('index', 'index the code graph and tag changed nodes (cached by content hash)', false);

  addModeOption(
    addBackendOptions(
      program
        .command('where')
        .description('rank the code most likely to implement a concept, e.g. "billing retries"')
        .argument('<concept...>', 'what to look for'),
    ),
  )
    .option('--top <n>', 'hits to show (default 5)', int('top', 1))
    .option('--candidates <n>', 'prefiltered nodes the model checks (default 8)', int('candidates', 1))
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--json', 'print JSON')
    .action(async (words: string[], flags: BackendFlags & { top?: number; candidates?: number }) => {
      const root = rootOf(flags, io);
      const resolved = modeOf(flags, io, root);
      backendFrom(flags, io);
      await withStore(await openIndexed(root, io, flags.json), async (store) => {
        const run = await runWithMode(
          resolved.mode,
          async (_m, s) => {
            const backend = backendFrom(flags, io, s);
            const decide = modeDecideOptions(s, flags.permutations, await loadCalibrators(root, backend));
            return where(words.join(' '), {
              store,
              root,
              backend,
              ...(flags.top !== undefined ? { top: flags.top } : {}),
              ...(flags.candidates !== undefined ? { candidates: flags.candidates } : {}),
              ...(decide ? { decide } : {}),
            });
          },
          (r) => whereBand(r.hits[0]?.p),
        );
        const report = modeReport(resolved, run);
        io.stdout(`${flags.json ? JSON.stringify(withModeJson(run.result, report), null, 2) : withModeText(renderWhere(run.result), report)}\n`);
      });
    });

  addModeOption(addBackendOptions(program.command('triage').description('score the risk of a diff per hunk and show the callers it affects')))
    .option('-d, --diff <file>', 'unified diff file ("-" reads stdin; default: git diff HEAD)')
    .option('--no-explain', 'skip the hide-and-re-ask evidence')
    .option('--budget <calls>', 'most backend calls the evidence may spend (default 12)', int('budget', 0))
    .option('--chunk-lines <n>', 'longest hunk window in diff lines (default 8)', int('chunk-lines', 1))
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--no-log', 'do not append to .glassbox/decisions.jsonl')
    .option('--json', 'print JSON')
    .action(
      async (flags: BackendFlags & { diff?: string; explain: boolean; budget?: number; chunkLines?: number; log: boolean }, cmd: Command) => {
        const root = rootOf(flags, io);
        const resolved = modeOf(flags, io, root);
        const diff = await readDiff(flags, io, root);
        if (!diff.trim()) {
          io.stdout('no changes to triage\n');
          return;
        }
        backendFrom(flags, io);
        // --no-explain given on the command line wins over the mode; otherwise the mode decides (default on).
        const explicitExplain = cmd.getOptionValueSource('explain') === 'cli' ? flags.explain : undefined;
        await withStore(await openIndexed(root, io, flags.json), async (store) => {
          const run = await runWithMode(
            resolved.mode,
            async (_m, s) => {
              const backend = backendFrom(flags, io, s);
              const explainOn = explicitExplain ?? s.explain ?? true;
              const decide = modeDecideOptions(s, flags.permutations, await loadCalibrators(root, backend));
              return triage(diff, {
                store,
                root,
                backend,
                explain: explainOn ? (flags.budget !== undefined ? { budget: flags.budget } : true) : false,
                log: flags.log,
                ...(flags.chunkLines !== undefined ? { chunkLines: flags.chunkLines } : {}),
                ...(decide ? { decide } : {}),
              });
            },
            (r) => r.overall.band,
          );
          const r = run.result;
          const report = modeReport(resolved, run);
          if (flags.json) {
            const { record, hunks, ...rest } = r;
            io.stdout(
              `${JSON.stringify(withModeJson({ ...rest, id: record.id, hunks: hunks.map(({ answer: _a, ...h }) => h) }, report), null, 2)}\n`,
            );
          } else io.stdout(`${withModeText(renderTriage(r), report)}\n`);
        });
      },
    );

  addModeOption(
    addBackendOptions(
      program
        .command('decide')
        .description('advise on your own "A or B?" question with probabilities, using graph tags as context')
        .argument('<question...>', 'the question, e.g. "where should the retry limit live?"'),
    ),
  )
    .requiredOption('-o, --options <items>', 'the options: key or key=description (repeatable or comma-separated)', collect)
    .option('-c, --context <text>', 'extra context for the question')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--no-log', 'do not append to .glassbox/decisions.jsonl')
    .option('--json', 'print JSON')
    .action(async (words: string[], flags: BackendFlags & { options: string[]; context?: string; log: boolean }) => {
      const root = rootOf(flags, io);
      const resolved = modeOf(flags, io, root);
      backendFrom(flags, io);
      await withStore(await openIndexed(root, io, flags.json), async (store) => {
        const run = await runWithMode(
          resolved.mode,
          async (_m, s) => {
            const backend = backendFrom(flags, io, s);
            const decide = modeDecideOptions(s, flags.permutations, await loadCalibrators(root, backend));
            return decideWithGraph(words.join(' '), flags.options, flags.context, {
              store,
              root,
              backend,
              log: flags.log,
              ...(decide ? { decide } : {}),
            });
          },
          (r) => r.band,
        );
        const r = run.result;
        const report = modeReport(resolved, run);
        if (flags.json) {
          const { record, ...rest } = r;
          io.stdout(`${JSON.stringify(withModeJson({ ...rest, id: record.id }, report), null, 2)}\n`);
        } else io.stdout(`${withModeText(renderDecide(r), report)}\n`);
      });
    });

  addBackendOptions(
    program
      .command('explain')
      .description('show or add evidence and reasons for an earlier decision')
      .argument('<decisionId>', 'the id printed by ask, triage or decide (a unique prefix works)'),
  )
    .option('--refresh', 're-run the evidence pass even when the log has one')
    .option('--budget <calls>', 'most backend calls the evidence may spend', int('budget', 0))
    .option('--diff <file>', 'the diff the decision was made on ("-" reads stdin; default: git diff HEAD)')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--json', 'print JSON')
    .action(async (id: string, flags: BackendFlags & { refresh?: boolean; budget?: number; diff?: string }) => {
      const root = rootOf(flags, io);
      const { GraphStore } = await import('../memory/store.js');
      let store: GraphStore | undefined;
      try {
        const r = await explainDecision(id, {
          root,
          backend: () => backendFrom(flags, io),
          store: () => (store ??= GraphStore.open(root)),
          // Logs keep only a diff's hash; the diff is read only when a re-ask needs it.
          diff: () => readDiff(flags, io, root),
          ...(flags.refresh ? { refresh: true } : {}),
          ...(flags.budget !== undefined ? { budget: flags.budget } : {}),
        });
        io.stdout(`${flags.json ? JSON.stringify(r, null, 2) : renderExplained(r)}\n`);
      } finally {
        store?.close();
      }
    });

  program
    .command('sync-md')
    .description('write the glassbox block into AGENTS.md from the stored graph and tags (no model calls)')
    .option('--no-claude-md', 'do not create CLAUDE.md (an existing one still gets the @AGENTS.md import)')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--json', 'print JSON')
    .action(async (flags: { root?: string; claudeMd: boolean; json?: boolean }) => {
      const root = rootOf(flags, io);
      await withStore(await openIndexed(root, io, flags.json), async (store) => {
        const md = await syncAgentsMd(root, buildAgentsSummary(store), { claudeMd: flags.claudeMd });
        io.stdout(
          flags.json
            ? `${JSON.stringify(md, null, 2)}\n`
            : `AGENTS.md ${md.agentsMd}, CLAUDE.md ${md.claudeMd} (${md.lines} lines${md.truncated ? ', truncated' : ''})\n`,
        );
      });
    });

  program
    .command('graph')
    .description("show a node's stored tags and its neighbours")
    .argument('<node>', 'node id (src/auth/session.ts#verifySession), or a unique name')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--json', 'print JSON')
    .action(async (ref: string, flags: { root?: string; json?: boolean }) => {
      const root = rootOf(flags, io);
      await withStore(await openIndexed(root, io, flags.json), async (store) => {
        const { node, matches } = findNode(store, ref);
        if (!node) {
          io.stderr(
            matches.length
              ? `glassbox: "${ref}" matches ${matches.length} nodes: ${matches.slice(0, 8).map((n) => safeNodeId(n.id)).join(', ')}\n`
              : `glassbox: no node "${ref}"\n`,
          );
          setCode(1);
          return;
        }
        const view = { node, tags: nodeTagLabels(store, node.id), out: store.edgesFrom(node.id), in: store.edgesTo(node.id) };
        io.stdout(
          `${flags.json ? JSON.stringify({ ...view, tags: store.getTags(node.id) }, null, 2) : renderGraph(view)}\n`,
        );
      });
    });

  addBackendOptions(
    program
      .command('refresh')
      .description('update the graph: mark edited files stale (fast, for hooks), or re-parse changed files'),
  )
    .option('-f, --files <paths...>', 'only mark these files\' nodes and their direct dependents stale (no parsing, no model calls)')
    .option('--tags', 're-ask tags for stale nodes after re-parsing (model calls)')
    .option('--limit <n>', 'with --tags: re-tag at most this many nodes now', int('limit', 0))
    .option('--sync-md', 'rewrite the AGENTS.md block afterwards')
    .option('--no-claude-md', 'with --sync-md: do not create CLAUDE.md')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('-q, --quiet', 'print nothing unless something failed')
    .option('--json', 'print JSON')
    .action(
      async (
        flags: BackendFlags & { files?: string[]; tags?: boolean; limit?: number; syncMd?: boolean; claudeMd: boolean; quiet?: boolean },
      ) => {
        const { refresh, renderRefresh } = await import('../memory/refresh.js');
        const r = await refresh(rootOf(flags, io), {
          ...(flags.files ? { files: flags.files } : {}),
          ...(flags.tags ? { tags: true, backend: () => backendFrom(flags, io) } : {}),
          ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
          ...(flags.syncMd ? { syncMd: { claudeMd: flags.claudeMd } } : {}),
        });
        if (flags.json) io.stdout(`${JSON.stringify(r, null, 2)}\n`);
        else if (!flags.quiet) io.stdout(`${renderRefresh(r)}\n`);
      },
    );

  program
    .command('mcp')
    .description('run the glassbox MCP server on stdio (for Claude Code, Codex and other MCP clients)')
    .option('--root <dir>', 'repo root (default: GLASSBOX_ROOT, CLAUDE_PROJECT_DIR or the current directory)')
    .action(async (flags: { root?: string }) => {
      // Loaded here so the other commands never pay for the MCP SDK.
      const { runStdioServer } = await import('../mcp/server.js');
      await runStdioServer({
        env: io.env,
        cwd: io.cwd,
        ...(flags.root ? { root: flags.root } : {}),
        ...(io.backendConfig ? { backendConfig: io.backendConfig } : {}),
      });
    });

  program
    .command('label')
    .description('record the true answer of a logged decision, for calibrate')
    .argument('<decisionId>', 'the id printed by ask, triage or decide (a unique prefix works)')
    .argument('<answer>', 'yes/no, a choice key, or a score level (index or text)')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--json', 'print JSON')
    .action(async (id: string, answer: string, flags: { root?: string; json?: boolean }) => {
      setCode(await runLabel(id, answer, flags, io));
    });

  program
    .command('calibrate')
    .description('fit temperature or Platt scaling from labeled decisions; saves .glassbox/calibration.json')
    .addOption(new Option('--method <m>', 'fit method (auto: Platt for yes/no with 30+ labels, else temperature)').choices(['auto', 'temperature', 'platt']))
    .option('--min-labels <n>', 'labels needed before fitting a group (default 8)', int('min-labels', 1))
    .option('--dry-run', 'report only, do not save')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--json', 'print JSON')
    .action(async (flags: CalibrateFlags) => {
      setCode(await runCalibrate(flags, io));
    });

  addBackendOptions(program.command('bench').description('run the labeled benchmark and write bench/results/<backend>.json and .md'))
    .option('--file <path>', 'bench file (default: bench/questions.json)')
    .option('--out <dir>', 'results directory (default: results/ next to the bench file)')
    .option('--limit <n>', 'only the first n questions', int('limit', 1))
    .option('--group-size <n>', 'questions per batched call (default 8)', int('group-size', 1))
    .option('--concurrency <n>', 'batched decisions in flight (default 2)', int('concurrency', 1))
    .option('--no-faithfulness', 'skip the deletion and sufficiency tests')
    .option('--faith-limit <n>', 'yes/no items given faithfulness tests (default: all)', int('faith-limit', 0))
    .option('--faith-budget <calls>', 'occlusion calls per faithfulness item (default 10)', int('faith-budget', 1))
    .option('--no-write', 'print only, do not write result files')
    .option('--note <text...>', 'caveats to record in the results (for example the model a CLI default resolved to)')
    .option('-q, --quiet', 'no progress lines')
    .option('--json', 'print JSON')
    .action(async (flags: BenchFlags & BackendFlags) => {
      if (flags.backend !== undefined && !isBackendName(flags.backend)) throw new UsageError(`unknown backend "${flags.backend}"`);
      setCode(
        await runBenchCommand(flags, io, (rules) =>
          createBackend({
            env: io.env,
            ...(flags.backend ? { backend: flags.backend as BackendConfig['backend'] & string } : {}),
            ...(flags.model ? { model: flags.model } : {}),
            ...(flags.samples !== undefined ? { samples: flags.samples } : {}),
            fake: { rules },
            ...io.backendConfig,
          }),
        ),
      );
    });

  program
    .command('context')
    .description('graph-only context for a prompt: matching file:line with tags and callers (no model call)')
    .option('--prompt <text>', 'the prompt ("-" reads stdin)', '-')
    .option('--max-chars <n>', 'most characters of output (default 1500)', int('max-chars', 100))
    .option('--min-score <n>', 'lowest match score shown (default 3)', Number)
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--json', 'print JSON')
    .action(async (flags: { prompt: string; maxChars?: number; minScore?: number; root?: string; json?: boolean }) => {
      const { ambientContext } = await import('../ambient/context.js');
      const prompt = flags.prompt === '-' ? await readStdinAll(io) : flags.prompt;
      const r = ambientContext({
        root: rootOf(flags, io),
        prompt,
        ...(flags.maxChars !== undefined ? { maxChars: flags.maxChars } : {}),
        ...(flags.minScore !== undefined && Number.isFinite(flags.minScore) ? { minScore: flags.minScore } : {}),
      });
      if (flags.json) io.stdout(`${JSON.stringify(r, null, 2)}\n`);
      else if (r.text) io.stdout(`${r.text}\n`);
    });

  program
    .command('status')
    .description('show the graph, mode, hook switches and the background worker (calls today, budget, last run)')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--json', 'print JSON')
    .action(async (flags: { root?: string; json?: boolean }) => {
      const { status, renderStatus } = await import('../status.js');
      const now = io.now?.() ?? Date.now();
      const r = await status(rootOf(flags, io), io.env, now);
      io.stdout(`${flags.json ? JSON.stringify(r, null, 2) : renderStatus(r, now)}\n`);
    });

  const worker = program.command('worker').description('the background re-tagging worker');
  addBackendOptions(worker.command('run').description('re-parse changed files and re-tag stale nodes in fast mode, within the daily budget'))
    .option('--force', 'ignore the minimum interval between runs (the daily budget still applies)')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('-q, --quiet', 'print nothing')
    .option('--json', 'print JSON')
    .action(async (flags: BackendFlags & { force?: boolean; quiet?: boolean }) => {
      const { runWorker } = await import('../worker/index.js');
      const { withPluginOptions } = await import('../mcp/env.js');
      const env = withPluginOptions(io.env);
      const now = io.now;
      const r = await runWorker(rootOf(flags, io), {
        env,
        backend: () => backendFrom(flags, { ...io, env }, { samples: 1 }),
        ...(now ? { now } : {}),
        ...(flags.force ? { ignoreInterval: true } : {}),
      });
      if (flags.json) io.stdout(`${JSON.stringify(r, null, 2)}\n`);
      else if (!flags.quiet) {
        io.stdout(
          r.ran && r.summary
            ? `worker  ${r.summary.asked} nodes asked, ${r.summary.tags} tags, ${r.summary.modelRuns} model runs, ${r.summary.failed} failed` +
                `${r.summary.deferred ? `, ${r.summary.deferred} left` : ''}; today ${r.state.callsToday} model runs\n`
            : `worker  nothing done: ${r.reason ?? 'unknown'}\n`,
        );
      }
    });

  program
    .command('hook')
    .description(
      'entry point for agent hooks: reads the hook JSON on stdin; exits 0 and prints nothing on any error or an unknown event',
    )
    .addArgument(new Argument('[event]', `hook event: ${HOOK_EVENTS.join(', ')}`))
    .option('--host <host>', 'the agent running the hook: claude-code or codex (anything else is ignored)')
    .option('--root <dir>', 'repo root (default: CLAUDE_PROJECT_DIR, the hook input cwd, or the current directory)')
    // A hook must never fail the turn: extra arguments and unknown options are ignored, not errors.
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    // Silent on argument errors too (a missing option value): the host shows hook stderr to the user.
    .configureOutput({ writeOut: io.stdout, writeErr: () => {}, outputError: () => {} })
    .action(async (event: string | undefined, rawFlags: { host?: string; root?: string }) => {
      setCode(0);
      const flags = { ...rawFlags, host: rawFlags.host === 'claude-code' || rawFlags.host === 'codex' ? rawFlags.host : undefined };
      // GLASSBOX_NESTED: this is glassbox's own model call; do nothing before even reading stdin.
      if (io.env.GLASSBOX_NESTED === '1') return;
      // A missing or unknown event is not an error: a host may send events this version does not know.
      if (event === undefined || !(HOOK_EVENTS as readonly string[]).includes(event)) return;
      const stop = new AbortController();
      const off = event === 'stop' ? io.onTerminate?.(() => stop.abort()) : undefined;
      try {
        const hooks = await import('../hooks/index.js');
        const text = await readStdinCapped(io, HOOK_STDIN_MS, hooks.MAX_HOOK_INPUT);
        const input = hooks.parseHookInput(text);
        const { withPluginOptions } = await import('../mcp/env.js');
        const ctx: import('../hooks/index.js').HookContext = {
          env: io.env,
          cwd: io.cwd,
          entry: CLI_ENTRY,
          ...(flags.root ? { root: flags.root } : {}),
          ...(flags.host ? { host: flags.host } : {}),
          ...(io.spawnDetached ? { spawner: io.spawnDetached } : {}),
          ...(io.now ? { now: io.now } : {}),
          signal: stop.signal,
          backend: ({ samples, env }) =>
            createBackend({ env: withPluginOptions(env), ...(samples !== undefined ? { samples } : {}), ...io.backendConfig }),
        };
        let out = '';
        if (event === 'prompt') out = hooks.promptHook(input, ctx);
        else if (event === 'stop') out = await hooks.stopHook(input, ctx);
        else if (event === 'post-edit') out = await hooks.postEditHook(input, ctx);
        else if (event === 'model-switch') out = hooks.modelSwitchHook(input, ctx);
        else out = await hooks.sessionStartHook(input, ctx);
        if (out) io.stdout(`${out}\n`);
      } catch {
        // Fail open: the agent carries on as if the hook were not there.
      } finally {
        off?.();
      }
    });

  program
    .command('run')
    .description('refresh the graph and AGENTS.md if files changed, then run claude or codex with its args passed through untouched')
    .addArgument(new Argument('<agent>', 'the agent to run').choices(['claude', 'codex']))
    .argument('[args...]', 'arguments for the agent (put glassbox options before the agent name)')
    .addOption(new Option('--mode <mode>', `set GLASSBOX_MODE for the session: ${MODES.join(' | ')}`).choices([...MODES]))
    .option('--no-refresh', 'do not refresh the graph or AGENTS.md first')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .passThroughOptions()
    .allowUnknownOption()
    .helpOption(false)
    .action(async (agent: string, args: string[], flags: { mode?: string; refresh: boolean; root?: string }) => {
      const { launch, isAgent } = await import('../launcher.js');
      if (!isAgent(agent)) throw new UsageError(`unknown agent "${agent}"`);
      const root = rootOf(flags, io);
      if (flags.mode === undefined) modeOf({}, io, root);
      setCode(
        await launch({
          agent,
          args,
          root,
          cwd: io.cwd,
          env: io.env,
          ...(flags.mode ? { mode: flags.mode } : {}),
          refresh: flags.refresh,
          entry: CLI_ENTRY,
          log: (line) => io.stderr(`${line}\n`),
          ...(io.spawnForeground ? { spawner: io.spawnForeground } : {}),
          ...(io.spawnDetached ? { workerSpawner: io.spawnDetached } : {}),
        }),
      );
    });

  return program;
}

const HOOK_STDIN_MS = 2000;

/** Reads stdin, giving up (empty input) after `ms` or once more than `max` bytes arrived. */
async function readStdinCapped(io: CliIo, ms: number, max: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const text = await Promise.race([
      io.readStdin(max),
      new Promise<string>((done) => {
        timer = setTimeout(() => done(''), ms);
      }),
    ]);
    return text === undefined || text.length > max ? '' : text;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the CLI and returns the exit code (never calls process.exit). */
export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let code = 0;
  const program = buildProgram(io, (c) => (code = c));
  if (argv.length === 0) {
    io.stdout(program.helpInformation());
    return 0;
  }
  try {
    await program.parseAsync(argv, { from: 'user' });
    return code;
  } catch (err) {
    // `glassbox hook` exits 0 whatever it was given (a missing option value, say), as its help says.
    if (err instanceof CommanderError) return err.exitCode === 0 || argv[0] === 'hook' ? 0 : 2;
    if (err instanceof UsageError) {
      io.stderr(`glassbox: ${err.message}\n`);
      return 2;
    }
    io.stderr(`glassbox: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** True when this file is the process entry point (also through the npm bin symlink). */
function isEntry(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  const argv = process.argv.slice(2);
  main(argv).then(
    (code) => {
      process.exitCode = code;
      // A hook run by hand on a terminal would otherwise wait for stdin to close.
      if (argv[0] === 'hook') process.stdin.destroy();
    },
    (err: unknown) => {
      process.stderr.write(`glassbox: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
