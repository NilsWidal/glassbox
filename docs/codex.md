# glassbox in Codex

glassbox runs on the model you already use in Codex. When it needs an answer it calls `codex exec` with your existing ChatGPT or API login, so there is nothing extra to sign up for and no key to paste.

Three parts, each optional:

1. the **MCP server**, which gives Codex the seven tools (`ask`, `where`, `triage`, `decide`, `explain`, `graph`, `refresh`);
2. the **skill**, which teaches Codex when to use them and how to read the numbers;
3. the **AGENTS.md block**, a short summary of the codebase that Codex reads at the start of every session, optionally with concise answer rules.

## 1. Add the MCP server

The package is on npm as `@nilswidal/glassbox`. Pin the version, so an update only reaches you when you choose it:

```sh
codex mcp add glassbox --env GLASSBOX_HOST=codex -- npx -y @nilswidal/glassbox@0.3.1 mcp
```

Without npm, run the self-contained bundle that this repository commits in `plugin-dist/` (one file with every dependency, plus the tree-sitter `.wasm` files). It needs only Node 22.13 or newer:

```sh
git clone https://github.com/NilsWidal/glassbox
codex mcp add glassbox --env GLASSBOX_HOST=codex -- node "$PWD/glassbox/plugin-dist/glassbox.mjs" mcp
```

`GLASSBOX_HOST=codex` tells glassbox which agent started it. Codex gives MCP servers a trimmed environment, so glassbox cannot always tell on its own, and without the hint it would use whichever of `claude` or `codex` it finds on your PATH first.

Or edit `~/.codex/config.toml` (or `.codex/config.toml` in a project) by hand:

```toml
[mcp_servers.glassbox]
command = "npx"
args = ["-y", "@nilswidal/glassbox@0.3.1", "mcp"]
# Without npm: command = "node", args = ["/path/to/glassbox/plugin-dist/glassbox.mjs", "mcp"]
startup_timeout_sec = 30
# Each answer takes seconds, and `explain` makes several calls, so allow more than the 60 s default.
tool_timeout_sec = 300

[mcp_servers.glassbox.env]
GLASSBOX_HOST = "codex"
# Optional: a model id for the nested `codex exec` calls. Leave it out to use your Codex default.
# GLASSBOX_MODEL = "..."
```

Check it with `codex mcp list`. In a session, `/mcp` lists the glassbox tools.

**Local changes:** after editing the source in a clone, run `npm install && npm run bundle` to rebuild `plugin-dist/glassbox.mjs`, then restart Codex.

## 2. Install the skill

```sh
npx skills add NilsWidal/glassbox
```

This installs `skills/glassbox/SKILL.md`. Add `-a codex` to install it for Codex only, and `-g` to install it for your user instead of the current project. The skill covers:

- which tool fits which question;
- what `p`, confidence and the `act` / `confirm` / `escalate` bands mean;
- how to read highlights and their Δp values;
- that the agent should add its own one-line comment at each highlight when it passes a result on.

## 3. Index the repo and write AGENTS.md

With the `SessionStart` hook below, glassbox builds the code graph by itself in the background the first time Codex starts in a git repo without one (parsing only: no model calls, no `AGENTS.md` changes), and adds a short code map to later sessions. For tags and the AGENTS.md block, run the full init once. In the repository you want glassbox to know about:

```sh
npx -y @nilswidal/glassbox@0.3.1 init
```

(Without npm: `node /path/to/glassbox/plugin-dist/glassbox.mjs init`.) `init` parses the code into a graph of files and functions, asks a small set of tag questions about each one (handles auth, side effects, touches personal data, needs tests, area, risk) and stores the result in `.glassbox/`. That folder gets its own `.gitignore`, so it is not committed.

It then writes a managed block into `AGENTS.md`, which Codex reads automatically:

- The block sits between `<!-- glassbox:start -->` and `<!-- glassbox:end -->`. Text outside the markers is never changed.
- It is capped at about 60 lines, so it does not crowd the session's context.
- It lists the areas of the codebase and their entry points, the riskiest nodes, the tags you can query, and how to use the MCP tools.
- `init` also adds an `@AGENTS.md` line to `CLAUDE.md` (and creates that file if it is missing), so Claude Code reads the same block. Pass `--no-claude-md` if you only use Codex.

To bring the graph and the block up to date after changes:

```sh
node /path/to/glassbox/plugin-dist/glassbox.mjs refresh --sync-md   # re-parse changed files, rewrite the block, no model calls
node /path/to/glassbox/plugin-dist/glassbox.mjs index               # also re-ask tags for changed nodes (model calls)
```

The Claude Code plugin can do the first of these for you with opt-in hooks. In Codex, use the launcher below, the hooks in the next section, or run `refresh` yourself (for example from a git hook).

## Ambient mode in Codex

### The zero-setup path: AGENTS.md and the launcher

Codex reads `AGENTS.md` once at the start of each session, so the glassbox block is always in context without any hook. Two things keep it useful:

