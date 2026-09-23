# glassbox in Codex

glassbox runs on the model you already use in Codex. When it needs an answer it calls `codex exec` with your existing ChatGPT or API login, so there is nothing extra to sign up for and no key to paste.

Three parts, each optional:

1. the **MCP server**, which gives Codex the seven tools (`ask`, `where`, `triage`, `decide`, `explain`, `graph`, `refresh`);
2. the **skill**, which teaches Codex when to use them and how to read the numbers;
3. the **AGENTS.md block**, a short summary of the codebase that Codex reads at the start of every session.

## 1. Add the MCP server

```sh
codex mcp add glassbox --env GLASSBOX_HOST=codex -- npx -y @nilswidal/glassbox mcp
```

`GLASSBOX_HOST=codex` tells glassbox which agent started it. Codex gives MCP servers a trimmed environment, so glassbox cannot always tell on its own, and without the hint it would use whichever of `claude` or `codex` it finds on your PATH first.

Or edit `~/.codex/config.toml` (or `.codex/config.toml` in a project) by hand:

```toml
[mcp_servers.glassbox]
command = "npx"
args = ["-y", "@nilswidal/glassbox", "mcp"]
# The first run downloads the package; later starts take under a second.
startup_timeout_sec = 30
# Each answer takes seconds, and `explain` makes several calls, so allow more than the 60 s default.
tool_timeout_sec = 300

[mcp_servers.glassbox.env]
GLASSBOX_HOST = "codex"
# Optional: a model id for the nested `codex exec` calls. Leave it out to use your Codex default.
# GLASSBOX_MODEL = "..."
```

Check it with `codex mcp list`. In a session, `/mcp` lists the glassbox tools.

**From a clone** (before the package is on npm, or to try local changes):

```sh
git clone https://github.com/NilsWidal/glassbox && cd glassbox
npm install && npm run build
codex mcp add glassbox --env GLASSBOX_HOST=codex -- node "$PWD/dist/cli/index.js" mcp
```

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

In the repository you want glassbox to know about:

```sh
npx -y @nilswidal/glassbox init
```

`init` parses the code into a graph of files and functions, asks a small set of tag questions about each one (handles auth, side effects, touches personal data, needs tests, area, risk) and stores the result in `.glassbox/`. Add `.glassbox/` to your `.gitignore`.

It then writes a managed block into `AGENTS.md`, which Codex reads automatically:

- The block sits between `<!-- glassbox:start -->` and `<!-- glassbox:end -->`. Text outside the markers is never changed.
- It is capped at about 60 lines, so it does not crowd the session's context.
- It lists the areas of the codebase and their entry points, the riskiest nodes, the tags you can query, and how to use the MCP tools.
- `init` also adds an `@AGENTS.md` line to `CLAUDE.md` (and creates that file if it is missing), so Claude Code reads the same block. Pass `--no-claude-md` if you only use Codex.

To bring the graph and the block up to date after changes:

```sh
npx -y @nilswidal/glassbox refresh --sync-md   # re-parse changed files, rewrite the block, no model calls
npx -y @nilswidal/glassbox index               # also re-ask tags for changed nodes (model calls)
```

The Claude Code plugin can do the first of these for you with opt-in hooks. This Codex setup has no such hooks, so run `refresh` or `index` yourself, or from a git hook.

## How glassbox calls the model in Codex

- **The command.** Every question about one piece of code goes into a single `codex exec` call with an `--output-schema` file, so the answer is always one of the fixed labels.
- **Settings of the nested run.** It runs with `--sandbox read-only`, low reasoning effort, no MCP servers and no AGENTS.md, in an empty temporary directory.
- **No loops.** The nested run cannot call glassbox again. It also sets `GLASSBOX_NESTED=1`, so glassbox hooks never fire inside it.
- **The model.** Your Codex default model is used unless you set `GLASSBOX_MODEL`.
- **Speed.** Each call takes a few seconds, not milliseconds. glassbox makes up for it by batching questions and caching tags by content hash.
- **Other backends.** To use an API instead (for CI), set `GLASSBOX_BACKEND=anthropic` or `openai-compat` and the matching key in the server's `env`. See the README.

Checked with codex-cli 0.154.0: a `codex exec` session called the glassbox `graph` tool over MCP and returned its output.
