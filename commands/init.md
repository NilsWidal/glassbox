---
description: Run the full glassbox init in this repo (code graph, tags from your Claude Code model, AGENTS.md block and CLAUDE.md import)
argument-hint: "[--no-claude-md] [--limit <n>] [--force]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/plugin-dist/glassbox.mjs" init *)
---

Run the full glassbox init for this project with the Bash tool, exactly this command (one call, a timeout of 600000 ms):

```
node "${CLAUDE_PLUGIN_ROOT}/plugin-dist/glassbox.mjs" init --root "${CLAUDE_PROJECT_DIR}" $ARGUMENTS
```

Arguments passed to this command: `$ARGUMENTS`. Pass them through only when they are `glassbox init` options (words starting with `--`, and their values, such as `--no-claude-md` or `--limit 200`). If they contain anything else (shell syntax like `;`, `|`, `&`, `$(`, backticks or redirections), do not run the command; say which part was not an init option.

The full init parses the code graph, asks the tag questions about each function through your Claude Code model (`claude -p`, default model haiku, several model runs per function), writes the glassbox block into `AGENTS.md` and adds an `@AGENTS.md` import to `CLAUDE.md` (unless `--no-claude-md`). On a large repo it can take several minutes. If the Bash call times out, say so: the graph is still usable, tags are cached by content hash, and running `/glassbox:init` again continues where it stopped.

When it finishes, summarize in a few lines, using only what the command printed:
- files, nodes and edges in the graph;
- how many nodes were tagged, the backend and model, and any failed tag groups;
- what happened to `AGENTS.md` and `CLAUDE.md` (created, updated, unchanged or skipped).

Do not paste the full output, and do not open or edit any file.
