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
| Hooks | `hooks/hooks.json` | Opt-in. Graph context before each prompt, an end-of-turn risk check, and keeping the graph and the AGENTS.md block fresh while you work. |
| Output style | `output-styles/concise.md` | Opt-in. Rules meant to shorten replies: cite `file:line` instead of pasting code. Not yet measured. |
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
| `mode` | `balanced` | Default mode for `ask`, `where`, `triage` and `decide`: `fast`, `balanced`, `explained`, `strict` or `auto` (see the README's Modes section). `GLASSBOX_MODE` and `.glassbox/config.json` override it. |
| `ambient` | off | Adds graph context to each prompt about code. See [Ambient mode](#ambient-mode). `GLASSBOX_AMBIENT` and `.glassbox/config.json` override it. |
| `gate` | off | Checks the turn's diff before Claude finishes. See [Ambient mode](#ambient-mode). `GLASSBOX_GATE` and `.glassbox/config.json` override it. |
| `concise_rules` | off | Adds the concise answer rules to the AGENTS.md block, for Codex and other agents. `GLASSBOX_CONCISE_RULES` and `.glassbox/config.json` override it. In Claude Code itself, use the output style instead. |
| `enable_hooks` | off | Turns on the graph-refresh hooks (after edits and at session start). |
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

## Ambient mode

All four hooks are in `hooks/hooks.json` and all are off until you turn them on. Each needs a repo where you ran `glassbox init`.

| Event | Switch | What runs | Cost |
|---|---|---|---|
| Before each prompt (`UserPromptSubmit`) | `ambient` | `glassbox hook prompt`: for a prompt about code, adds up to about 1,500 characters of matching `file:line` locations, tags and callers from the graph as extra context. Nothing for chat, or when no node matches well. | No model call. About 100 ms. 5 s timeout. |
| End of a turn (`Stop`) | `gate` | `glassbox hook stop`: when the working diff changed since the last check, rates it with `triage` in `fast` mode. If a hunk is High risk with high confidence (`act` band), Claude gets one short request to check those lines before finishing. | One `claude -p` run per new diff, usually 5 to 15 s. Gives up after 45 s (never more than 50 s) and stops the `claude -p` process tree. 60 s hook timeout. |
| After `Edit`, `Write` or `MultiEdit` (`PostToolUse`) | `enable_hooks` | `glassbox hook post-edit`: marks the edited file's nodes, and their direct callers, as stale, and may start the background re-tagging worker. | No parsing and no model call in the hook. 5 s timeout. |
| Session start | `enable_hooks` | `glassbox hook session-start`: re-parses changed files and rewrites the AGENTS.md block. | No model call. 30 s timeout. |

For each switch the first one set wins: the environment variable (`GLASSBOX_AMBIENT`, `GLASSBOX_GATE`, `GLASSBOX_HOOKS`, `1` or `0`), then `.glassbox/config.json` (`"ambient": {"enabled": true}`, `"gate": {"enabled": true}`; not for `enable_hooks`), then the plugin setting.

**How the gate avoids loops.** It blocks at most once per turn: when Claude continues because of a Stop hook, Claude Code marks the next Stop with `stop_hook_active`, and the gate then does nothing. It also rates each diff only once (by hash, recorded before the check), and it does not block again for a hunk it already flagged in an earlier turn. A timeout or any error lets the turn end normally. The last outcome is in `.glassbox/gate.json`. The README explains [what makes it block](../README.md#end-of-turn-gate).

**What you see.** With `claude -p --output-format json`, a blocked stop adds one turn (`num_turns` goes up by 1), and `result` holds only Claude's final message, written after it checked the flagged lines.

**Checked end to end** with Claude Code 2.1.280, `claude -p --plugin-dir <this repo>` in a copy of the sample repo:
- the `UserPromptSubmit` hook returned graph context for a prompt about session expiry, and Claude answered from it without any tool calls;
- the `Stop` hook rated the diff after Claude edited `verifySession` with the real `claude-cli` backend, and let the turn end (`pass`) in both agent runs;
- run directly on the same diff that deleted the expiry check, the stop hook blocked once (High, p=0.95) and passed once. The gate is near its threshold on this kind of change; see the README.

### The hook script

Each hook runs `sh ${CLAUDE_PLUGIN_ROOT}/hooks/glassbox-hook.sh <event>` in exec form (an argument list, no shell string). The script exits at once, without starting Node, when:
- `GLASSBOX_NESTED=1` is set. glassbox sets this on its own nested `claude -p` calls, so they never trigger hooks;
- the repo has no `.glassbox/graph.db`;
- for `post-edit` and `session-start`, `enable_hooks` (or `GLASSBOX_HOOKS=1`) is off.

`prompt` and `stop` can be turned on in `.glassbox/config.json`, so for those the script starts Node, which reads the config and returns at once when the switch is off. The script passes the hook JSON on stdin, passes a stop signal from Claude Code on to Node (so the gate ends its `claude -p` processes), discards errors and always exits 0.

It runs only the plugin's own bundle, `node ${CLAUDE_PLUGIN_ROOT}/plugin-dist/glassbox.mjs`. It never falls back to `npx` or to a `glassbox` binary on your PATH, and does nothing if the bundle is missing. The script is POSIX `sh`, so on Windows it needs Git Bash or WSL.

## Concise output style

The plugin ships `output-styles/concise.md`. Claude Code names plugin styles `<plugin>:<name>`, so it is `glassbox:concise`. It is off until you select it:

- `/output-style glassbox:concise` (this writes `.claude/settings.local.json` in the project), or `/config` > Output style;
- `"outputStyle": "glassbox:concise"` in a settings file (the name must match exactly);
- for one run: `claude --settings '{"outputStyle":"glassbox:concise"}' ...`.

The style keeps Claude Code's coding instructions and changes only how replies read: answer first, `file:line` instead of pasted code, no unchanged code, one line per reason, no closing recap. A new style applies from the next message. The plugin does not force it on.

## Run from a clone

The committed bundle runs straight from a clone, with no `npm install`:

```sh
git clone https://github.com/NilsWidal/glassbox && cd glassbox
claude mcp add glassbox -e GLASSBOX_HOST=claude-code -- node "$PWD/plugin-dist/glassbox.mjs" mcp
```

To load the whole plugin (skill, hooks and output style too) from the clone for one session, start Claude Code with `claude --plugin-dir /path/to/glassbox`. It runs the clone's `plugin-dist/glassbox.mjs`. After changing the source, run `npm install && npm run bundle` so the bundle picks the change up.

Check the manifests with `claude plugin validate .` (it passes with `--strict`).
