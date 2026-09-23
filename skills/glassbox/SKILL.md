---
name: glassbox
description: Typed, probability-scored answers about this codebase through the glassbox MCP tools (ask, where, triage, decide, explain, graph, refresh). Use it to find where a concept lives in the code, to rate the risk of a diff before committing or reviewing, to get a second opinion with probabilities on your own A-or-B implementation choice, or to answer a yes/no, choice or score question about files with highlighted evidence. Also use it to read glassbox output (p, confidence, act/confirm/escalate bands, delta-p highlights) and to act on it correctly.
---

# glassbox

glassbox answers typed questions about code with a probability instead of free text. It runs on the host agent's own model (the `claude` CLI in Claude Code, `codex exec` in Codex), so it needs no extra keys. Each call takes a few seconds, so ask for what you need in one call and prefer the graph tools over re-reading many files.

## When to use which tool

| You want to | Tool | Example |
|---|---|---|
| Find the code for a concept | `where` | `where { concept: "billing charge retries" }` |
| Rate the risk of your changes before you commit or hand off | `triage` | `triage {}` (uses `git diff HEAD`) or `triage { diff }` |
| Choose between two or more approaches | `decide` | `decide { question: "Where should the retry limit live?", options: ["config=in config.ts", "inline=next to the loop"], context: "user wants one place to tune it" }` |
| A yes/no, choice or score answer about specific code | `ask` | `ask { question: "Does this change auth behavior?", paths: ["src/auth"], explain: true }` |
| Evidence for an earlier answer | `explain` | `explain { id: "3f9c2a1b7d4e" }` |
| A node's stored tags and callers | `graph` | `graph { node: "verifySession" }` |
| Tell glassbox that files changed | `refresh` | `refresh { files: ["src/auth/session.ts"] }` |

Tips:
- Scope `ask` narrowly (`paths`, `nodes` or a `diff`). The default scope is the whole repo, which is slow and blurs the answer.
- `where`, `triage`, `decide` and `graph` use the code graph in `.glassbox/`. If the repo has none, they build it (no model calls) on first use. `glassbox init` also adds tags (handles_auth, side_effects, touches_pii, needs_tests, area, risk) and an AGENTS.md summary.
- `decide` only advises. You or the user still make the call.

## How to read the output

```
YES  p=0.93  conf=0.88  act   "does this PR change auth behavior?"
summary
  login() -> verifySession()   # TTL now read from env, was fixed
highlights
  src/auth/session.ts:42-47   Δp -0.61  # TTL from process.env, no fallback
  src/auth/middleware.ts:18   Δp -0.22
```

- **p** is the probability of the answer shown: for `NO  p=0.97` it is P(no) = 0.97, so P(yes) = 0.03. JSON output (`format: "json"`) has `answer.p` = P(yes). For `choice` and `score` every option gets a probability.
- **confidence** runs from 0 (all options equally likely) to 1 (one option has all the probability).
- **band** tells you what to do:
  - `act`: rely on it and carry on.
  - `confirm`: plausible but not settled. Read the top highlights, or the code they point to, before acting.
  - `escalate`: do not rely on it. Read the code yourself or ask the user.
- **highlights** are `file:line` spans. **Δp** (delta p) is how much the probability dropped when that span was hidden and the question re-asked. A large negative Δp means the answer depends on that code. Highlights are measured, not narrated.
- **reasons** are short codes (for example `reads-config`, `missing-check`) checked as their own yes/no questions.
- **summary** is pseudo-code built only from the highlights and reasons. It never invents thresholds.
- **why** is one line of model narrative, marked as unchecked. Trust the highlights over it.
- Probabilities come from the model's stated and sampled answers, not a trained classifier, so treat 0.6 to 0.8 as "leaning", not "sure".

## Add your own comments at the highlights

When you pass a glassbox result on (to the user, a review or a commit message), add your own one-line comment next to each highlight that says what the code there does and why it moves the answer, in plain words:

```
src/auth/session.ts:42-47   Δp -0.61  # TTL is read from process.env with no default; unset env means sessions never expire
```

Keep each comment to one line, base it on the code you read at that span, and say so when you are unsure.

## When not to use it

- Facts a tool can compute exactly (counts, dates, whether a symbol exists): use grep or the compiler.
- Anything that needs a long written answer. glassbox returns labels and numbers, not prose.