- **The launcher.** Start Codex through glassbox, and the graph and the block are brought up to date first when files changed (no model calls):

  ```sh
  node /path/to/glassbox/plugin-dist/glassbox.mjs run codex                       # interactive
  node /path/to/glassbox/plugin-dist/glassbox.mjs run --mode auto codex exec "fix the failing test"
  ```

  Everything after `codex` is passed to Codex untouched, as an argument list without a shell. The launcher also sets `GLASSBOX_HOST=codex` (and `GLASSBOX_MODE` with `--mode`) for the session, and may start the background re-tagging worker.
- **Concise answer rules.** Set `"conciseRules": true` in `.glassbox/config.json` (or `GLASSBOX_CONCISE_RULES=1`), and the block gets an `### Answer style` section: lead with the answer, cite `file:line` instead of pasting code, never paste unchanged code, one line per reason, no closing recap, one line on what was not checked. It is written the next time the block is (the launcher, `refresh --sync-md` or `sync-md`). It is the same text as the Claude Code output style `glassbox:concise`.

Two limits of AGENTS.md in Codex:
- Codex stops reading project docs at 32 KiB in total (`project_doc_max_bytes`). The glassbox block is at most 60 lines, but a very long AGENTS.md above it can push it out.
- In any directory, an `AGENTS.override.md` is read instead of `AGENTS.md`, which hides the glassbox block.

### Ambient mode hooks

Codex 0.154 has hooks (on by default), and `glassbox hook` speaks their format too: `prompt` prints `hookSpecificOutput.additionalContext` for `UserPromptSubmit`, and `stop` prints `{"decision":"block","reason":...}` for `Stop` or nothing. Pass `--host codex` so the gate asks `codex exec`. Turn the features on in `.glassbox/config.json` (`"ambient": {"enabled": true}`, `"gate": {"enabled": true}`) or with `GLASSBOX_AMBIENT=1` and `GLASSBOX_GATE=1`.

A `~/.codex/hooks.json` (or `.codex/hooks.json` in a trusted project) could look like this:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/glassbox/plugin-dist/glassbox.mjs hook prompt --host codex", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /path/to/glassbox/plugin-dist/glassbox.mjs hook stop --host codex", "timeout": 60 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node /path/to/glassbox/plugin-dist/glassbox.mjs hook post-edit --host codex", "timeout": 5 }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/glassbox/plugin-dist/glassbox.mjs hook session-start --host codex", "timeout": 30 }] }
    ]
  }
}
```

Things to know:

- **Trust.** Codex asks you to review and trust each hook in `/hooks`, and asks again whenever a hook's definition changes. Keep the command string stable.
- **Loops.** Codex turns a Stop block into a new prompt and documents no limit on repeated blocks. The gate guards itself: it does nothing when `stop_hook_active` is set, rates each diff once, and never blocks twice for the same hunk.
- **Auto-init.** `session-start` in a git repo without a graph starts `glassbox init --structure-only` in the background (at most 5,000 source files, `GLASSBOX_AUTO_INIT_MAX_FILES`; never in your home directory or `/`; a lock stops two sessions from indexing at once) and prints one line saying so. In a repo with a graph it prints a code map of at most about 1,500 characters as `additionalContext`. `GLASSBOX_AUTO_INIT=0` turns both off. It never writes `AGENTS.md`; tags come from `glassbox init`, or, with `GLASSBOX_HOOKS=1`, from the background worker within its daily budget, which on a large repo takes days. See [Auto-init in the reference](reference.md#auto-init).
- **Edits.** `post-edit` reads Codex `apply_patch` input (the `*** Update File:` headers) as well as Claude Code's `file_path`. It only acts with `GLASSBOX_HOOKS=1`.
- **`notify`.** Codex's `notify` setting is separate, fires only after a turn and cannot block. glassbox does not use or change it.
- **Not yet checked end to end.** These hooks have unit tests against the documented format, but have not yet been run in a real Codex session, and it is not yet known whether `codex exec` runs hooks you have not trusted in the interactive UI. The AGENTS.md path above is the one to rely on for now.

## How glassbox calls the model in Codex

- **The command.** Every question about one piece of code goes into a single `codex exec` call with an `--output-schema` file, so the answer is always one of the fixed labels.
- **Settings of the nested run.** It runs with `--sandbox read-only`, no MCP servers and no AGENTS.md, in an empty temporary directory. It keeps your configured reasoning effort unless you set `GLASSBOX_CODEX_EFFORT`.
- **No loops.** The nested run cannot call glassbox again. It also sets `GLASSBOX_NESTED=1`, so glassbox hooks never fire inside it.
- **The model.** glassbox passes no `-m`, so Codex uses the model you configured, unless you set `GLASSBOX_MODEL`. `glassbox status` shows it, read from `~/.codex/config.toml` (or `$CODEX_HOME`).
- **Speed.** Each call takes a few seconds, not milliseconds. glassbox makes up for it by batching questions and caching tags by content hash.
- **Other backends.** To use an API instead (for CI), set `GLASSBOX_BACKEND=anthropic` or `openai-compat` and the matching key in the server's `env`. See the README.

Checked with codex-cli 0.154.0: a `codex exec` session called the glassbox `graph` tool over MCP and returned its output.
