# glassbox bench

A small labeled benchmark for checking how accurate and how well calibrated glassbox's answers are on each backend, and whether its highlighted evidence is faithful.

The A/B harness for agent runs with and without ambient mode is in [ab/](ab/README.md).

## Read this first: what the labels are

- **The labels are author-constructed.** Every question in `questions.json` was written by the glassbox author against the fixture repo in `test/fixtures/sample-repo`. Each answer is true because of how that fixture code is written, and each item quotes the line that makes it true in its `evidence` field (a unit test checks that every evidence line exists in the item's files).
- **This is not an independent, human-labeled set.** No one else labeled these questions, there was no agreement check between labelers, and the author knew what the code does while writing the questions.
- **The fixture is small and friendly.** It has 16 short files, and several of them carry comments such as `// Risky: ...` that point at the answer. Scores here will be higher than on real code.
- **n is small.** 75 questions (53 yes/no, 12 choice, 10 score). A single wrong answer moves accuracy by more than one point, and 15-bin ECE on 75 items is noisy.

The plan's target is about 200 human-labeled questions over 2 or 3 real open-source repos. That is **future work**; this set only proves the tooling and gives a first rough number.

## What is in here

| Path | What it is |
|---|---|
| `questions.json` | The questions: `repos` (name to root, relative to this file or absolute) and `items`. |
| `results/<backend>.json` | Full results of the last run on that backend, per item. |
| `results/<backend>.md` | The same run as a readable table. |

An item looks like this:

```json
{
  "id": "retry-idempotency",
  "repo": "sample-repo",
  "paths": ["src/billing/retry.ts"],
  "type": "yesno",
  "question": "Does retryCharge send an idempotency key with each charge attempt?",
  "truth": "false",
  "evidence": "return await chargeCard(cardNumber, amountCents);"
}
```

- `type` is `yesno`, `choice` (with `options`: key to description) or `score` (with `levels`, lowest first).
- `truth` is an option key: `true` or `false`, a choice key, or a score level index (`"0"`, `"1"`, ...).
- Score questions ask for counts (attempts, methods, bytes), so each has one right level.

## Running it

```sh
glassbox bench --backend fake                     # harness check, no model calls
glassbox bench --backend claude-cli --samples 3   # the Claude Code login, model 'haiku' by default
glassbox bench --backend codex-cli --samples 3    # the Codex login, Codex's configured model unless -m is given
```

Useful flags: `--limit n` (first n questions), `--no-faithfulness`, `--faith-limit n` (faithfulness on the first n yes/no items only; it is the expensive part), `--note "text"` (a caveat stored with the results), `--no-write`, `--json`.

Questions about the same files go to the model together in one batched call per option order, as in normal use. Latency is reported per batched decision.

## What the numbers mean

- **Accuracy**: share of questions where the most probable option is the labeled one.
- **ECE (15 bins)**: expected calibration error on the top option's probability. Items are put in 15 equal-width bins by that probability, and ECE is the count-weighted average gap between the bin's accuracy and its mean probability. 0 is perfectly calibrated.
- **Brier**: squared error summed over options, averaged over items (0 is perfect, 2 is the worst). For a yes/no item this is twice the usual binary Brier score.
- **NLL**: mean negative log probability of the labeled option.
- **Temperature, 2-fold CV**: a temperature fitted on half of the items and scored on the other half, to show what `glassbox calibrate` could buy without scoring on the data it was fitted on.
- **Faithfulness** (yes/no items that got highlights): for each item, glassbox's hide-and-re-ask pass picks highlighted spans. Then:
  - **deletion**: remove every highlighted span and re-ask. It passes when P(answer) drops by at least 0.1.
  - **sufficiency**: keep only the highlighted spans and re-ask. It passes when P(answer) falls by at most 0.1.
  - **control**: remove the same number of random non-highlighted spans. If this drops P as often as deletion does, the highlights are not special.

The fake backend's numbers are marked **harness-only**: its answers are scripted from the evidence lines, so they only show that every step of the bench runs.

## Results so far (2026-09-23)

| backend | model | accuracy | ECE | Brier | p50 / p95 per batched decision | faithfulness: deletion / sufficiency / control drop |
|---|---|---|---|---|---|---|
| claude-cli | haiku, 3 samples | 0.987 (74/75) | 0.017 | 0.008 | 12.4 s / 16.6 s | 4/4, 4/4, 0/4 |
| codex-cli | Codex's configured model (gpt-6-astra here), effort low, 3 samples | 1.000 (75/75) | 0.002 | 0.000 | 27.2 s / 30.4 s | 4/4, 4/4, 0/4 |

Both backends almost saturate this set, so it cannot yet tell good calibration from bad: nearly every answer is right at p close to 1. That is the fixture being easy (short files, hint comments), not proof of calibration on real code. Faithfulness ran on only 6 yes/no items per backend (4 got highlights). See `results/` for the full tables and per-item numbers.

## Adding an external repo

1. Add it under `repos`, for example `"my-lib": "/abs/path/to/my-lib"` (or a path relative to this file).
2. Add items with `"repo": "my-lib"` and paths relative to that root.
3. Put the line that decides the answer in `evidence`. Better still, have someone who did not write the question label it, and record that in the item's id or a note, so human-labeled items can be reported apart from author-constructed ones.
