import { realpathSync } from 'node:fs';
import { delimiter, isAbsolute, relative, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ask, makeQuestion } from '../ask.js';
import { createBackend, type BackendConfig } from '../backends/index.js';
import { MODEL_ID } from '../backends/process.js';
import { parseReasons } from '../explain/reasons.js';
import { refresh, renderRefresh } from '../memory/refresh.js';
import { indexRepo } from '../memory/source.js';
import type { GraphStore } from '../memory/store.js';
import { nodeTagLabels } from '../memory/tags.js';
import { decide } from '../query/decide.js';
import { explainDecision } from '../query/explain.js';
import { renderDecide, renderExplained, renderGraph, renderTriage, renderWhere } from '../query/render.js';
import { triage } from '../query/triage.js';
import { where } from '../query/where.js';
import { renderJson, renderPretty } from '../render.js';
import type { Backend, Calibrator } from '../types.js';
import { loadCalibrators } from '../calibrate/store.js';
import { packageVersion } from '../util/build.js';
import { workingDiff } from '../util/git.js';
import { defaultRoot, withPluginOptions } from './env.js';

export interface GlassboxMcpOptions {
  /**
   * Default: GLASSBOX_ROOT, CLAUDE_PROJECT_DIR, else cwd. A tool call's `root`
   * must stay inside it, or inside a directory listed in GLASSBOX_ALLOWED_ROOTS.
   */
  root?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test hook: extra backend config (for example the fake backend's rules). */
  backendConfig?: BackendConfig;
}

function version(): string {
  return packageVersion();
}

const INSTRUCTIONS = [
  'glassbox answers typed questions about this codebase with a probability (p), a confidence and a band.',
  'Band act: go ahead. confirm: check the highlights first. escalate: do not rely on it; read the code or ask the user.',
  'Use where to find code for a concept, triage to rate the risk of a diff, decide for your own A-or-B choices,',
  'ask for yes/no, choice or score questions over files, a diff or graph nodes, and explain for evidence on an earlier id.',
  'Calls take seconds (they run the host agent\'s own model), so batch what you need and prefer the graph tools.',
].join(' ');

const root = z
  .string()
  .optional()
  .describe('Repo root inside the project directory (or GLASSBOX_ALLOWED_ROOTS). Default: the project directory.');

/** Real path when it exists (symlinks resolved), else the resolved path. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolves a tool call's `root`. Tool arguments come from the agent, which may
 * be steered by text in the code it reads, so a root outside the project is
 * refused unless the user allowed it in GLASSBOX_ALLOWED_ROOTS.
 */
export function makeRootResolver(baseRoot: string, env: NodeJS.ProcessEnv): (r?: string) => string {
  const allowed = [baseRoot, ...(env.GLASSBOX_ALLOWED_ROOTS ?? '').split(delimiter).map((s) => s.trim()).filter(Boolean)].map((d) =>
    real(resolve(baseRoot, d)),
  );
  return (r) => {
    if (!r) return baseRoot;
    const dir = real(resolve(baseRoot, r));
    if (!allowed.some((a) => within(a, dir))) {
      throw new Error(`root ${r} is outside the project directory; add it to GLASSBOX_ALLOWED_ROOTS to allow it`);
    }
    return dir;
  };
}
/** Upper bounds on numeric arguments, so a steered agent cannot ask for unbounded model calls. */
export const MAX_BUDGET = 64;
export const MAX_TOP = 50;
export const MAX_LIMIT = 500;
const budgetArg = (what: string) => z.number().int().min(0).max(MAX_BUDGET).optional().describe(what);

/** Tools that only read the repo (they may write glassbox's own cache and decision log under .glassbox/). */
const READ_ONLY = { readOnlyHint: true } as const;

const format = z.enum(['text', 'json']).optional().describe('text (default, compact) or json (full result).');
const backendArgs = {
  backend: z
    .enum(['auto', 'claude-cli', 'codex-cli', 'anthropic', 'openai-compat'])
    .optional()
    .describe('Override the backend. Default: GLASSBOX_BACKEND or auto (the host agent\'s own CLI).'),
  model: z
    .string()
    .regex(MODEL_ID, 'a model id: letters, digits and . _ : / @ -')
    .optional()
    .describe('Override the model id. Default: GLASSBOX_MODEL or the backend default.'),
};

function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

function failure(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `glassbox: ${err instanceof Error ? err.message : String(err)}` }] };
}

