#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { ask, makeQuestion, type AskOptions } from '../ask.js';
import { createBackend, type BackendConfig } from '../backends/index.js';
import { isBackendName } from '../config.js';
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
import type { AskScope } from '../scope.js';
import type { Backend, QuestionType } from '../types.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Reads all of stdin (for --diff -). */
  readStdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Test hook: extra backend config merged into the one built from flags. */
  backendConfig?: BackendConfig;
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(parts).toString('utf8');
}

const defaultIo: CliIo = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  readStdin: () => readAll(process.stdin),
  env: process.env,
  cwd: process.cwd(),
};

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
}

async function runAsk(words: string[], flags: AskFlags, io: CliIo): Promise<number> {
  const root = resolve(io.cwd, flags.root ?? '.');
  const scope: AskScope = {};
  if (flags.path?.length) scope.paths = flags.path;
  if (flags.node?.length) scope.nodes = flags.node;
  if (flags.diff !== undefined) scope.diff = flags.diff === '-' ? await io.readStdin() : await readFile(resolve(io.cwd, flags.diff), 'utf8');
  if (!scope.paths && !scope.nodes && scope.diff === undefined) scope.paths = ['.'];

  if (flags.backend !== undefined && !isBackendName(flags.backend)) {
    io.stderr(`glassbox: unknown backend "${flags.backend}"\n`);
    return 2;
  }
  const backend = createBackend({
    env: io.env,
    ...(flags.backend ? { backend: flags.backend as BackendConfig['backend'] & string } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.samples !== undefined ? { samples: flags.samples } : {}),
    ...io.backendConfig,
  });

  const explain = flags.explain
    ? {
        ...(flags.budget !== undefined ? { budget: flags.budget } : {}),
        ...(flags.topK !== undefined ? { topK: flags.topK } : {}),
        ...(flags.minDelta !== undefined ? { minDelta: flags.minDelta } : {}),
      }
    : false;
  const opts: AskOptions = {
    backend,
    root,
    explain,
    log: flags.log,
    ...(flags.why !== undefined ? { why: flags.why } : {}),
    ...(flags.reasons?.length ? { reasons: parseReasons(flags.reasons) } : {}),
    ...(flags.permutations !== undefined ? { decide: { permutations: flags.permutations } } : {}),
    ...(flags.chunkLines !== undefined ? { chunkLines: flags.chunkLines } : {}),
  };
  const result = await ask(scope, makeQuestion(words.join(' '), flags.type, flags.options ?? []), opts);
  io.stdout(`${flags.json ? renderJson(result) : renderPretty(result)}\n`);
  return 0;
}

interface BackendFlags {
  backend?: string;
  model?: string;
  samples?: number;
  permutations?: number;
  root?: string;
  json?: boolean;
}

/** Builds the backend from flags; throws a usage error for an unknown name. */
function backendFrom(flags: BackendFlags, io: CliIo): Backend {
  if (flags.backend !== undefined && !isBackendName(flags.backend)) throw new UsageError(`unknown backend "${flags.backend}"`);
  return createBackend({
    env: io.env,
    ...(flags.backend ? { backend: flags.backend as BackendConfig['backend'] & string } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.samples !== undefined ? { samples: flags.samples } : {}),
    ...io.backendConfig,
  });
}

class UsageError extends Error {}

/** node:sqlite is loaded only by commands that use the graph, so `ask` stays warning-free. */
async function openStore(root: string): Promise<GraphStore> {
  return (await import('../memory/store.js')).GraphStore.open(root);
}

function rootOf(flags: { root?: string }, io: CliIo): string {
  return resolve(io.cwd, flags.root ?? '.');
}

function permutations(flags: BackendFlags) {
  return flags.permutations !== undefined ? { decide: { permutations: flags.permutations } } : {};
}

