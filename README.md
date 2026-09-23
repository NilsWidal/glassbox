# glassbox

Fast typed decisions about code, with probabilities, confidence and checked reasons. Built for Claude Code and Codex.

> Status: early development (v0.1 in progress). The decision engine, host CLI backends, explanations, memory graph, MCP server and Claude Code plugin work. The npm package is not published yet, so until it is, install from a clone (see the docs linked below).

## What it does

You ask a typed question about some code. glassbox answers with a probability and a confidence value instead of free text:

- `yesno`: `{ p }`, the probability the answer is yes. The readable output prints the probability of the answer it shows, so `NO  p=0.97` means P(yes) = 0.03.
- `choice`: `{ choice, probabilities, confidence }`.
- `score`: `{ score, legend, probabilities, confidence }`, where `score` is the probability-weighted expected level.

Every answer also carries a band: `act`, `confirm` or `escalate`.

## No extra keys or models

glassbox runs on the model of the agent you are already using, through that agent's own CLI:

| Where you run it | Backend | How it calls the model |
|---|---|---|
| Claude Code | `claude-cli` | `claude -p ... --json-schema ...` (default model `haiku`) |
| Codex | `codex-cli` | `codex exec --output-schema ...` (uses your Codex default model) |

`auto` (the default) picks the backend from the host agent. Your existing Claude or ChatGPT login is used. Optional API backends (`anthropic`, `openai-compat`) exist for CI and headless use.

Configuration:

| Variable | Meaning |
|---|---|
| `GLASSBOX_BACKEND` | `auto`, `claude-cli`, `codex-cli`, `anthropic`, `openai-compat` |
| `GLASSBOX_MODEL` | Model id for the chosen backend |
| `GLASSBOX_HOST` | `claude-code` or `codex`: which agent started the MCP server, so `auto` picks its CLI (set by the plugin and the Codex setup) |
| `GLASSBOX_ROOT` | Repo the MCP server works on (default: the project directory, else the current directory) |
| `GLASSBOX_ALLOWED_ROOTS` | Extra directories (separated by `:`, or `;` on Windows) that an MCP tool call's `root` may point at. By default a tool call can only use the project directory and folders inside it |
| `GLASSBOX_HOOKS` | `1` turns the Claude Code plugin hooks on, `0` off |
| `GLASSBOX_SAMPLES` | Samples averaged per call on the CLI and Anthropic backends (1 to 16, default 3) |
| `GLASSBOX_TIMEOUT_MS` | Timeout per model call in milliseconds (default 120000) |
| `GLASSBOX_CODEX_EFFORT` | Reasoning effort for `codex-cli` (default `low`, since these are quick judgments) |
| `GLASSBOX_CLAUDE_BIN`, `GLASSBOX_CODEX_BIN` | Path to the `claude` or `codex` binary (default: found on PATH) |
| `ANTHROPIC_API_KEY` or `GLASSBOX_ANTHROPIC_API_KEY` | Only for the optional `anthropic` backend. The plugin stores its key as `GLASSBOX_ANTHROPIC_API_KEY`, which is never passed to the nested `claude -p`, so that call keeps using your Claude Code login |
| `GLASSBOX_OPENAI_API_KEY` or `OPENAI_API_KEY` | Only for the optional `openai-compat` backend |
| `GLASSBOX_OPENAI_BASE_URL` or `OPENAI_BASE_URL` | Base URL for `openai-compat` (default `https://api.openai.com/v1`) |

The nested `codex exec` call runs with a read-only sandbox, in an empty temp directory, with its shell and other tools turned off. The nested `claude -p` call runs with no tools.

## Install

### Claude Code

```
/plugin marketplace add NilsWidal/glassbox
/plugin install glassbox@glassbox
```

> Until the npm package is published, the plugin's MCP server cannot start (it runs `npx -y @nilswidal/glassbox`). For now, follow [Run from a clone](docs/claude-code.md#run-from-a-clone).

The plugin adds the MCP tools, a skill that teaches Claude when to use them, and opt-in hooks that keep the graph fresh as you edit. The backend defaults to `auto` (your Claude Code login), and API keys are optional fields stored in your keychain. Details: [docs/claude-code.md](docs/claude-code.md).

### Codex

```sh
codex mcp add glassbox --env GLASSBOX_HOST=codex -- npx -y @nilswidal/glassbox@0.1.0 mcp
npx skills add NilsWidal/glassbox
```

Inside Codex, glassbox asks the model through `codex exec`, with your Codex login. Details, including a `config.toml` snippet: [docs/codex.md](docs/codex.md).

### Then, in your repository

```sh
npx -y @nilswidal/glassbox init
```