/** Fitted calibrators from .glassbox/calibration.json for this backend, as decide options. */
async function calibrated(root: string, backend: Backend): Promise<{ decide?: { calibrators: Record<string, Calibrator> } }> {
  const calibrators = await loadCalibrators(root, backend);
  return Object.keys(calibrators).length ? { decide: { calibrators } } : {};
}

/** Builds the glassbox MCP server with its seven tools. Connect it to any transport. */
export function createGlassboxServer(opts: GlassboxMcpOptions = {}): McpServer {
  const env = withPluginOptions(opts.env ?? process.env);
  const cwd = opts.cwd ?? process.cwd();
  const baseRoot = resolve(cwd, opts.root ?? defaultRoot(env, cwd));
  const rootOf = makeRootResolver(baseRoot, env);
  const backendOf = (a: { backend?: string | undefined; model?: string | undefined }): Backend =>
    createBackend({
      env,
      ...(a.backend ? { backend: a.backend as NonNullable<BackendConfig['backend']> } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...opts.backendConfig,
    });

  /** Opens the graph store, building the graph (no tags, no model calls) when it is empty. */
  async function withGraph<T>(dir: string, fn: (store: GraphStore) => Promise<T>): Promise<T> {
    const { GraphStore } = await import('../memory/store.js');
    const store = GraphStore.open(dir);
    try {
      if (store.getNodes({ kind: 'file' }).length === 0) await indexRepo(dir, store);
      return await fn(store);
    } finally {
      store.close();
    }
  }

  const run = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (err) {
      return failure(err);
    }
  };

  const server = new McpServer({ name: 'glassbox', version: version() }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'ask',
    {
      title: 'Ask a typed question about code',
      description:
        'Answer a yes/no, choice or score question about files, a unified diff or graph nodes. Returns the answer with p, ' +
        'confidence and band (act, confirm, escalate). With explain, adds highlighted file:line spans with the probability ' +
        'drop when each is hidden (delta p), reason codes and a pseudo-code summary. Default scope: the whole repo.',
      inputSchema: {
        question: z.string().min(1).describe('The question, e.g. "does this change auth behavior?"'),
        type: z.enum(['yesno', 'choice', 'score']).optional().describe('Default yesno.'),
        options: z
          .array(z.string())
          .optional()
          .describe('choice: "key" or "key=description"; score: levels lowest first (default none, low, medium, high).'),
        paths: z.array(z.string()).optional().describe('Files or directories, relative to the root.'),
        diff: z.string().optional().describe('Unified diff text to ask about.'),
        nodes: z.array(z.string()).optional().describe('Graph node ids, e.g. src/auth/session.ts#verifySession.'),
        explain: z.boolean().optional().describe('Add evidence by hiding spans and re-asking. Costs more calls.'),
        budget: budgetArg(`Most backend calls the explanation may spend (default 24, at most ${MAX_BUDGET}).`),
        why: z.boolean().optional().describe('true: always add a one-line why; false: never. Default: only below the act band.'),
        reasons: z.array(z.string()).optional().describe('Reason codes to check: "code" or "code=question".'),
        root,
        format,
        ...backendArgs,
      },
      annotations: READ_ONLY,
    },
    (a) =>
      run(async () => {
        const scope: { paths?: string[]; diff?: string; nodes?: string[] } = {};
        if (a.paths?.length) scope.paths = a.paths;
        if (a.diff !== undefined) scope.diff = a.diff;
        if (a.nodes?.length) scope.nodes = a.nodes;
        if (!scope.paths && !scope.nodes && scope.diff === undefined) scope.paths = ['.'];
        const backend = backendOf(a);
        const dir = rootOf(a.root);
        const r = await ask(scope, makeQuestion(a.question, a.type ?? 'yesno', a.options ?? []), {
          backend,
          root: dir,
          ...(await calibrated(dir, backend)),
          explain: a.explain ? (a.budget !== undefined ? { budget: a.budget } : true) : false,
          ...(a.why !== undefined ? { why: a.why } : {}),
          ...(a.reasons?.length ? { reasons: parseReasons(a.reasons) } : {}),
        });
        return text(a.format === 'json' ? renderJson(r) : renderPretty(r));
      }),
  );

  server.registerTool(
    'where',
    {
      title: 'Find where a concept lives',
      description:
        'Rank the functions and classes most likely to implement a concept, e.g. "where are billing retries?". ' +
        'Uses the code graph and stored tags to pick candidates, then one batched model call. Returns p per hit.',
      inputSchema: {
        concept: z.string().min(1).describe('What to look for.'),
        top: z.number().int().min(1).max(MAX_TOP).optional().describe(`Hits to return (default 5, at most ${MAX_TOP}).`),
        candidates: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOP)
          .optional()
          .describe(`Prefiltered nodes the model checks (default 8, at most ${MAX_TOP}).`),
        root,
        format,
        ...backendArgs,
      },
      annotations: READ_ONLY,
    },
    (a) =>
      run(async () => {
        const dir = rootOf(a.root);
        const backend = backendOf(a);
        const cal = await calibrated(dir, backend);
        const r = await withGraph(dir, (store) =>
          where(a.concept, {
            store,
            root: dir,
            backend,
            ...cal,
            ...(a.top !== undefined ? { top: a.top } : {}),
            ...(a.candidates !== undefined ? { candidates: a.candidates } : {}),
          }),
        );
        return a.format === 'json' ? json(r) : text(renderWhere(r));
      }),
  );

  server.registerTool(
    'triage',
    {
      title: 'Rate the risk of a diff',
      description:
        'Score the risk (Low, Medium, High) of a diff overall and per hunk, list the callers and importers it affects ' +
        '(one hop in the graph), and back the overall answer with highlights. Default diff: uncommitted changes (git diff HEAD ' +
          'plus new files), without secret-looking files and without glassbox\'s own AGENTS.md block or CLAUDE.md import.',
      inputSchema: {
        diff: z.string().optional().describe('Unified diff text. Default: git diff HEAD in the root.'),
        explain: z.boolean().optional().describe('Hide-and-re-ask evidence on the overall risk (default true).'),
        budget: budgetArg(`Most backend calls the evidence may spend (default 12, at most ${MAX_BUDGET}).`),
        root,
        format,
        ...backendArgs,
      },
      annotations: READ_ONLY,
    },
    (a) =>
      run(async () => {
        const dir = rootOf(a.root);
        const diff = a.diff ?? (await workingDiff(dir));
        if (!diff.trim()) return text('no changes to triage');
        const backend = backendOf(a);
        const cal = await calibrated(dir, backend);
        const r = await withGraph(dir, (store) =>
          triage(diff, {
            store,
            root: dir,
            backend,
            ...cal,
            explain: a.explain === false ? false : a.budget !== undefined ? { budget: a.budget } : true,
          }),
        );
        if (a.format !== 'json') return text(renderTriage(r));
        const { record, hunks, ...rest } = r;
        return json({ ...rest, id: record.id, hunks: hunks.map(({ answer: _a, ...h }) => h) });
      }),
  );

  server.registerTool(
    'decide',
    {
      title: 'Advise on an A-or-B choice',
      description:
        'Answer your own "A or B?" question with probabilities per option, using related graph nodes and their tags as ' +
        'context. Advisory only: it changes nothing, and you or the user still decide.',
      inputSchema: {
        question: z.string().min(1).describe('The question, e.g. "where should the retry limit live?"'),
        options: z.array(z.string()).min(2).describe('At least two options: "key" or "key=description".'),
        context: z.string().optional().describe('Extra context you already know (constraints, what the user asked).'),
        root,
        format,
        ...backendArgs,
      },
      annotations: READ_ONLY,
    },
    (a) =>
      run(async () => {
        const dir = rootOf(a.root);
        const backend = backendOf(a);
        const cal = await calibrated(dir, backend);
        const r = await withGraph(dir, (store) => decide(a.question, a.options, a.context, { store, root: dir, backend, ...cal }));
        if (a.format !== 'json') return text(renderDecide(r));
        const { record, ...rest } = r;
        return json({ ...rest, id: record.id });
      }),
  );

  server.registerTool(
    'explain',
    {
      title: 'Explain an earlier decision',
      description:
        'Show or add evidence (highlights with delta p), reason codes and a pseudo-code summary for a decision id printed ' +
        'by ask, triage or decide. Returns the stored explanation without new calls when there is one.',
      inputSchema: {
        id: z.string().min(4).describe('The decision id (a unique prefix of at least 4 characters works).'),
        refresh: z.boolean().optional().describe('Re-run the evidence pass even when one is stored.'),
        budget: budgetArg(`Most backend calls the evidence may spend (at most ${MAX_BUDGET}).`),
        diff: z
          .string()
          .optional()
          .describe('For a decision about a diff: the same diff again (the log keeps only its hash). Default: git diff HEAD.'),
        root,
        format,
        ...backendArgs,
      },
      annotations: READ_ONLY,
    },
    (a) =>
      run(async () => {
        const dir = rootOf(a.root);
        const { GraphStore } = await import('../memory/store.js');
        let store: GraphStore | undefined;
        try {
          const r = await explainDecision(a.id, {
            root: dir,
            backend: () => backendOf(a),
            store: () => (store ??= GraphStore.open(dir)),
            diff: async () => a.diff ?? (await workingDiff(dir)),
            ...(a.refresh ? { refresh: true } : {}),
            ...(a.budget !== undefined ? { budget: a.budget } : {}),
          });
          return a.format === 'json' ? json(r) : text(renderExplained(r));
        } finally {
          store?.close();
        }
      }),
  );

  server.registerTool(
    'graph',
    {
      title: 'Show a node and its neighbours',
      description:
        'Return a graph node (function, class or file) with its stored tags (handles_auth, side_effects, risk, area, ...) ' +
        'and its incoming and outgoing call and import edges. No model calls.',
      inputSchema: {
        node: z.string().min(1).describe('Node id (src/auth/session.ts#verifySession) or a unique name.'),
        root,
        format,
      },
      annotations: READ_ONLY,
    },
    (a) =>
      run(async () =>
        withGraph(rootOf(a.root), async (store) => {
          const exact = store.getNode(a.node);
          const matches = exact
            ? [exact]
            : store.getNodes().filter((n) => n.name === a.node || n.name.endsWith(`.${a.node}`) || n.id.endsWith(`#${a.node}`));
          const node = matches.length === 1 ? matches[0] : undefined;
          if (!node) {
            return failure(
              matches.length
                ? `"${a.node}" matches ${matches.length} nodes: ${matches.slice(0, 8).map((n) => n.id).join(', ')}`
                : `no node "${a.node}"`,
            );
          }
          const view = { node, tags: nodeTagLabels(store, node.id), out: store.edgesFrom(node.id), in: store.edgesTo(node.id) };
          return a.format === 'json' ? json({ ...view, tags: store.getTags(node.id) }) : text(renderGraph(view));
        }),
      ),
  );

  server.registerTool(
    'refresh',
    {
      title: 'Refresh the code graph',
      description:
        'With files: mark those files\' nodes (and their direct dependents) stale, fast and without model calls. Without: ' +
        're-parse changed files, optionally re-tag stale nodes (tags: true, costs model calls) and rewrite the AGENTS.md block. ' +
        'Does nothing in a repo without a glassbox graph (run `glassbox init` first).',
      inputSchema: {
        files: z.array(z.string()).optional().describe('Changed files, relative to the root or absolute.'),
        tags: z.boolean().optional().describe('Re-ask tags for stale nodes (model calls).'),
        limit: z
          .number()
          .int()
          .min(0)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Most nodes re-tagged now (at most ${MAX_LIMIT}); the rest stay stale.`),
        syncMd: z.boolean().optional().describe('Rewrite the AGENTS.md block afterwards.'),
        root,
        format,
        ...backendArgs,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (a) =>
      run(async () => {
        const r = await refresh(rootOf(a.root), {
          ...(a.files ? { files: a.files } : {}),
          ...(a.tags ? { tags: true, backend: () => backendOf(a) } : {}),
          ...(a.limit !== undefined ? { limit: a.limit } : {}),
          // An agent-triggered refresh never creates CLAUDE.md; only `glassbox init` does.
          ...(a.syncMd ? { syncMd: { claudeMd: false } } : {}),
        });
        return a.format === 'json' ? json(r) : text(renderRefresh(r));
      }),
  );

  return server;
}

/** Serves glassbox over stdio until the client disconnects (`glassbox mcp`). */
export async function runStdioServer(opts: GlassboxMcpOptions = {}): Promise<void> {
  const server = createGlassboxServer(opts);
  const closed = new Promise<void>((done) => {
    server.server.onclose = () => done();
    process.stdin.once('end', () => done());
  });
  await server.connect(new StdioServerTransport());
  await closed;
  await server.close();
}
