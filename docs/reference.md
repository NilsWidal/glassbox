# glassbox reference

Everything the [README](../README.md) leaves out: configuration, auto-init rules, MCP tools, modes, ambient mode, the launcher, how the numbers are made, and library use. Written for glassbox 0.3.0.

## Configuration

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
| `GLASSBOX_AUTO_INIT` | `1` or `0`: build the code graph by itself at session start in a git repo without one, and add the session code map (default on; see [Auto-init](#auto-init)) |
| `GLASSBOX_AUTO_INIT_MAX_FILES` | Auto-init skips repos with more supported source files than this (default 5000) |
| `GLASSBOX_MODE` | `fast`, `balanced` (default), `explained`, `strict` or `auto`; see [Modes](#modes) |
| `GLASSBOX_AMBIENT`, `GLASSBOX_GATE`, `GLASSBOX_WORKER` | `1` or `0`: turn the ambient context hook, the end-of-turn gate and the background re-tagging worker on or off (see [Ambient mode](#ambient-mode)) |
| `GLASSBOX_CONCISE_RULES` | `1` or `0`: add the concise answer rules to the AGENTS.md block (see [Concise answers](#concise-answers)) |
| `GLASSBOX_GATE_TIMEOUT_MS` | Longest the end-of-turn gate may take before it lets the turn end (default 45000, at most 50000) |
| `GLASSBOX_WORKER_DAILY_CALLS`, `GLASSBOX_WORKER_MIN_INTERVAL_SEC`, `GLASSBOX_WORKER_MAX_NODES` | Worker limits: model runs per day (default 100, at most 1000), seconds between runs (default 60, at least 10), nodes re-tagged per run (default 24, at most 100) |
| `GLASSBOX_SAMPLES` | Samples averaged per call on the CLI and Anthropic backends (1 to 16, default 3) |
| `GLASSBOX_TIMEOUT_MS` | Timeout per model call in milliseconds (default 120000) |
| `GLASSBOX_CODEX_EFFORT` | Reasoning effort for `codex-cli` (default `low`, since these are quick judgments) |
| `GLASSBOX_CLAUDE_BIN`, `GLASSBOX_CODEX_BIN` | Path to the `claude` or `codex` binary (default: found on PATH) |
| `ANTHROPIC_API_KEY` or `GLASSBOX_ANTHROPIC_API_KEY` | Only for the optional `anthropic` backend. The plugin stores its key as `GLASSBOX_ANTHROPIC_API_KEY`, which is never passed to the nested `claude -p`, so that call keeps using your Claude Code login |
| `GLASSBOX_OPENAI_API_KEY` or `OPENAI_API_KEY` | Only for the optional `openai-compat` backend |
| `GLASSBOX_OPENAI_BASE_URL` or `OPENAI_BASE_URL` | Base URL for `openai-compat` (default `https://api.openai.com/v1`) |

The nested `codex exec` call runs with a read-only sandbox, in an empty temp directory, with its shell and other tools turned off. The nested `claude -p` call runs with no tools.

## Auto-init

At session start (the plugin's `SessionStart` hook, or `glassbox hook session-start --host codex` in Codex), glassbox checks, in well under a second and without starting any model:

- auto-init is on: first `GLASSBOX_AUTO_INIT` (`0` or `1`), then `"autoInit"` in `.glassbox/config.json` (a config that git tracks can only turn it off), then the plugin's `auto_init` option, default on;
- the session is inside a git work tree, and its root is not your home directory or `/`;
- the repo has no `.glassbox/graph.db` yet, and git does not track anything in `.glassbox/`;
- it has at most `GLASSBOX_AUTO_INIT_MAX_FILES` (default 5000) TypeScript, JavaScript or Python files, counted with `git ls-files` (so `.gitignore` is respected).

When all hold, it creates `.glassbox/` with its `.gitignore`, takes a lock (so two sessions never index twice), and starts `glassbox init --structure-only` as a detached background process, as an argument list without a shell. The session gets one line saying glassbox is indexing. The background init parses the code and writes the graph; it makes no model calls and never writes `AGENTS.md` or `CLAUDE.md`. When it is done, and only when the worker and the edit hooks (`enable_hooks`) are on, it starts the background worker to tag nodes within its daily budget.

In later sessions, the hook adds a code map of at most about 1,500 characters: the areas, their entry points, the riskiest nodes once tags exist, and how to use the MCP tools. Paths and names are in code format and cut to a safe character set, as in the AGENTS.md block, and the map says they are data, not instructions. `GLASSBOX_AUTO_INIT=0` turns off both the auto-init and this code map. A failed auto-init, or one skipped because git could not count the files within 1 s, is not retried for a day; `glassbox status` shows why.

## MCP tools

| Tool | What it does |
|---|---|
| `ask` | Answers a yes/no, choice or score question about files, a diff or graph nodes, with optional evidence. |
| `where` | Ranks the code most likely to implement a concept. |
| `triage` | Scores the risk of a diff per hunk and lists the callers it affects. |
| `decide` | Advises on the agent's own "A or B?" question, with probabilities. |
| `explain` | Adds evidence and reasons to an earlier decision. |
| `graph` | Shows a node's stored tags and neighbours. |
| `refresh` | Marks edited files stale, or re-parses changed files. |

The same commands exist on the CLI (`glassbox ask`, `glassbox where`, ...), and `glassbox mcp` starts the server on stdio for any MCP client. `ask`, `where`, `triage` and `decide` take a `mode` (MCP) or `--mode` (CLI).

## Modes

A mode sets how much work one call does:

| Mode | What it does |
|---|---|
| `fast` | 1 sample, 1 option order, no evidence, no generated why. The cheapest call. |
| `balanced` | The defaults above (2 option orders, the backend's samples, evidence only when asked). Used when nothing sets a mode. |
| `explained` | `balanced` plus the hide-and-re-ask evidence and the one-line why. |
| `strict` | 5 samples, 3 option orders, evidence, and higher bands (`act` at 0.9, `confirm` at 0.7). |
| `auto` | Runs `fast`; when the answer's band is not `act`, asks again in `explained`. The output says when that happened. |

The first one set wins: the call itself (`mode` in MCP, `--mode` on the CLI), `GLASSBOX_MODE`, `"mode"` in `.glassbox/config.json`, the plugin's `mode` option, else `balanced`. Explicit flags such as `--samples` or `--permutations` still win over the mode's values.

## Ambient mode

These parts run next to the agent instead of being called by it. All of them are off by default. None adds a model call to the prompt path: only the end-of-turn gate calls the model, and only after a turn that changed code.

In Claude Code the plugin wires them up (see [docs/claude-code.md](claude-code.md#ambient-mode)); turn each one on in `/plugin` or in `.glassbox/config.json`. In Codex, see [Codex](#ambient-mode-in-codex) below.

### Ambient context (before each prompt)

`glassbox context --prompt "<text>"` (or `-` for stdin) prints graph matches for a prompt: `file:line`, node name, stored tags and direct callers, at most about 1,500 characters.

- It uses only the stored graph. A rule-based check first skips prompts that are not about code.
- It prints nothing when there is no graph, when git tracks anything in `.glassbox/` in any letter case or `.glassbox` is a submodule (it came with the clone), when no node clears the match floor, or when most matching files changed after the last parse.
- The matches come inside a fenced block that the header marks as data, not instructions. Only paths without whitespace (each segment at most 40 characters) and plain identifiers are shown, which keeps what a file name can say short. It cannot stop a short name made of words, which is why the block is labelled as data. The AGENTS.md block does the same: paths and area names are in code format, long segments are cut, and a note says they are data.
- On the sample repo it takes about 10 ms in process, and about 100 ms as a hook (starting `node` is most of it).

The `UserPromptSubmit` hook adds this text to the prompt as extra context. On with the plugin's `ambient` option, `GLASSBOX_AMBIENT=1` or `"ambient": {"enabled": true}` in `.glassbox/config.json`.

### End-of-turn gate

The `Stop` hook runs when the agent is about to finish a turn:

1. It hashes the working diff (`git diff HEAD` plus untracked files, without any file that may hold secrets, such as `.env` or key files, tracked or not). No diff, or the same hash as the last check, means it does nothing.
2. Otherwise it rates the diff with `triage` in `fast` mode (one sample, one option order), or `balanced` when `"gate": {"mode": "balanced"}` is set.
3. If a hunk is rated High risk and its answer is in the `act` band, it blocks the stop once. The agent gets a short reason that names the lines, for example:

   ```
   glassbox gate: 1 changed hunk rated High risk with high confidence (decision 430f797e09d5):
   - src/auth/session.ts:38-41 (verifySession) High risk, p=0.95
   Direct callers: requireAuth (src/auth/middleware.ts:11).
   Check these lines (and their tests) before finishing, or state why they are safe. glassbox asks once per change.
   ```

It never blocks twice in a row: it does nothing when the host says the turn already continued because of a Stop hook (`stop_hook_active`), and it records each diff hash before rating it, so a diff is checked once whatever the outcome. It gives up after 45 s (`GLASSBOX_GATE_TIMEOUT_MS`, else `"gate": {"timeoutMs": ...}`; never more than 50 s, so it ends before the 60 s hook timeout), counting from before it reads the diff, and a timeout or any error lets the turn end normally. On a timeout, or when the host stops the hook, it stops its model calls and the processes they started. On with the plugin's `gate` option, `GLASSBOX_GATE=1` or `"gate": {"enabled": true}`. The last outcome is in `.glassbox/gate.json`.

The `act` band needs the model to put about 0.9 or more on High, so the gate stays quiet on most diffs. Near that line a `fast` rating can go either way between runs: in a test on the sample repo, the same diff (deleting a session expiry check) blocked on one run and passed on the next. Use `"mode": "balanced"` for steadier ratings at about twice the model runs.

### Concise answers

Six rules meant to shorten replies (their effect is not measured yet; see [the A/B pilot](../README.md#does-it-help)): lead with the answer, cite `file:line` instead of pasting code, never paste unchanged code, one line per reason, no closing recap, and one line on what was not checked. They come in two forms, both off by default:

- **Claude Code output style.** The plugin ships `output-styles/concise.md`. Select it with `/output-style glassbox:concise`, in `/config`, or with `"outputStyle": "glassbox:concise"` in a settings file. For one run: `claude --settings '{"outputStyle":"glassbox:concise"}'`. It keeps Claude Code's coding instructions and changes only how replies are written. Claude Code's built-in Concise style is similar; this one adds the `file:line` and no-unchanged-code rules.
- **AGENTS.md section.** An `### Answer style` section with the same rules inside the glassbox block, for Codex and any other agent that reads AGENTS.md. On with the plugin's `concise_rules` option, `GLASSBOX_CONCISE_RULES=1` or `"conciseRules": true` in `.glassbox/config.json`; the block is rewritten on the next `sync-md`, `refresh --sync-md`, `init`, launcher start or session-start hook.

### Background re-tagging

After an edit marks nodes stale, a detached worker (`glassbox worker run`) re-parses the changed files and re-tags stale nodes in `fast` mode.

- It holds a lock file so only one runs.
- It waits at least 60 s between runs and re-tags at most 24 nodes per run.
- It stops at a daily budget of 100 model runs. Each run charges its worst case to the budget before its first model call and settles to the real count at the end, so a run that is killed half way still counts. With the API backends every HTTP request counts, retries included.
- A run stops its model calls after 20 minutes.
- When an edit comes while the worker may not start yet (too soon after the last run, a run in progress, or no budget left), `worker.json` records a pending re-tag, and the next hook call (prompt, stop, edit or session start) starts the worker once it is allowed. `glassbox status` shows it.

Set `"worker": {"enabled": false}` or `GLASSBOX_WORKER=0` to turn it off.

### Status and settings

`glassbox status` (or `/glassbox:status` in Claude Code) shows the graph (nodes, stale nodes, tagged share, last parse), how it got there (auto-init indexing in the background, structure-only with no tags yet, or tagged N of M; in a repo with no graph, whether auto-init will start at the next session or the reason it will not), the mode and where it came from, which hooks and the concise rules are on, and the worker: running or idle, model runs today against the budget, the last run and any last error.

`.glassbox/config.json` is meant to be local to your checkout (`glassbox init` git-ignores the folder). Every field is optional:

```json
{
  "mode": "auto",
  "ambient": { "enabled": true, "maxChars": 1500, "minScore": 3, "maxHits": 6 },
  "gate": { "enabled": true, "mode": "fast", "timeoutMs": 45000 },
  "conciseRules": true,
  "claudeMd": false,
  "autoInit": true,
  "worker": { "enabled": true, "dailyCalls": 100, "minIntervalSec": 60, "maxNodesPerRun": 24 }
}
```

`"claudeMd": false` means a sync never creates CLAUDE.md (an existing one still gets the `@AGENTS.md` import). `glassbox init --no-claude-md` writes it, so later `sync-md`, `refresh --sync-md`, hook and launcher syncs keep that choice.

For each setting the first one set wins: the `GLASSBOX_*` variable, then `.glassbox/config.json`, then the plugin option, else the default. The worker limits and the gate timeout are clamped to the bounds in the environment table under [Configuration](#configuration), whatever sets them.

A `.glassbox/config.json` in a `.glassbox/` that git tracks (any file in it, in any letter case, or `.glassbox` as a submodule) came with the repo, so someone else wrote it. glassbox then keeps only the switches that turn something off (`"enabled": false` for `ambient`, `gate` or `worker`, `"conciseRules": false`, `"claudeMd": false` and `"autoInit": false`) and ignores the rest, so a cloned repo cannot turn on model calls, raise the worker budget or change the mode.

### Hook entry points

`glassbox hook prompt|stop|post-edit|session-start` reads the host's hook JSON on stdin (at most 1 MiB; more is dropped unread) and prints what the host expects (`additionalContext` for `prompt`, and for `session-start` the code map or the one-line indexing note; `{"decision":"block","reason":...}` for `stop`; nothing for `post-edit`). It always exits 0 and prints nothing on any error, for a missing or unknown event or bad arguments, inside a nested glassbox call (`GLASSBOX_NESTED=1`), or in a repo without `.glassbox/` (except `session-start`, which may start the auto-init there). `--host claude-code|codex` tells it which agent runs it, so the gate asks that agent's CLI.

### Ambient mode in Codex

Codex reads the AGENTS.md block at the start of every session, so that is the zero-setup path: the code map, and the concise rules when they are on. `glassbox run codex ...` keeps the block and the graph fresh before each session. Codex 0.154 also has hooks, and the same `glassbox hook` commands can serve them; see [docs/codex.md](codex.md#ambient-mode-hooks).

## Launcher

```sh
glassbox run claude [claude args...]
glassbox run --mode auto codex exec "fix the failing test"
```

`glassbox run` re-parses the graph and rewrites the AGENTS.md block when a file changed since the last parse (no model calls), may start the background worker, sets `GLASSBOX_HOST` (and `GLASSBOX_MODE` when a mode is set), then runs the agent with its arguments passed through untouched, as an argument list without a shell, and returns its exit code. Put glassbox's own options (`--mode`, `--no-refresh`, `--root`) before the agent name; everything after it goes to the agent. `GLASSBOX_CLAUDE_BIN` and `GLASSBOX_CODEX_BIN` pick the binary.

## How the numbers are made

- **One call per state.** Every question about one piece of code goes into a single model call, because host CLI calls take seconds.
- **Calls and model runs.** Each call is asked in 2 option orders by default, and the host CLI backends average K=3 samples per call (`GLASSBOX_SAMPLES`), each one a separate `claude -p` or `codex exec` process. So one plain `ask` starts 6 processes in parallel. The cost line shows both, for example `2 calls (x 3 samples = 6 model runs)`.
- **Option shuffling.** Options get single-letter labels (A, B, C, ...). The engine asks again with the options in a different order (in parallel) and averages, which cancels the model's preference for particular positions.
- **Confidence** is `(K * pmax - 1) / (K - 1)`, where K is the number of options: 0 for a uniform answer, 1 when one option has all the probability. This is our own definition.
- **Bands.** By default `act` when confidence is at least 0.85, `confirm` at 0.6 or above, else `escalate`. Each question can set its own thresholds.
- **Calibration.** Every decision is logged to `.glassbox/decisions.jsonl` with an id. Record the true answer with `glassbox label <id> yes` (or a choice key, or a score level), then run `glassbox calibrate` to fit temperature or Platt scaling per question kind, backend and model from those labels (free-form questions are grouped by type and option count, so a yes/no fit is never applied to a 3-way choice). The result goes to `.glassbox/calibration.json`, and later answers from the same backend and model use it, in the CLI and the MCP tools alike. `calibrate --dry-run` shows ECE and Brier before and after without saving. Below a minimum number of labels nothing is fitted, Platt scaling is pulled toward no change, and the "after" numbers are in-sample, so they are optimistic.

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
