---
description: Show glassbox status for this repo (graph, auto-init and tagging progress, hooks, worker budget)
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/plugin-dist/glassbox.mjs" status *)
---

Output of `glassbox status` for this project:

!`node "${CLAUDE_PLUGIN_ROOT}/plugin-dist/glassbox.mjs" status --root "${CLAUDE_PROJECT_DIR}"`

Summarize it in at most five short lines: whether the repo has a graph and how it was built (indexing, structure-only, or tagged N of M), which hooks are on, and the worker's model runs today against its budget. If there is no graph or it is structure-only, say that `/glassbox:init` runs the full init (tags and the AGENTS.md block). Do not run any other command.