/** Opens the store, indexing the graph first (without tags) when it is empty. */
async function openIndexed(root: string, io: CliIo, quiet = false): Promise<GraphStore> {
  const store = await openStore(root);
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
      ...permutations(flags),
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
  if (flags.diff === '-') return io.readStdin();
  if (flags.diff !== undefined) return readFile(resolve(io.cwd, flags.diff), 'utf8');
  // Default: uncommitted changes against HEAD.
  return new Promise((ok, fail) => {
    execFile('git', ['diff', 'HEAD'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err ? fail(new Error(`git diff failed: ${err.message}`)) : ok(stdout),
    );
  });
}

/** Finds a node by exact id, else by a unique name or id suffix. */
function findNode(store: GraphStore, ref: string) {
  const exact = store.getNode(ref);
  if (exact) return { node: exact, matches: [exact] };
  const matches = store.getNodes().filter((n) => n.name === ref || n.name.endsWith(`.${ref}`) || n.id.endsWith(`#${ref}`));
  return { node: matches.length === 1 ? matches[0] : undefined, matches };
}

function addBackendOptions(cmd: Command): Command {
  return cmd
    .option('-b, --backend <name>', 'auto | claude-cli | codex-cli | anthropic | openai-compat | fake (default GLASSBOX_BACKEND or auto)')
    .option('-m, --model <id>', 'model id (default GLASSBOX_MODEL or the backend default)')
    .option('--samples <k>', 'samples averaged per call on sampling backends', int('samples', 1))
    .option('--permutations <n>', 'option orders averaged per question (default 2)', int('permutations', 1));
}

export function buildProgram(io: CliIo, setCode: (code: number) => void): Command {
  const program = new Command('glassbox')
    .description("Fast typed decisions about code, with reasons. Runs on the host agent's own model.")
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
    .option('-m, --model <id>', 'model id (default GLASSBOX_MODEL or the backend default)')
    .option('--samples <k>', 'samples averaged per call on sampling backends', int('samples', 1))
    .option('--permutations <n>', 'option orders averaged per question (default 2)', int('permutations', 1))
    .option('--chunk-lines <n>', 'longest span in lines (default 8)', int('chunk-lines', 1))
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
    if (sync) cmd.option('--no-claude-md', 'do not create CLAUDE.md (an existing one still gets the @AGENTS.md import)');
    return cmd.action(async (flags: IndexFlags) => {
      const root = rootOf(flags, io);
      await withStore(await openStore(root), async (store) => {
        const r = await runIndex(flags, io, store, root);
        let md: Awaited<ReturnType<typeof syncAgentsMd>> | undefined;
        if (sync) {
          md = await syncAgentsMd(root, buildAgentsSummary(store), { claudeMd: flags.claudeMd !== false });
          r.lines.push(`sync   AGENTS.md ${md.agentsMd}, CLAUDE.md ${md.claudeMd} (${md.lines} lines${md.truncated ? ', truncated' : ''})`);
        }
        io.stdout(`${flags.json ? JSON.stringify({ ...r.json, ...(md ? { sync: md } : {}) }, null, 2) : r.lines.join('\n')}\n`);
      });
    });
  };
  indexCmd('init', 'index the code graph, tag it, and write the AGENTS.md block (plus the CLAUDE.md import)', true);
  indexCmd('index', 'index the code graph and tag changed nodes (cached by content hash)', false);

  addBackendOptions(
    program
      .command('where')
      .description('rank the code most likely to implement a concept, e.g. "billing retries"')
      .argument('<concept...>', 'what to look for'),
  )
    .option('--top <n>', 'hits to show (default 5)', int('top', 1))
    .option('--candidates <n>', 'prefiltered nodes the model checks (default 8)', int('candidates', 1))
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--json', 'print JSON')
    .action(async (words: string[], flags: BackendFlags & { top?: number; candidates?: number }) => {
      const root = rootOf(flags, io);
      const backend = backendFrom(flags, io);
      await withStore(await openIndexed(root, io, flags.json), async (store) => {
        const r = await where(words.join(' '), {
          store,
          root,
          backend,
          ...(flags.top !== undefined ? { top: flags.top } : {}),
          ...(flags.candidates !== undefined ? { candidates: flags.candidates } : {}),
          ...permutations(flags),
        });
        io.stdout(`${flags.json ? JSON.stringify(r, null, 2) : renderWhere(r)}\n`);
      });
    });

  addBackendOptions(program.command('triage').description('score the risk of a diff per hunk and show the callers it affects'))
    .option('-d, --diff <file>', 'unified diff file ("-" reads stdin; default: git diff HEAD)')
    .option('--no-explain', 'skip the hide-and-re-ask evidence')
    .option('--budget <calls>', 'most backend calls the evidence may spend (default 12)', int('budget', 0))
    .option('--chunk-lines <n>', 'longest hunk window in diff lines (default 8)', int('chunk-lines', 1))
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--no-log', 'do not append to .glassbox/decisions.jsonl')
    .option('--json', 'print JSON')
    .action(async (flags: BackendFlags & { diff?: string; explain: boolean; budget?: number; chunkLines?: number; log: boolean }) => {
      const root = rootOf(flags, io);
      const diff = await readDiff(flags, io, root);
      if (!diff.trim()) {
        io.stdout('no changes to triage\n');
        return;
      }
      const backend = backendFrom(flags, io);
      await withStore(await openIndexed(root, io, flags.json), async (store) => {
        const r = await triage(diff, {
          store,
          root,
          backend,
          explain: flags.explain ? (flags.budget !== undefined ? { budget: flags.budget } : true) : false,
          log: flags.log,
          ...(flags.chunkLines !== undefined ? { chunkLines: flags.chunkLines } : {}),
          ...permutations(flags),
        });
        if (flags.json) {
          const { record, hunks, ...rest } = r;
          io.stdout(`${JSON.stringify({ ...rest, id: record.id, hunks: hunks.map(({ answer: _a, ...h }) => h) }, null, 2)}\n`);
        } else io.stdout(`${renderTriage(r)}\n`);
      });
    });

  addBackendOptions(
    program
      .command('decide')
      .description('advise on your own "A or B?" question with probabilities, using graph tags as context')
      .argument('<question...>', 'the question, e.g. "where should the retry limit live?"'),
  )
    .requiredOption('-o, --options <items>', 'the options: key or key=description (repeatable or comma-separated)', collect)
    .option('-c, --context <text>', 'extra context for the question')
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--no-log', 'do not append to .glassbox/decisions.jsonl')
    .option('--json', 'print JSON')
    .action(async (words: string[], flags: BackendFlags & { options: string[]; context?: string; log: boolean }) => {
      const root = rootOf(flags, io);
      const backend = backendFrom(flags, io);
      await withStore(await openIndexed(root, io, flags.json), async (store) => {
        const r = await decideWithGraph(words.join(' '), flags.options, flags.context, {
          store,
          root,
          backend,
          log: flags.log,
          ...permutations(flags),
        });
        if (flags.json) {
          const { record, ...rest } = r;
          io.stdout(`${JSON.stringify({ ...rest, id: record.id }, null, 2)}\n`);
        } else io.stdout(`${renderDecide(r)}\n`);
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
    .option('--root <dir>', 'repo root (default: the current directory)')
    .option('--json', 'print JSON')
    .action(async (id: string, flags: BackendFlags & { refresh?: boolean; budget?: number }) => {
      const root = rootOf(flags, io);
      const { GraphStore } = await import('../memory/store.js');
      let store: GraphStore | undefined;
      try {
        const r = await explainDecision(id, {
          root,
          backend: () => backendFrom(flags, io),
          store: () => (store ??= GraphStore.open(root)),
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
              ? `glassbox: "${ref}" matches ${matches.length} nodes: ${matches.slice(0, 8).map((n) => n.id).join(', ')}\n`
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

  return program;
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
    if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 2;
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
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      process.stderr.write(`glassbox: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
