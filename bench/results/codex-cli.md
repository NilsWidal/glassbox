# glassbox bench: codex-cli

Date: 2026-09-23. Backend: `codex-cli`. Model: `backend default`. Samples per call: 3. Option orders: 2.

Note: codex-cli on the Codex login with no -m flag, so Codex used its configured model (gpt-6-astra in ~/.codex/config.toml on this machine) at reasoning effort 'low' (set by glassbox), codex-cli 0.154.0.

Note: Faithfulness ran on the first 6 yes/no items only, to keep the live run small.

Caveats: the labels are author-constructed from the fixture code (see bench/README.md), not an independent human-labeled set, and n is small, so treat these as rough numbers.

| set | n | accuracy | ECE (15 bins) | Brier | NLL |
|---|---|---|---|---|---|
| all | 75 | 1.000 | 0.002 | 0.000 | 0.002 |
| yesno | 53 | 1.000 | 0.002 | 0.000 | 0.002 |
| choice | 12 | 1.000 | 0.000 | 0.000 | 0.000 |
| score | 10 | 1.000 | 0.000 | 0.000 | 0.000 |
| all, temperature 2-fold CV (T=0.05, 0.05) | 75 | 1.000 | 0.000 | 0.000 | 0.000 |

A fitted temperature sits at the low edge of its search range (0.05). The answers here are almost all right and near-certain, so the fit sharpens them as far as it can; do not reuse it as a calibrator.

| latency p50 | latency p95 | batched decisions | backend calls (decide) | calls (faithfulness) | failed items |
|---|---|---|---|---|---|
| 27.2 s | 30.4 s | 17 | 34 | 84 | 0 |

Latency is the wall time of one batched decision: all questions about one scope, with its option orders run in parallel.
Each backend call runs 3 samples in parallel.

## Faithfulness (yes/no items)

Deletion: remove every highlighted span; P(answer) should drop by at least 0.1. Sufficiency: keep only the highlights; P(answer) should fall by at most 0.1. Control: remove as many random non-highlighted spans.

| tested | with highlights | deletion pass | sufficiency pass | control drop rate | mean drop, deletion | mean drop, sufficiency | mean drop, control |
|---|---|---|---|---|---|---|---|
| 6 | 4 | 100% | 100% | 0% | 0.500 | 0.002 | 0.000 |

## Reliability (all items)

```
bin          n    mean p  acc    gap     accuracy vs mean p (|)
0.87-0.93     1  0.908   1.000  +0.092  ##################|#
0.93-1.00    74  1.000   1.000  +0.000  ###################|
```
