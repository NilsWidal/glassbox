import { buildBatchRequest, parseBatchAnswer } from '../engine/prompt.js';
import type { Backend, BackendCapabilities, BatchQuestion, GenerateOptions, LabelDistribution, State } from '../types.js';
import { averageSamples, resolveSamples, resolveTimeoutMs, runSamples } from './sampling.js';
import { resolveAnthropicModel } from '../model-choice.js';

/**
 * The slice of the @anthropic-ai/sdk client we call. The SDK is an optional
 * extra (not a dependency), so it is typed structurally and loaded on demand.
 */
export interface AnthropicClientLike {
  messages: {
    create(
      body: Record<string, unknown>,
      opts?: { signal?: AbortSignal; timeout?: number },
    ): Promise<{ content: Array<{ type: string; text?: string }>; stop_reason?: string | null }>;
  };
}

export interface AnthropicOptions {
  /**
   * Default: GLASSBOX_MODEL, else ANTHROPIC_MODEL or the Claude Code settings
   * model when it is a full API id. glassbox has no model default of its own,
   * so with none of these the backend throws and asks for GLASSBOX_MODEL.
   * See resolveAnthropicModel.
   */
  model?: string;
  /** Project whose Claude Code settings may name the model. Default CLAUDE_PROJECT_DIR, else the current directory. */
  projectDir?: string;
  apiKey?: string;
  samples?: number;
  timeoutMs?: number;
  maxTokens?: number;
  env?: NodeJS.ProcessEnv;
  /** Injected client (tests, or a custom configured SDK client). */
  client?: AnthropicClientLike;
}

const SDK = '@anthropic-ai/sdk';

/** Retries the SDK makes on 429, 5xx and connection errors; each is a paid request. */
const SDK_MAX_RETRIES = 3;

async function loadClient(apiKey: string | undefined, timeoutMs: number, onRequest: () => void): Promise<AnthropicClientLike> {
  let mod: { default: new (opts: Record<string, unknown>) => AnthropicClientLike };
  try {
    // A variable specifier keeps the optional SDK out of type resolution.
    const spec: string = SDK;
    mod = (await import(spec)) as typeof mod;
  } catch {
    throw new Error(`the anthropic backend needs the optional package ${SDK}: npm install ${SDK}`);
  }
  // Every request the SDK sends, retries included, goes through this fetch, so it can be counted.
  const counting: typeof fetch = (input, init) => {
    onRequest();
    return fetch(input, init);
  };
  return new mod.default({ ...(apiKey ? { apiKey } : {}), timeout: timeoutMs, maxRetries: SDK_MAX_RETRIES, fetch: counting });
}

/**
 * Splits the batch prompt after the state so the fixed header plus state form
 * a cacheable prefix shared by every call (and every sample) about that state.
 */
export function splitForCache(prompt: string): [string, string] {
  const marker = '</state>\n';
  const i = prompt.indexOf(marker);
  if (i < 0) return [prompt, ''];
  return [prompt.slice(0, i + marker.length), prompt.slice(i + marker.length)];
}

/** Optional API backend for CI or headless use. Structured output, K samples, cached state prefix. */
export class AnthropicBackend implements Backend {
  readonly name = 'anthropic';
  readonly model: string;
  readonly modelSource: string;
  readonly capabilities: BackendCapabilities = { hasLogprobs: false, batch: true, generate: true };
  readonly samples: number;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly apiKey: string | undefined;
  private client: AnthropicClientLike | undefined;
  /** Requests counted through the SDK's fetch; undefined with an injected client, which glassbox cannot see into. */
  private sent: number | undefined;
  /** One request plus the SDK's retries. */
  readonly maxRequestsPerCall = SDK_MAX_RETRIES + 1;

  /** Requests sent so far, retries included, when glassbox made the SDK client. */
  get requestCount(): number | undefined {
    return this.sent;
  }

  constructor(opts: AnthropicOptions = {}) {
    const env = opts.env ?? process.env;
    if (opts.model !== undefined) {
      this.model = opts.model;
      this.modelSource = `${opts.model} from the model option`;
    } else {
      const c = resolveAnthropicModel({ env, ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}) });
      this.model = c.model;
      this.modelSource = `${c.model} from ${c.source}`;
    }
    this.samples = opts.samples ?? resolveSamples(env);
    this.timeoutMs = opts.timeoutMs ?? resolveTimeoutMs(env);
    this.maxTokens = opts.maxTokens ?? 2048;
    this.apiKey = opts.apiKey ?? env.GLASSBOX_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY;
    this.client = opts.client;
    if (!opts.client) this.sent = 0;
  }

  private async getClient(): Promise<AnthropicClientLike> {
    this.client ??= await loadClient(this.apiKey, this.timeoutMs, () => {
      this.sent = (this.sent ?? 0) + 1;
    });
    return this.client;
  }

  /** Request body for one batch (no assistant prefill; the schema shapes the answer). */
  body(prompt: string, schema: Record<string, unknown>): Record<string, unknown> {
    const [prefix, rest] = splitForCache(prompt);
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }];
    if (rest) content.push({ type: 'text', text: rest });
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema } },
    };
  }

  async answerBatch(
    state: State,
    questions: Record<string, BatchQuestion>,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, LabelDistribution>> {
    if (Object.keys(questions).length === 0) return {};
    const req = buildBatchRequest(state, questions);
    const client = await this.getClient();
    const body = this.body(req.prompt, req.schema);
    const samples = await runSamples(this.samples, async () => {
      const msg = await client.messages.create(body, opts?.signal ? { signal: opts.signal } : undefined);
      if (msg.stop_reason === 'refusal') throw new Error('anthropic: the model refused this request');
      if (msg.stop_reason === 'max_tokens') throw new Error('anthropic: answer cut off at max_tokens');
      return parseBatchAnswer(textOf(msg.content), req);
    });
    const byId = Object.fromEntries(Object.entries(req.keys).map(([k, id]) => [id, req.labels[k]!]));
    return averageSamples(samples, byId);
  }

  async generate(prompt: string, opts?: GenerateOptions): Promise<string> {
    const client = await this.getClient();
    const msg = await client.messages.create(
      { model: this.model, max_tokens: opts?.maxTokens ?? 256, messages: [{ role: 'user', content: prompt }] },
      opts?.signal ? { signal: opts.signal } : undefined,
    );
    return textOf(msg.content).trim();
  }
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

export function createAnthropicBackend(opts?: AnthropicOptions): AnthropicBackend {
  return new AnthropicBackend(opts);
}
