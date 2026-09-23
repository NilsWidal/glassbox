# glassbox in Claude Code

glassbox runs on the model you already use in Claude Code. When it needs an answer it calls `claude -p` (default model `haiku`) with your existing login, so there is no key to paste.

## Install the plugin

This repository is its own plugin marketplace. In Claude Code:

```
/plugin marketplace add NilsWidal/glassbox
/plugin install glassbox@glassbox
```

The plugin brings:

| Part | File | What it does |
|---|---|---|
| MCP server | `.mcp.json` | Starts `npx -y @nilswidal/glassbox@0.1.0 mcp`, which provides the tools `ask`, `where`, `triage`, `decide`, `explain`, `graph` and `refresh`. |
| Skill | `skills/glassbox/SKILL.md` | Teaches Claude when to use each tool and how to read `p`, confidence, bands and highlights. |
| Hooks | `hooks/hooks.json` | Opt-in. Keep the graph and the AGENTS.md block fresh while you work. |
| Settings | `.claude-plugin/plugin.json` | The options below. |

**Why npx.** A marketplace install is a copy of this git repository, which does not include the built `dist/` folder or `node_modules`. So the server runs from the published npm package, and the first start downloads it. To run from a clone instead, see the end of this page.

## Settings

Claude Code asks for these when you enable the plugin. You can change them later in `/plugin`.

| Option | Default | Meaning |
|---|---|---|
| `backend` | `auto` | `auto` uses the Claude Code CLI (`claude -p`), so no key is needed. `anthropic` and `openai-compat` are optional API backends for CI or headless use. |
| `model` | empty | Model id for the chosen backend. Empty means the default (`haiku` for `claude-cli`). |
| `enable_hooks` | off | Turns on the hooks described below. |
| `anthropic_api_key` | empty | Only for the `anthropic` backend. Stored in your system keychain, not in settings files. |
| `openai_api_key` | empty | Only for the `openai-compat` backend. Stored in your system keychain. |
| `openai_base_url` | empty | Only for the `openai-compat` backend. |

Environment variables you set yourself (`GLASSBOX_BACKEND`, `GLASSBOX_MODEL`, `ANTHROPIC_API_KEY`, ...) take precedence over these settings.

## Index the repo

The graph tools work without it: on first use they build the code graph, without tags. For tags and the AGENTS.md summary, run this once in the repository:

```sh
npx -y @nilswidal/glassbox init
```

This writes `.glassbox/` (with its own `.gitignore`, so it is not committed), a managed block in `AGENTS.md`, and an `@AGENTS.md` import line in `CLAUDE.md`. Claude Code and Codex then read the same summary.

## Hooks (opt-in)

Hooks are off until you turn on `enable_hooks`, or set `GLASSBOX_HOOKS=1` in your environment. `GLASSBOX_HOOKS=0` turns them off even when the setting is on.

| Event | What runs | Cost |
|---|---|---|
| After `Edit`, `Write` or `MultiEdit` | `glassbox refresh --files <path>`: marks the edited file's nodes, and their direct callers, as stale. | No parsing and no model calls. 5 s timeout. |
| Session start | `glassbox refresh --sync-md --no-claude-md`: re-parses changed files and rewrites the AGENTS.md block. | No model calls. 30 s timeout. |

Stale nodes are re-tagged the next time you run `glassbox index` or call the `refresh` tool with `tags: true`.

The hook script exits at once, without starting Node, in any of these cases:
- hooks are not turned on;
- the repo has no `.glassbox/graph.db`;
- `GLASSBOX_NESTED=1` is set. glassbox sets this on its own nested `claude -p` calls, so they never trigger hooks.

The script uses the plugin's own build (`dist/` in a built clone), then a global `glassbox` that resolves into the `@nilswidal/glassbox` package, then `npx`. It skips a `glassbox` binary from any other package, since the unscoped npm name belongs to someone else. With `npm install -g @nilswidal/glassbox` the hooks start fast. The hook script is POSIX `sh`, so on Windows it needs Git Bash or WSL.

## Run from a clone

Useful for development, or before the package is on npm:

```sh
git clone https://github.com/NilsWidal/glassbox && cd glassbox
npm install && npm run build
claude mcp add glassbox -e GLASSBOX_HOST=claude-code -- node "$PWD/dist/cli/index.js" mcp
```

To load the whole plugin (skill and hooks too) from the clone for one session, start Claude Code with `claude --plugin-dir /path/to/glassbox`. Its `.mcp.json` still starts the server with `npx`, so for local server changes use the `claude mcp add` line above as well.

Check the manifests with `claude plugin validate .` (it passes with `--strict`).
