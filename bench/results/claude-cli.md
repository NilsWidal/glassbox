# glassbox bench: claude-cli (haiku)

Date: 2026-09-23. Backend: `claude-cli`. Model: `haiku`. Samples per call: 3. Option orders: 2.

Note: claude-cli on the Claude Code login, model alias 'haiku' (claude -p --model haiku), Claude Code 2.1.280.

Note: Faithfulness ran on the first 6 yes/no items only, to keep the live run small.

Caveats: the labels are author-constructed from the fixture code (see bench/README.md), not an independent human-labeled set, and n is small, so treat these as rough numbers.

| set | n | accuracy | ECE (15 bins) | Brier | NLL |
|---|---|---|---|---|---|
| all | 75 | 0.987 | 0.017 | 0.008 | 0.020 |
| yesno | 53 | 1.000 | 0.008 | 0.001 | 0.009 |
| choice | 12 | 1.000 | 0.007 | 0.000 | 0.007 |
| score | 10 | 0.900 | 0.073 | 0.056 | 0.094 |
| all, temperature 2-fold CV (T=0.05, 0.05) | 75 | 0.987 | 0.007 | 0.007 | 0.009 |

A fitted temperature sits at the low edge of its search range (0.05). The answers here are almost all right and near-certain, so the fit sharpens them as far as it can; do not reuse it as a calibrator.

| latency p50 | latency p95 | batched decisions | backend calls (decide) | calls (faithfulness) | failed items |
|---|---|---|---|---|---|
| 12.4 s | 16.6 s | 17 | 34 | 84 | 0 |

Latency is the wall time of one batched decision: all questions about one scope, with its option orders run in parallel.
Each backend call runs 3 samples in parallel.

## Faithfulness (yes/no items)

Deletion: remove every highlighted span; P(answer) should drop by at least 0.1. Sufficiency: keep only the highlights; P(answer) should fall by at most 0.1. Control: remove as many random non-highlighted spans.

| tested | with highlights | deletion pass | sufficiency pass | control drop rate | mean drop, deletion | mean drop, sufficiency | mean drop, control |
|---|---|---|---|---|---|---|---|
| 6 | 4 | 100% | 100% | 0% | 0.807 | 0.005 | 0.002 |

## Reliability (all items)

```
bin          n    mean p  acc    gap     accuracy vs mean p (|)
0.47-0.53     1  0.500   0.000  -0.500  ..........|.........
0.80-0.87     2  0.833   1.000  +0.167  #################|##
0.93-1.00    72  0.994   1.000  +0.006  ###################|
```

## Wrong answers

- `sc-store-methods`: truth 3, answered 2 (p(truth)=0.500)
