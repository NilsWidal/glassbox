# glassbox A/B harness

Runs the same coding tasks through an agent CLI twice, once with glassbox ambient mode and once without, and compares the runs. It exists so that glassbox only claims what a measurement shows.

- **baseline**: the agent CLI with no glassbox at all.
- **ambient**: the same CLI with glassbox loaded. For Claude Code that is the plugin (`claude -p --plugin-dir <glassbox>`) with the ambient context hook on, after `glassbox init` built and tagged the code graph and wrote the `AGENTS.md` block. For Codex it is the `AGENTS.md` block only, since `codex exec` loads no plugin.

## Results so far

**Pilot, small n (2026-09-23).** Claude Code 2.1.280, model haiku, 6 tasks x 2 arms x 2 repeats = 24 runs. Full tables: [results/pilot-2026-09-23-claude-haiku.md](results/pilot-2026-09-23-claude-haiku.md).

Each cell is baseline / ambient, the mean of the 2 repeats.

| task | kind | passed | cost | tool calls | tokens (all) | wall time | answer words | ambient context (chars) |
|---|---|---|---|---|---|---|---|---|
| fx-q-session-expiry | question | 2/2 / 2/2 | $0.025 / $0.027 | 2 / 1 | 69k / 49k | 8.7 / 9.9 s | 39 / 36 | 638 |
| fx-q-sql-strings | question | 2/2 / 2/2 | $0.055 / $0.037 | 9 / 4.5 | 229k / 112k | 24.1 / 15.2 s | 83 / 85 | 0 |
| fx-edit-discount-clamp | edit | 2/2 / 2/2 | $0.034 / $0.032 | 4 / 2 | 116k / 75k | 15.6 / 13.5 s | 43 / 33 | 592 |
| tomli-bug-literal-quote | bugfix | 2/2 / 2/2 | $0.076 / $0.098 | 6 / 14 | 216k / 435k | 32.8 / 52.3 s | 80 / 143 | 752 |
| tomli-bug-false | bugfix | 2/2 / 2/2 | $0.077 / $0.085 | 7 / 9 | 241k / 310k | 28.6 / 33.1 s | 110 / 88 | 699 |
| tomli-q-parse-float-guard | question | 2/2 / 2/2 | $0.033 / $0.025 | 3 / 1 | 96k / 49k | 12.7 / 8.5 s | 62 / 63 | 658 |
| **all 24 runs** | | **12/12 / 12/12** | **$0.600 / $0.608 total** | **5.2 / 5.3 mean** | **161k / 172k mean** | **20.4 / 22.1 s mean** | **69 / 75 mean** | |

What this pilot shows, and what it does not:

- **Success: no difference.** Every run passed in both arms. These tasks are too easy for haiku to separate the arms on success.
- **Cost: no difference.** $0.600 without glassbox and $0.608 with it, over 12 runs each.
- **Lookups: fewer on short "where is X" questions and the one-file edit.** The hook added context on 5 of the 6 tasks. On the 3 of those that ask to find or change one spot (2 questions, 1 edit), the ambient runs made about half the tool calls (for example 1 instead of 3 on `tomli-q-parse-float-guard`): Claude read one file straight away instead of searching first. That saved tokens but not always money: on `fx-q-session-expiry` the ambient runs cost slightly more.
- **Bug fixes: worse, not better.** On both tomli bug tasks the ambient runs used more tool calls, tokens and time (on `tomli-bug-literal-quote`, 14 tool calls against 6). The pilot does not show why; one ambient run wrote extra test scripts before fixing the bug.
- **Noise is as large as the effects.** On `fx-q-sql-strings` the hook added nothing (0 characters), yet the arms still differ by 2x in tool calls, because one baseline run made 13 calls and the other 5. Two repeats per arm cannot separate an effect of this size from chance.
- **Answer length: not measured as a claim.** The concise output style was off in this pilot; the ambient answers were about as long as the baseline ones.

So far glassbox makes no claim that ambient mode makes the agent more successful, cheaper, faster or more concise. The next step is more repeats, harder tasks (the other 17 are ready) and the concise style as its own arm.

## Task format

All tasks are in [`tasks.json`](tasks.json): a `repos` map and a `tasks` list.

