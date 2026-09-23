# A/B results: pilot, small n

- Date: 2026-09-23
- Agent: claude (2.1.280 (Claude Code)), model: haiku
- glassbox: 0.1.0
- Arms: baseline, ambient; repeats per task and arm: 2; tasks: 6

## Caveats

- Pilot, small n: 6 tasks x 2 arms x 2 repeats (24 runs) on one model (haiku). Differences of this size can come from run-to-run noise alone; nothing here is statistically tested.
- 3 of the 6 tasks run on the glassbox sample fixture, a 16-file repo whose comments point at the answers; the other 3 run on tomli at a pinned commit with a bug the harness injects.
- The ambient arm is the whole glassbox plugin setup against none: the plugin (--plugin-dir) with its UserPromptSubmit context hook on and its skill, plus the AGENTS.md/CLAUDE.md block from glassbox init. The baseline has none of these. The end-of-turn gate, the concise output style, the background worker and the glassbox MCP server are off (--strict-mcp-config). So a difference between the arms cannot be put down to the injected context alone: on fx-q-sql-strings the hook added 0 characters and the arms still differ.
- The model calls glassbox init made to tag the graph are one-time preparation and are not counted in any run's cost or tokens.
- Both arms skip user settings and MCP servers (--setting-sources project,local --strict-mcp-config) and use the same allowed tool list. They were not plugin-free: every run in both arms loaded the agents-md and telemetry plugins (from the session's init event), and the ambient arm also loaded glassbox. Those two plugins were the same in both arms, so they add no difference between the arms.

## Per arm

| arm | runs | passed | agent errors | median cost | median tokens (all) | median output tokens | median tool calls | median turns | median wall time | median answer words | median answer chars | total cost |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 12 | 12/12 | 0 | $0.0344 | 116325 | 1106 | 4.5 | 5.5 | 15.6 s | 68.5 | 404.5 | $0.6006 |
| ambient | 12 | 12/12 | 0 | $0.0319 | 74538.5 | 976 | 3 | 4 | 14.4 s | 74 | 472 | $0.6081 |

## Paired by task (ambient minus baseline)

6 tasks ran in both arms. Ambient passed where the baseline failed on 0; the baseline passed where ambient failed on 0.

| metric | median difference | ambient lower | ambient higher | equal |
|---|---|---|---|---|
| cost | -$0.0005 | 3 | 3 | 0 |
| tokens (all) | -30551.5 | 4 | 2 | 0 |
| output tokens | -3 | 3 | 3 | 0 |
| tool calls | -1.5 | 4 | 2 | 0 |
| turns | -1.5 | 4 | 2 | 0 |
| wall time | -0.4 s | 3 | 3 | 0 |
| answer words | -1 | 3 | 3 | 0 |
| answer chars | -2 | 3 | 3 | 0 |

## Per run

| task | arm | rep | pass | cost | tokens | tool calls | turns | wall | words | ambient chars | error |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fx-q-session-expiry | baseline | 0 | yes | $0.0253 | 68613 | 2 | 3 | 9.0 s | 34 | - |  |
| fx-q-session-expiry | ambient | 0 | yes | $0.0260 | 49001 | 1 | 2 | 8.4 s | 34 | 638 |  |
| fx-q-session-expiry | ambient | 1 | yes | $0.0280 | 49584 | 1 | 2 | 11.4 s | 38 | 638 |  |
| fx-q-session-expiry | baseline | 1 | yes | $0.0252 | 68605 | 2 | 3 | 8.4 s | 44 | - |  |
| fx-q-sql-strings | ambient | 0 | yes | $0.0426 | 149675 | 5 | 6 | 16.5 s | 93 | 0 |  |
| fx-q-sql-strings | baseline | 0 | yes | $0.0325 | 93549 | 5 | 6 | 14.5 s | 92 | - |  |
| fx-q-sql-strings | baseline | 1 | yes | $0.0766 | 364941 | 13 | 14 | 33.7 s | 73 | - |  |
| fx-q-sql-strings | ambient | 1 | yes | $0.0318 | 74065 | 4 | 5 | 13.9 s | 77 | 0 |  |
| fx-edit-discount-clamp | baseline | 0 | yes | $0.0344 | 116343 | 4 | 5 | 15.4 s | 50 | - |  |
| fx-edit-discount-clamp | ambient | 0 | yes | $0.0321 | 74681 | 2 | 3 | 12.2 s | 33 | 592 |  |
| fx-edit-discount-clamp | ambient | 1 | yes | $0.0312 | 74396 | 2 | 3 | 14.9 s | 33 | 592 |  |
| fx-edit-discount-clamp | baseline | 1 | yes | $0.0344 | 116307 | 4 | 5 | 15.7 s | 35 | - |  |
| tomli-bug-literal-quote | ambient | 0 | yes | $0.1278 | 602887 | 19 | 20 | 63.7 s | 162 | 752 |  |
| tomli-bug-literal-quote | baseline | 0 | yes | $0.0780 | 217309 | 6 | 7 | 33.0 s | 96 | - |  |
| tomli-bug-literal-quote | baseline | 1 | yes | $0.0744 | 215229 | 6 | 7 | 32.6 s | 64 | - |  |
| tomli-bug-literal-quote | ambient | 1 | yes | $0.0688 | 267928 | 9 | 10 | 40.9 s | 123 | 752 |  |
| tomli-bug-false | baseline | 0 | yes | $0.0769 | 240518 | 7 | 8 | 29.0 s | 146 | - |  |
| tomli-bug-false | ambient | 0 | yes | $0.0803 | 299968 | 9 | 10 | 32.9 s | 77 | 699 |  |
| tomli-bug-false | ambient | 1 | yes | $0.0888 | 320873 | 9 | 10 | 33.3 s | 98 | 699 |  |
| tomli-bug-false | baseline | 1 | yes | $0.0768 | 240679 | 7 | 8 | 28.2 s | 73 | - |  |
| tomli-q-parse-float-guard | ambient | 0 | yes | $0.0251 | 48534 | 1 | 2 | 7.7 s | 71 | 658 |  |
| tomli-q-parse-float-guard | baseline | 0 | yes | $0.0326 | 95982 | 3 | 4 | 12.4 s | 41 | - |  |
| tomli-q-parse-float-guard | baseline | 1 | yes | $0.0335 | 96918 | 3 | 4 | 13.0 s | 83 | - |  |
| tomli-q-parse-float-guard | ambient | 1 | yes | $0.0256 | 48647 | 1 | 2 | 9.3 s | 55 | 658 |  |

## Preparation (not counted in the runs)

- fixture: `glassbox init` for the ambient arm, ok, 66.8 s
- tomli: `glassbox init` for the ambient arm, ok, 185.1 s

