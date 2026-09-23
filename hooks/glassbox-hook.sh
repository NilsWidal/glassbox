#!/bin/sh
# glassbox plugin hook: prompt | stop | post-edit | session-start.
# Claude Code runs it in exec form (no shell string): sh <this file> <event>.
# It exits 0 at once, without starting node, when:
#   - this is a nested glassbox model call (GLASSBOX_NESTED=1);
#   - the project has no glassbox graph (.glassbox/graph.db, made by `glassbox init`);
#   - post-edit and session-start only: neither GLASSBOX_HOOKS=1 nor the plugin's
#     enable_hooks option is on (GLASSBOX_HOOKS=0 turns them off).
# prompt and stop can also be turned on in .glassbox/config.json, so node reads
# that and decides. The hook JSON on stdin goes straight to `glassbox hook`.
# Hooks never fail the turn: errors are swallowed and the exit code is always 0.
# A TERM, INT or HUP sent to this script is passed on to node.

event="$1"
[ "${GLASSBOX_NESTED:-}" = "1" ] && exit 0
case "$event" in
  prompt | stop) ;;
  post-edit | session-start)
    case "${GLASSBOX_HOOKS:-${CLAUDE_PLUGIN_OPTION_ENABLE_HOOKS:-}}" in
      1 | true) ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$dir/.glassbox/graph.db" ] || exit 0

# Runner: the plugin's own committed bundle, and nothing else. Nothing is
# fetched from npm or taken from PATH, so what runs is always the code in this
# plugin checkout.
bundle="${CLAUDE_PLUGIN_ROOT:-}/plugin-dist/glassbox.mjs"
[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$bundle" ] || exit 0

# node runs as a child with stdin passed on explicitly, so that a stop signal from
# the host (on its hook timeout) can be forwarded: the Stop gate then ends its
# model calls and their processes instead of leaving them running.
# Some shells (dash) point a background job's stdin at /dev/null, so hand node
# the hook JSON through fd 3 instead.
exec 3<&0
node "$bundle" hook "$event" --host claude-code --root "$dir" <&3 3<&- 2>/dev/null &
exec 3<&-
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT HUP
wait "$pid"
# A trapped signal ends the first wait early; wait again for node to finish.
wait "$pid" 2>/dev/null
exit 0
