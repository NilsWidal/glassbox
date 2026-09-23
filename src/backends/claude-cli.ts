import { tmpdir } from 'node:os';
import { buildBatchRequest, parseBatchAnswer } from '../engine/prompt.js';
import type { Backend, BackendCapabilities, BatchQuestion, GenerateOptions, LabelDistribution, State } from '../types.js';
import {
  CliCallError,
  CliNotFoundError,
  isNotFound,
  runProcess,
  tail,
  unknownFlag,
  type ProcessRunner,
} from './process.js';
import { averageSamples, resolveSamples, resolveTimeoutMs, runSamples } from './sampling.js';

export interface ClaudeCliOptions {
  /** Model alias or id. Default 'haiku'. */
  model?: string;
  /** Parallel samples averaged per call (K). Default GLASSBOX_SAMPLES or 3. */
  samples?: number;
  timeoutMs?: number;
  /** Binary name or path. Default GLASSBOX_CLAUDE_BIN or 'claude'. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  run?: ProcessRunner;
}

const INSTALL_HINT =
  'Install Claude Code (https://claude.com/claude-code) and run `claude` once to log in, or pick another backend with GLASSBOX_BACKEND.';

/**
 * Flags that keep the nested call small and side-effect free: no tools, no
 * CLAUDE.md, plugins, hooks, MCP servers or skills, no saved session, no
 * extended thinking. Each group is optional: if an older CLI rejects the flag,
 * the group is dropped and the call retried.
 */
const QUIET_FLAGS: readonly (readonly string[])[] = [
  ['--tools', ''],
  ['--safe-mode'],
  ['--strict-mcp-config'],
  ['--disable-slash-commands'],
  ['--no-session-persistence'],
  ['--setting-sources', ''],
  ['--settings', '{"alwaysThinkingEnabled":false}'],
];

/** The `--output-format json` envelope, as far as we use it. */
interface ClaudeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
}

/** Runs on the Claude Code login via `claude -p` (no API key needed). Default inside Claude Code. */
export class ClaudeCliBackend implements Backend {
  readonly name = 'claude-cli';
  readonly model: string;
  readonly capabilities: BackendCapabilities = { hasLogprobs: false, batch: true, generate: true };
  readonly samples: number;
  private readonly timeoutMs: number;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly run: ProcessRunner;
  private readonly dropped = new Set<string>();

  constructor(opts: ClaudeCliOptions = {}) {
    const env = opts.env ?? process.env;
    this.model = opts.model ?? 'haiku';
    this.samples = opts.samples ?? resolveSamples(env);
    this.timeoutMs = opts.timeoutMs ?? resolveTimeoutMs(env);
    this.bin = opts.bin ?? env.GLASSBOX_CLAUDE_BIN ?? 'claude';
    // GLASSBOX_NESTED lets our own plugin hooks skip work inside the nested call.
    this.env = { ...env, GLASSBOX_NESTED: '1' };
    // Run outside the project so nothing project-local is picked up.
    this.cwd = opts.cwd ?? tmpdir();
    this.run = opts.run ?? runProcess;
  }

  /** Argument list for one call (exported for tests and debugging). */
  args(schema?: Record<string, unknown>): string[] {
    const args = ['-p', '--model', this.model, '--output-format', 'json'];
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    for (const group of QUIET_FLAGS) if (!this.dropped.has(group[0]!)) args.push(...group);
    return args;
  }

  async answerBatch(
    state: State,
    questions: Record<string, BatchQuestion>,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, LabelDistribution>> {
    if (Object.keys(questions).length === 0) return {};
    const req = buildBatchRequest(state, questions);
    const samples = await runSamples(this.samples, async () => {
      const env = await this.call(req.prompt, req.schema, opts?.signal);
      return parseBatchAnswer(env.structured_output ?? env.result, req);
    });
    const byId = Object.fromEntries(Object.entries(req.keys).map(([k, id]) => [id, req.labels[k]!]));
    return averageSamples(samples, byId);
  }

  async generate(prompt: string, opts?: GenerateOptions): Promise<string> {
    const env = await this.call(prompt, undefined, opts?.signal);
    return typeof env.result === 'string' ? env.result.trim() : JSON.stringify(env.result ?? '');
  }

  private async call(prompt: string, schema: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<ClaudeEnvelope> {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.run(this.bin, this.args(schema), {
          input: prompt,
          env: this.env,
          cwd: this.cwd,
          timeoutMs: this.timeoutMs,
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (isNotFound(e)) throw new CliNotFoundError(this.bin, INSTALL_HINT);
        throw e;
      }
      const flag = res.code !== 0 ? unknownFlag(res.stderr) : undefined;
      if (flag && attempt < QUIET_FLAGS.length && QUIET_FLAGS.some((g) => g[0] === flag) && !this.dropped.has(flag)) {
        this.dropped.add(flag);
        continue;
      }
      return parseEnvelope(res.stdout, res.stderr, res.code);
    }
  }
}

/** Parses the JSON envelope and turns error envelopes into clear errors. */
export function parseEnvelope(stdout: string, stderr: string, code: number | null): ClaudeEnvelope {
  let env: ClaudeEnvelope | undefined;
  const text = stdout.trim();
  try {
    env = JSON.parse(text) as ClaudeEnvelope;
  } catch {
    // Some versions may print extra lines; the envelope is the last JSON line.
    const last = text.split('\n').reverse().find((l) => l.trim().startsWith('{'));
    try {
      env = last ? (JSON.parse(last) as ClaudeEnvelope) : undefined;
    } catch {
      env = undefined;
    }
  }
  const detail = [typeof env?.result === 'string' ? env.result : '', tail(stderr), env ? '' : tail(stdout)].filter(Boolean).join('\n');
  if (!env || env.is_error || code !== 0) {
    if (/log ?in|logged in|authenticat|api key|unauthori[sz]ed|oauth/i.test(detail)) {
      throw new CliCallError(`claude is not logged in. Run \`claude\` once and log in, then retry.\n${detail}`, stderr);
    }
    throw new CliCallError(`claude -p failed (exit ${code ?? 'signal'}${env?.subtype ? `, ${env.subtype}` : ''}): ${detail || 'no output'}`, stderr);
  }
  if (env.structured_output === undefined && (env.result === undefined || env.result === '')) {
    throw new CliCallError('claude -p returned no structured output', stderr);
  }
  return env;
}

export function createClaudeCliBackend(opts?: ClaudeCliOptions): ClaudeCliBackend {
  return new ClaudeCliBackend(opts);
}
