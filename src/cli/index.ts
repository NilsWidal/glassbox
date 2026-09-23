#!/usr/bin/env node
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
import type { AskScope } from '../scope.js';
import type { QuestionType } from '../types.js';

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
