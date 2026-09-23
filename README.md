# glassbox

Your coding agent answers questions about code as typed decisions, each with a probability, a confidence band and the lines that drove it. It also keeps a map of your codebase, so it starts each task knowing where things are. It works in Claude Code and Codex, and uses the login you already have.

```
$ glassbox ask "does this change session handling?" --path src/auth --mode explained

YES  p=0.72  conf=0.44  escalate   "does this change session handling?"
summary
  requireAdmin() -> requireAuth()                    # Δp +0.28 at src/auth/middleware.ts:10-17
                    -> verifySession()               # Δp -0.72 at src/auth/session.ts:46
                       -> SessionStore.revoke()      # Δp -0.67 at src/auth/session.ts:25-28
  because: reads-config (p=0.97), side-effects (p=0.81)
  ruled out: changes-behavior (p=0.14), missing-check (p=0.01)
highlights
  src/auth/session.ts:46         Δp -0.72
  src/auth/session.ts:25-28      Δp -0.67
  src/auth/middleware.ts:10-17   Δp +0.28
cost  2 calls + 24 explain + 1 why, 11/12 spans tested
id    07a2d2cbb919   (glassbox explain 07a2d2cbb919)
```

This is the real output format, run on the bundled sample repo with the test backend, so the numbers are illustrative. `Δp` is how much the answer's probability changes when glassbox hides those lines and asks again. The highlights are measured, not the model's say-so. `escalate` is the confidence band: `act`, `confirm` or `escalate`.

> Status (v0.3.0, 2026-09-23): early, working, tested (587 unit tests, plus live runs against the real `claude` and `codex` CLIs). Not yet published to npm. The plugin runs from this repository, so you do not need npm.

## Install

### Claude Code

```
/plugin marketplace add NilsWidal/glassbox
/plugin install glassbox@glassbox
```

Then open any git repository in Claude Code. There is no setup step.

### Codex

```sh
git clone https://github.com/NilsWidal/glassbox ~/glassbox
codex mcp add glassbox --env GLASSBOX_HOST=codex -- node ~/glassbox/plugin-dist/glassbox.mjs mcp
npx skills add NilsWidal/glassbox -g -a codex
```

Requires Node 22.13 or newer. Details: [docs/claude-code.md](docs/claude-code.md), [docs/codex.md](docs/codex.md).

## What happens after install

1. **First session in a repo.** glassbox builds a graph of the code in the background: files, functions, classes, imports and calls. That takes seconds, makes no model calls, and writes only into `.glassbox/`, which ignores itself in git. Your `AGENTS.md` and `CLAUDE.md` stay untouched. It skips folders that are not git repos, your home directory, and repos with more than 5,000 TypeScript, JavaScript or Python files.
2. **Every later session.** Claude starts with a short code map (areas, entry points, riskiest code once tagged) and can call the glassbox tools on its own:

   | Tool | Answers |
   |---|---|
   | `where` | Where is this concept implemented? Ranked `file:line` |
   | `ask` | A yes/no, choice or score question about files, a diff or functions |
   | `triage` | How risky is this diff, per hunk, and which callers does it affect? |
   | `decide` | The agent's own "A or B?" question, with probabilities |
   | `explain` | Evidence and a one-line reason for an earlier decision |
   | `graph`, `refresh` | A function's tags and neighbours; re-parse after edits |

3. **Optional, when you want more:**
   - `/glassbox:init` tags every function now (auth, side effects, personal data, needs tests, area, risk) and writes a summary block into `AGENTS.md` that Codex and teammates read. It asks your model about each function, so it takes minutes on a large repo.
   - Turn on `enable_hooks` in `/plugin configure glassbox@glassbox` and tags fill in by themselves in the background, within a daily budget (100 model runs by default).
   - `ambient` adds matching `file:line` spans to every prompt, and `gate` checks risky changes before a turn ends.
   - `/output-style glassbox:concise` gives shorter answers that cite `file:line` instead of pasting code.
   - `/glassbox:status` shows what is indexed, what is tagged and today's model use.

## Where the model calls come from

glassbox never needs its own API key. In Claude Code it asks `claude -p` (default model haiku). In Codex it asks `codex exec`. It uses your existing subscription, and nothing else. The nested calls run without tools, so code in your repo cannot make them act.

The tradeoff is speed. TypeSafe's Jev, the model that inspired the answer format, answers in about 100 ms. A host CLI call takes seconds (12 s median per batched decision with haiku, measured below). glassbox makes up for it by asking all questions about one piece of code in one call and caching the answers in the graph. The prompt-time map and context use the graph only and take about 60 to 100 ms.

## Does it help

Measured on 2026-09-23, small samples, so read these as early signals:

- **Answer quality on a test set.** On 75 questions written by the author about the bundled test repo, `claude-cli` (haiku) got 74 right and `codex-cli` got 75. Probabilities were close to observed accuracy (calibration error 0.017 and 0.002). The set is too easy to tell good calibration from bad; a human-labeled set on real repos is still to do. Details: [bench/](bench/README.md).
- **Faithfulness of highlights.** Removing the highlighted lines moved the answer every time (4 of 4 per backend), and removing the same amount of other lines did not (0 of 4).
- **Agent effort (A/B pilot).** 6 tasks, run twice with the plugin and twice without, on haiku. Every run passed in both arms, and total cost was the same ($0.608 with, $0.601 without). "Where is X" questions and a one-file edit took about half the tool calls with glassbox. Two bug fixes in a real library took more. With 2 repeats per arm, noise is as large as these differences. Details: [bench/ab/](bench/ab/README.md).

So glassbox does not yet claim to make agents more successful, cheaper, faster or more concise. The harness to test that is in the repo.

## Modes

Every call can do more or less work: `fast` (one sample, no evidence), `balanced` (default), `explained` (adds highlights and a why), `strict` (more samples, stricter bands) or `auto` (fast first, explained when unsure). Set it per call, with `GLASSBOX_MODE`, or in the plugin settings.

## Safety

- A `.glassbox/` folder that came with a cloned repo (committed in any letter case, a submodule, or symlinked) is never trusted: it can only turn features off, never on.
- Files that look like secrets (`.env`, keys) are never sent to the model or written to logs.
- Paths and names from the repo are shown as code and marked as data, not instructions.
- Hooks fail open, have hard timeouts, and never block a turn twice.

## Reference

Configuration, auto-init rules, all hooks, modes, the launcher, how probabilities and confidence are computed, calibration and library use: [docs/reference.md](docs/reference.md).

## Development

```sh
npm install
npm test          # unit tests, no network (fake backend)
npm run typecheck
npm run lint
npm run bundle    # rebuild plugin-dist/ (commit it; CI runs bundle:check)
```

Live tests against the real `claude` and `codex` CLIs are opt-in: `GLASSBOX_IT=1 npm test`.

## License

MIT, see [LICENSE](LICENSE).
