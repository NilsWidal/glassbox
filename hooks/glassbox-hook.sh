#!/bin/sh
# glassbox plugin hook: prompt | stop | post-edit | session-start.
# Claude Code runs it in exec form (no shell string): sh <this file> <event>.
# It exits 0 at once, without starting node, when:
#   - this is a nested glassbox model call (GLASSBOX_NESTED=1);
#   - post-edit only: neither GLASSBOX_HOOKS=1 nor the plugin's enable_hooks
#     option is on (GLASSBOX_HOOKS=0 turns it off);
#   - session-start only: auto-init is off (GLASSBOX_AUTO_INIT=0, or the
#     plugin's auto_init option off) and so are the edit hooks;
#   - prompt, stop and post-edit: the project has no glassbox graph
#     (.glassbox/graph.db). session-start runs without one, because that is
#     where auto-init starts building it (node checks for a git repo, the
#     file count and a lock, then starts the build in the background).
# prompt and stop can also be turned on in .glassbox/config.json, so node reads
# that and decides. The hook JSON on stdin goes straight to `glassbox hook`.
# Hooks never fail the turn: errors are swallowed and the exit code is always 0.
# A TERM, INT or HUP sent to this script is passed on to node.

event="$1"
[ "${GLASSBOX_NESTED:-}" = "1" ] && exit 0
hooks_on=0
case "${GLASSBOX_HOOKS:-${CLAUDE_PLUGIN_OPTION_ENABLE_HOOKS:-}}" in
  1 | true) hooks_on=1 ;;
esac
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$event" in
  prompt | stop)
    [ -f "$dir/.glassbox/graph.db" ] || exit 0
    ;;
  post-edit)
    [ "$hooks_on" = 1 ] || exit 0
    [ -f "$dir/.glassbox/graph.db" ] || exit 0
    ;;
  session-start)
    if [ "$hooks_on" != 1 ]; then
      case "${GLASSBOX_AUTO_INIT:-${CLAUDE_PLUGIN_OPTION_AUTO_INIT:-true}}" in
        0 | false | no | off) exit 0 ;;
      esac
    fi
    ;;
  *) exit 0 ;;
esac

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
