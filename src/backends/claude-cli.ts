import { tmpdir } from 'node:os';
import { describeChoice, resolveClaudeModel, type ModelChoice } from '../model-choice.js';
import { buildBatchRequest, parseBatchAnswer } from '../engine/prompt.js';
import type { Backend, BackendCapabilities, BatchQuestion, GenerateOptions, LabelDistribution, State } from '../types.js';
import {
  CliCallError,
  CliNotFoundError,
  checkModelId,
  cliChildEnv,
  isNotFound,
  runProcess,
  tail,
  unknownFlag,
  type ProcessRunner,
} from './process.js';
import { averageSamples, resolveSamples, resolveTimeoutMs, runSamples } from './sampling.js';

export interface ClaudeCliOptions {
  /**
   * Model alias or id, fixed for this backend (a --model flag or an API
   * caller's choice). Default: none, so each call mirrors the model the user
   * selected in Claude Code (see resolveClaudeModel).
   */
  model?: string;
  /** Claude Code project dir for its settings and the session file. Default CLAUDE_PROJECT_DIR, else the current directory. */
  projectDir?: string;
  /** Managed settings file path (tests). */
  managedSettings?: string;
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
 * Flags that make the nested call safe on untrusted repo code: no tools, no
 * user or project settings (which could grant permissions), no MCP servers.
 * These fail closed: a CLI that rejects one is too old to use.
 */
export const REQUIRED_FLAGS: readonly (readonly string[])[] = [
  ['--tools', ''],
  ['--setting-sources', ''],
  ['--strict-mcp-config'],
];

/**
 * Flags that keep the call small: no CLAUDE.md, plugins, hooks or skills, no
 * saved session, no extended thinking. If an older CLI rejects one, it is
 * dropped and the call retried.
 */
const OPTIONAL_FLAGS: readonly (readonly string[])[] = [
  ['--safe-mode'],
  ['--disable-slash-commands'],
  ['--no-session-persistence'],
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
  readonly capabilities: BackendCapabilities = { hasLogprobs: false, batch: true, generate: true };
  readonly samples: number;
  private readonly timeoutMs: number;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly run: ProcessRunner;
  private readonly dropped = new Set<string>();
  private readonly fixed: ModelChoice | undefined;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly projectDir: string | undefined;
  private readonly managedSettings: string | undefined;
  private last: ModelChoice | undefined;

  constructor(opts: ClaudeCliOptions = {}) {
    const env = opts.env ?? process.env;
    this.fixed = opts.model !== undefined ? { model: checkModelId(opts.model), source: 'the model option' } : undefined;
    this.parentEnv = env;
    this.projectDir = opts.projectDir;
    this.managedSettings = opts.managedSettings;
    this.samples = opts.samples ?? resolveSamples(env);
    this.timeoutMs = opts.timeoutMs ?? resolveTimeoutMs(env);
    this.bin = opts.bin ?? env.GLASSBOX_CLAUDE_BIN ?? 'claude';
    this.env = cliChildEnv(env);
    // Run outside the project so nothing project-local is picked up.
    this.cwd = opts.cwd ?? tmpdir();
    this.run = opts.run ?? runProcess;
  }

  /**
   * The model for the next call and where it came from, resolved fresh each
   * time: a /model switch or a settings edit applies to the next call.
   */
  modelChoice(): ModelChoice {
    if (this.fixed) return this.fixed;
    const c = resolveClaudeModel({
      env: this.parentEnv,
      ...(this.projectDir !== undefined ? { projectDir: this.projectDir } : {}),
      ...(this.managedSettings !== undefined ? { managedSettings: this.managedSettings } : {}),
    });
    if (c.model !== undefined) checkModelId(c.model);
    return c;
  }

  /** Model of the last call (or the one the next call would use); undefined means Claude Code's own default. */
  get model(): string | undefined {
    return (this.last ?? this.modelChoice()).model;
  }

  /** Where the model came from, e.g. "opus[1m] from ~/.claude/settings.json". */
  get modelSource(): string {
    return describeChoice(this.last ?? this.modelChoice());
  }

  /** Argument list for one call (exported for tests and debugging). No --model when nothing resolves. */
  args(schema?: Record<string, unknown>, choice: ModelChoice = this.modelChoice()): string[] {
    const args = ['-p'];
    if (choice.model !== undefined) args.push('--model', choice.model);
    args.push('--output-format', 'json');
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    for (const group of REQUIRED_FLAGS) args.push(...group);
    for (const group of OPTIONAL_FLAGS) if (!this.dropped.has(group[0]!)) args.push(...group);
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
    const choice = this.modelChoice();
    this.last = choice;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.run(this.bin, this.args(schema, choice), {
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
      if (flag && REQUIRED_FLAGS.some((g) => g[0] === flag)) {
        throw new CliCallError(
          `this Claude Code does not support ${flag}, which glassbox needs to run the model without tools. Update Claude Code (claude update) and retry.`,
          res.stderr,
        );
      }
      if (flag && attempt < OPTIONAL_FLAGS.length && OPTIONAL_FLAGS.some((g) => g[0] === flag) && !this.dropped.has(flag)) {
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
