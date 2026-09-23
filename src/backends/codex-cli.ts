import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export interface CodexCliOptions {
  /** Model id passed with -m. Default: none, so Codex uses its configured model. */
  model?: string;
  /** Reasoning effort override. Default GLASSBOX_CODEX_EFFORT or 'low' (these are quick judgments). */
  reasoningEffort?: string;
  samples?: number;
  timeoutMs?: number;
  /** Binary name or path. Default GLASSBOX_CODEX_BIN or 'codex'. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  run?: ProcessRunner;
}

const INSTALL_HINT =
  'Install the Codex CLI (https://developers.openai.com/codex) and run `codex login`, or pick another backend with GLASSBOX_BACKEND.';

/** Codex features turned off in the nested run so it has no shell or other tools. */
export const NO_TOOL_FEATURES: readonly string[] = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'hooks',
  'multi_agent',
  'browser_use',
  'computer_use',
  'image_generation',
  'code_mode_host',
];

/** Longest free-text reply kept from generate (why lines and summaries are short). */
export const MAX_GENERATE_CHARS = 2000;

/** Optional flags; dropped and retried if an older CLI rejects them. */
const OPTIONAL_FLAGS: readonly (readonly string[])[] = [['--ephemeral']];

/** Runs on the Codex login via `codex exec` (no API key needed). Default inside Codex. */
export class CodexCliBackend implements Backend {
  readonly name = 'codex-cli';
  readonly model: string | undefined;
  readonly capabilities: BackendCapabilities = { hasLogprobs: false, batch: true, generate: true };
  readonly samples: number;
  private readonly effort: string;
  private readonly timeoutMs: number;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: ProcessRunner;
  private readonly dropped = new Set<string>();

  constructor(opts: CodexCliOptions = {}) {
    const env = opts.env ?? process.env;
    this.model = opts.model === undefined ? undefined : checkModelId(opts.model);
    this.effort = opts.reasoningEffort ?? env.GLASSBOX_CODEX_EFFORT ?? 'low';
    this.samples = opts.samples ?? resolveSamples(env);
    this.timeoutMs = opts.timeoutMs ?? resolveTimeoutMs(env);
    this.bin = opts.bin ?? env.GLASSBOX_CODEX_BIN ?? 'codex';
    this.env = cliChildEnv(env);
    this.run = opts.run ?? runProcess;
  }

  /** Argument list for one call in `dir`; the prompt is read from stdin ("-"). */
  args(dir: string, schemaFile: string | undefined, outFile: string): string[] {
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', dir, '-o', outFile];
    if (schemaFile) args.push('--output-schema', schemaFile);
    if (this.model) args.push('-m', this.model);
    // Keep the nested run lean: low effort, no user MCP servers, notify hooks or AGENTS.md.
    args.push(
      '-c', `model_reasoning_effort=${JSON.stringify(this.effort)}`,
      '-c', 'mcp_servers={}',
      '-c', 'notify=[]',
      '-c', 'project_doc_max_bytes=0',
      // No web search either: injected repo text could use it to send code out.
      '-c', 'web_search="disabled"',
    );
    // No tools: the prompt holds untrusted repo code, so the nested agent gets no shell to act on it.
    for (const feature of NO_TOOL_FEATURES) args.push('-c', `features.${feature}=false`);
    for (const group of OPTIONAL_FLAGS) if (!this.dropped.has(group[0]!)) args.push(...group);
    args.push('-');
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
      const text = await this.call(req.prompt, req.schema, opts?.signal);
      return parseBatchAnswer(text, req);
    });
    const byId = Object.fromEntries(Object.entries(req.keys).map(([k, id]) => [id, req.labels[k]!]));
    return averageSamples(samples, byId);
  }

  async generate(prompt: string, opts?: GenerateOptions): Promise<string> {
    return (await this.call(prompt, undefined, opts?.signal)).trim().slice(0, MAX_GENERATE_CHARS);
  }

  /** One `codex exec` run in a fresh temp dir; returns the last agent message. */
  private async call(prompt: string, schema: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'glassbox-codex-'));
    try {
      const schemaFile = schema ? join(dir, 'schema.json') : undefined;
      const outFile = join(dir, 'last-message.txt');
      if (schemaFile) await writeFile(schemaFile, JSON.stringify(schema));
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await this.run(this.bin, this.args(dir, schemaFile, outFile), {
            input: prompt,
            env: this.env,
            cwd: dir,
            timeoutMs: this.timeoutMs,
            ...(signal ? { signal } : {}),
          });
        } catch (e) {
          if (isNotFound(e)) throw new CliNotFoundError(this.bin, INSTALL_HINT);
          throw e;
        }
        if (res.code !== 0) {
          const flag = unknownFlag(res.stderr);
          if (flag && attempt < OPTIONAL_FLAGS.length && OPTIONAL_FLAGS.some((g) => g[0] === flag) && !this.dropped.has(flag)) {
            this.dropped.add(flag);
            continue;
          }
          const detail = tail(res.stderr) || tail(res.stdout);
          if (/log ?in|logged in|authenticat|unauthori[sz]ed|api key|401/i.test(detail)) {
            throw new CliCallError(`codex is not logged in. Run \`codex login\`, then retry.\n${detail}`, res.stderr);
          }
          throw new CliCallError(`codex exec failed (exit ${res.code ?? 'signal'}): ${detail || 'no output'}`, res.stderr);
        }
        const text = await readFile(outFile, 'utf8').catch(() => res.stdout);
        if (!text.trim()) throw new CliCallError('codex exec returned an empty message', res.stderr);
        return text;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export function createCodexCliBackend(opts?: CodexCliOptions): CodexCliBackend {
  return new CodexCliBackend(opts);
}
