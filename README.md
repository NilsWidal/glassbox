# glassbox

Fast typed decisions about code, with probabilities, confidence and checked reasons. Built for Claude Code and Codex.

> Status: early development (v0.1 in progress). The decision engine, host CLI backends, explanations, memory graph, MCP server and Claude Code plugin work. The npm package is not published yet, so until it is, install from a clone (see the docs linked below).

## What it does

You ask a typed question about some code. glassbox answers with a probability and a confidence value instead of free text:

- `yesno`: `{ p }`, the probability the answer is yes.
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
| `GLASSBOX_HOOKS` | `1` turns the Claude Code plugin hooks on, `0` off |

## Install

### Claude Code

```
/plugin marketplace add NilsWidal/glassbox
/plugin install glassbox@glassbox
```

The plugin adds the MCP tools, a skill that teaches Claude when to use them, and opt-in hooks that keep the graph fresh as you edit. The backend defaults to `auto` (your Claude Code login), and API keys are optional fields stored in your keychain. Details: [docs/claude-code.md](docs/claude-code.md).

### Codex

```sh
codex mcp add glassbox --env GLASSBOX_HOST=codex -- npx -y @nilswidal/glassbox mcp
npx skills add NilsWidal/glassbox
```

Inside Codex, glassbox asks the model through `codex exec`, with your Codex login. Details, including a `config.toml` snippet: [docs/codex.md](docs/codex.md).

### Then, in your repository

```sh
npx -y @nilswidal/glassbox init
```

This builds the code graph and its tags in `.glassbox/` (add it to `.gitignore`), and writes a short managed block into `AGENTS.md`. It also adds an `@AGENTS.md` import to `CLAUDE.md`, so both agents read the same summary.

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
- **Option shuffling.** Options get single-letter labels (A, B, C, ...). The engine asks again with the options in a different order (in parallel) and averages, which cancels the model's preference for particular positions.
- **Confidence** is `(K * pmax - 1) / (K - 1)`, where K is the number of options: 0 for a uniform answer, 1 when one option has all the probability. This is our own definition.
- **Bands.** By default `act` when confidence is at least 0.85, `confirm` at 0.6 or above, else `escalate`. Each question can set its own thresholds.
- **Calibration.** Temperature and Platt scaling can be applied per question. Fitting them from logged decisions (the `calibrate` command) comes later.

Probabilities from the host CLIs are stated by the model, not read from token probabilities, so they are coarser than a dedicated classifier until calibrated.

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