```json
{
  "repos": {
    "fixture": { "type": "path", "path": "../../test/fixtures/sample-repo", "license": "MIT (part of glassbox)" },
    "tomli": { "type": "git", "url": "https://github.com/hukkin/tomli", "commit": "5a77b12a7a9f052ce5a20c335d2825658f6aea52", "license": "MIT" }
  },
  "tasks": [
    {
      "id": "tomli-bug-false",
      "repo": "tomli",
      "kind": "bugfix",
      "prompt": "tomli.loads('a = false') raises a TOMLDecodeError ... Do not edit the tests. ...",
      "setup": [{ "file": "src/tomli/_parser.py", "find": "return pos + 5, False", "replace": "return pos + 4, False" }],
      "protect": ["tests"],
      "checks": [{ "type": "command", "argv": ["python3", "{checks}/tomli/check.py", "false"] }],
      "pilot": true
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `repo` | A key of `repos`. A `path` repo is used in place (relative to `tasks.json`). A `git` repo is cloned once into the cache and checked out at its full commit hash; the harness checks the hash before every run. |
| `kind` | `question`, `bugfix`, `edit` or `feature`. |
| `prompt` | What the agent gets, on stdin. |
| `setup` | Exact text replacements made before the agent starts, for example the bug a bugfix task asks for. Each `find` must occur exactly once. |
| `protect` | Paths put back to their original content before the checks run, so an agent cannot pass by editing the tests. |
| `checks` | All must pass. `answer`: a regular expression (`pattern`, optional `flags`) the final answer must match. `command`: a program and its arguments, run without a shell in the workspace; exit 0 passes. In `argv`, `{checks}` becomes the path of [`checks/`](checks) and `{answerFile}` a file holding the final answer. |
| `solution`, `referenceAnswer` | A known-good fix and answer, used by `validate`. A bugfix task without a `solution` is fixed by undoing its `setup`. |
| `pilot` | Part of the pilot set (`--pilot`). |

There are 23 tasks: 11 on the glassbox sample fixture, 6 on [tomli](https://github.com/hukkin/tomli) (MIT) and 6 on [schedule](https://github.com/dbader/schedule) (MIT), both cloned at a pinned commit into the cache (`~/.cache/glassbox-ab`, or `GLASSBOX_AB_CACHE`) and never committed here. They are questions about where something happens, small edits, injected bugs to find and fix, and one small feature. The fixture checks import its TypeScript with Node's type stripping; the tomli and schedule checks run the project's own unit tests plus a short behaviour script.

## Running it

Needs Node 22.18 or newer (the harness is TypeScript run by Node's type stripping), `git`, `python3`, and the `claude` or `codex` CLI logged in. No API keys.

```sh
node bench/ab/src/cli.ts list                     # the tasks
node bench/ab/src/cli.ts validate                 # every task: checks fail on the start state, pass after the reference fix
node bench/ab/src/cli.ts run --pilot --dry-run    # the exact agent command lines
node bench/ab/src/cli.ts run --pilot --repeats 2 --label "pilot, small n" --out bench/ab/results/my-run
node bench/ab/src/cli.ts run --agent codex --tasks tomli-bug-false,sched-bug-idle --out bench/ab/results/codex-try
```

Options: `--tasks a,b`, `--pilot`, `--repo <name>`, `--agent claude|codex`, `--model` (default `haiku` for Claude, the CLI default for Codex), `--arms baseline,ambient`, `--repeats n`, `--timeout <sec>` (default 600), `--max-budget-usd` (Claude, per run, default 1), `--effort` (Codex, default `low`), `--no-init-tags`, `--concise` (the ambient arm also uses the `glassbox:concise` style, or the concise AGENTS.md rules for Codex), `--gate` (the ambient arm also runs the end-of-turn gate), `--keep` (keep workspaces), `--label`, `--caveat` (repeatable), `--out <path>` (writes `<path>.json` and `<path>.md`).

### What one run does

1. Copies the repo into a fresh temp directory (file times kept, no `.git`), applies the task's `setup`, and makes it a one-commit git repo.
2. Ambient arm only: copies in the graph that `glassbox init` built and tagged once per repo (with the agent's own CLI, 1 sample per tag question), then re-parses with `glassbox init --no-tags`, which makes no model call.
3. Starts the agent with the prompt on stdin and an argument list (no shell):
   - Claude: `claude -p --output-format stream-json --verbose --include-hook-events --no-session-persistence --setting-sources project,local --strict-mcp-config --permission-mode acceptEdits --model haiku --max-budget-usd 1 --allowedTools ...`, plus `--plugin-dir <glassbox>` in the ambient arm. User settings, user plugins and MCP servers are left out of both arms so they start from the same setup. `stream-json` ends with the same `result` object as `--output-format json` and also carries the tool calls and hook output.
   - Codex: `codex exec --json --skip-git-repo-check --sandbox workspace-write -C <workspace> -c model_reasoning_effort=low -`.
   - The ambient arm sets `GLASSBOX_AMBIENT=1` and `GLASSBOX_GATE=0`, `GLASSBOX_HOOKS=0`, `GLASSBOX_WORKER=0`, so only the ambient context hook runs. Inherited `GLASSBOX_*` variables are removed from both arms.
4. Restores `protect` paths, runs the checks, and deletes the workspace.

The two arms of a task run one after the other, and which arm goes first alternates from task to task.

### What is measured

| Metric | Source |
|---|---|
| success | all checks pass |
| cost | Claude: `total_cost_usd` from the result. Codex reports no cost. |
| tokens | Claude: `usage` (input, cache read, cache creation, output). Codex: `turn.completed` usage. "tokens (all)" is their sum. |
| tool calls | Claude: `tool_use` blocks in the stream. Codex: command, file change, MCP and web search items. |
| turns | Claude: `num_turns`. Codex: completed turns. |
| wall time | measured by the harness around the agent process |
| answer length | characters and words of the final answer (`result`, or Codex's last agent message) |
| ambient chars | characters of context the glassbox prompt hook added (Claude) |

The results also keep each run's answer (first 4,000 characters), tools by name, denied tool calls, the plugins the session loaded and the time of the one-time `glassbox init`.

## Limits

- The runs are headless with a fixed allowed-tool list (read, search, edit, and `python3`, `node`, `git diff` and a few read-only shell commands). Other tool calls are denied and counted, in both arms.
- The one-time tagging during `glassbox init` costs model calls that no run's numbers include. Over a real session that cost is spread over many prompts; in this harness it is not charged to anyone.
- Codex: its ambient arm has no prompt hook (Codex hooks need to be trusted interactively first), so it only tests the `AGENTS.md` block. The Codex path has unit tests on recorded output but has not had a pilot.