This builds the code graph and its tags in `.glassbox/` (which gets its own `.gitignore`, since the decision log can hold diff text), and writes a short managed block into `AGENTS.md`. It also adds an `@AGENTS.md` import to `CLAUDE.md`, so both agents read the same summary.

### MCP tools

| Tool | What it does |
|---|---|
| `ask` | Answers a yes/no, choice or score question about files, a diff or graph nodes, with optional evidence. |
| `where` | Ranks the code most likely to implement a concept. |
| `triage` | Scores the risk of a diff per hunk and lists the callers it affects. |
| `decide` | Advises on the agent's own "A or B?" question, with probabilities. |
| `explain` | Adds evidence and reasons to an earlier decision. |
| `graph` | Shows a node's stored tags and neighbours. |
| `refresh` | Marks edited files stale, or re-parses changed files. |

The same commands exist on the CLI (`glassbox ask`, `glassbox where`, ...), and `glassbox mcp` starts the server on stdio for any MCP client.

## How the numbers are made

- **One call per state.** Every question about one piece of code goes into a single model call, because host CLI calls take seconds.
- **Calls and model runs.** Each call is asked in 2 option orders by default, and the host CLI backends average K=3 samples per call (`GLASSBOX_SAMPLES`), each one a separate `claude -p` or `codex exec` process. So one plain `ask` starts 6 processes in parallel. The cost line shows both, for example `2 calls (x 3 samples = 6 model runs)`.
- **Option shuffling.** Options get single-letter labels (A, B, C, ...). The engine asks again with the options in a different order (in parallel) and averages, which cancels the model's preference for particular positions.
- **Confidence** is `(K * pmax - 1) / (K - 1)`, where K is the number of options: 0 for a uniform answer, 1 when one option has all the probability. This is our own definition.
- **Bands.** By default `act` when confidence is at least 0.85, `confirm` at 0.6 or above, else `escalate`. Each question can set its own thresholds.
- **Calibration.** Every decision is logged to `.glassbox/decisions.jsonl` with an id. Record the true answer with `glassbox label <id> yes` (or a choice key, or a score level), then run `glassbox calibrate` to fit temperature or Platt scaling per question kind, backend and model from those labels (free-form questions are grouped by type and option count, so a yes/no fit is never applied to a 3-way choice). The result goes to `.glassbox/calibration.json`, and later answers from the same backend and model use it, in the CLI and the MCP tools alike. `calibrate --dry-run` shows ECE and Brier before and after without saving. Below a minimum number of labels nothing is fitted, Platt scaling is pulled toward no change, and the "after" numbers are in-sample, so they are optimistic.

Probabilities from the host CLIs are stated by the model, not read from token probabilities, so they are coarser than a dedicated classifier until calibrated.

## Benchmark results so far

Measured with `glassbox bench` on 2026-09-23. Full tables, per-item results and how to run it: [bench/](bench/README.md).

| backend | model | accuracy | ECE | Brier | p50 / p95 per batched decision | faithfulness: deletion / sufficiency / control drop |
|---|---|---|---|---|---|---|
| claude-cli | haiku, 3 samples | 0.987 (74/75) | 0.017 | 0.008 | 12.4 s / 16.6 s | 4/4, 4/4, 0/4 |
| codex-cli | Codex's configured model, effort low, 3 samples | 1.000 (75/75) | 0.002 | 0.000 | 27.2 s / 30.4 s | 4/4, 4/4, 0/4 |

Read these numbers with care:

- **The labels are author-constructed.** The glassbox author wrote all 75 questions (53 yes/no, 12 choice, 10 score) against the small test fixture repo. Nobody else labeled them.
- **The set is nearly saturated.** Both backends get almost everything right with p close to 1, partly because the fixture has short files and hint comments. So these numbers cannot yet tell good calibration from bad.
- **n is small.** One wrong answer moves accuracy by more than a point, and faithfulness ran on only 4 items per backend.
- **Still open:** the planned benchmark of about 200 human-labeled questions over 2 or 3 real open-source repos, and harder items that no comment gives away.

## Library use

```ts
import { decide, FakeBackend } from '@nilswidal/glassbox';

const result = await decide(
  { file: 'src/auth/session.ts', code: '...' },
  {
    auth: { type: 'yesno', instructions: 'Does this code change session handling?' },
    risk: { type: 'score', instructions: 'How risky is this change?', criteria: ['low', 'medium', 'high'] },
  },
  new FakeBackend(), // swap in a real backend
);
console.log(result.answers.auth); // { type: 'yesno', p: ..., confidence: ..., band: ... }
```

## Development

Requires Node 22 or newer.

```sh
npm install
npm test          # unit tests, no network (fake backend)
npm run typecheck
npm run lint
npm run build
```

Live tests against the real `claude` and `codex` CLIs are opt-in: set `GLASSBOX_IT=1`.

## License

MIT, see [LICENSE](LICENSE).
