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
| MCP server | `.mcp.json` | Starts `node ${CLAUDE_PLUGIN_ROOT}/plugin-dist/glassbox.mjs mcp`, which provides the tools `ask`, `where`, `triage`, `decide`, `explain`, `graph` and `refresh`. |
| Skill | `skills/glassbox/SKILL.md` | Teaches Claude when to use each tool and how to read `p`, confidence, bands and highlights. |
| Hooks | `hooks/hooks.json` | Opt-in. Keep the graph and the AGENTS.md block fresh while you work. |
| Settings | `.claude-plugin/plugin.json` | The options below. |

**Why a committed bundle.** A marketplace install is a plain copy of this git repository: nobody runs `npm install` in it, so there is no `node_modules` and no built `dist/` folder. The repository therefore commits `plugin-dist/`, made by `npm run bundle`:

- `glassbox.mjs`, one file that holds glassbox and all of its dependencies and needs only Node;
- the tree-sitter `.wasm` files it parses code with (TypeScript, TSX, JavaScript, Python, and the runtime).

The plugin runs that file with `node`. Nothing is downloaded from npm when it starts, so what runs is exactly the code in the commit you installed. CI rebuilds the bundle on every push and fails if the committed copy is out of date (`npm run bundle:check`).

The plugin needs Node 22.13 or newer on your PATH (for the built-in `node:sqlite` module that holds the code graph).

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

How these settings combine with environment variables you set yourself:

- **`backend`, `model`, `openai_base_url`, `openai_api_key`**: a `GLASSBOX_BACKEND`, `GLASSBOX_MODEL`, `GLASSBOX_OPENAI_BASE_URL` or `GLASSBOX_OPENAI_API_KEY` in your environment wins over the setting. The setting fills the variable only when it is unset or empty.
- **`anthropic_api_key`**: the setting becomes `GLASSBOX_ANTHROPIC_API_KEY` (unless you set that variable yourself). The `anthropic` backend reads `GLASSBOX_ANTHROPIC_API_KEY` first, so the setting wins over an `ANTHROPIC_API_KEY` in your environment. The same goes for the OpenAI-compatible settings and the plain `OPENAI_API_KEY` and `OPENAI_BASE_URL` variables: the `GLASSBOX_*` names come first.
- **`backend` left at `auto`**: the plugin's `.mcp.json` sets `GLASSBOX_HOST=claude-code`, so `auto` means `claude-cli`. An explicit backend (from the setting or from `GLASSBOX_BACKEND`) is never overridden.

## Index the repo

The graph tools work without it: on first use they build the code graph, without tags. For tags and the AGENTS.md summary, run `init` once in the repository with the same bundle the plugin uses (from a clone of this repository, or the plugin's own copy):

```sh
node /path/to/glassbox/plugin-dist/glassbox.mjs init
```

Once the package is published on npm, `npx -y @nilswidal/glassbox init` does the same.

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

The script runs only the plugin's own bundle, `node ${CLAUDE_PLUGIN_ROOT}/plugin-dist/glassbox.mjs`. It never falls back to `npx` or to a `glassbox` binary on your PATH, and does nothing if the bundle is missing. The hook script is POSIX `sh`, so on Windows it needs Git Bash or WSL.

## Run from a clone

The committed bundle runs straight from a clone, with no `npm install`:

```sh
git clone https://github.com/NilsWidal/glassbox && cd glassbox
claude mcp add glassbox -e GLASSBOX_HOST=claude-code -- node "$PWD/plugin-dist/glassbox.mjs" mcp
```

To load the whole plugin (skill and hooks too) from the clone for one session, start Claude Code with `claude --plugin-dir /path/to/glassbox`. It runs the clone's `plugin-dist/glassbox.mjs`. After changing the source, run `npm install && npm run bundle` so the bundle picks the change up.

Check the manifests with `claude plugin validate .` (it passes with `--strict`).
