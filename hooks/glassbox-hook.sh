#!/bin/sh
# glassbox plugin hook: post-edit | session-start.
# Opt-in. Exits 0 at once, without starting node, unless all of these hold:
#   - GLASSBOX_HOOKS=1, or the plugin's enable_hooks option is on (GLASSBOX_HOOKS=0 turns it off);
#   - this is not a nested glassbox model call (GLASSBOX_NESTED=1);
#   - the project has a glassbox graph (.glassbox/graph.db, made by `glassbox init`).
# Hooks never fail the tool call: every error is swallowed.

event="$1"
[ "${GLASSBOX_NESTED:-}" = "1" ] && exit 0
case "${GLASSBOX_HOOKS:-${CLAUDE_PLUGIN_OPTION_ENABLE_HOOKS:-}}" in
  1 | true) ;;
  *) exit 0 ;;
esac
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$dir/.glassbox/graph.db" ] || exit 0

# Runner: the plugin's own build first, then a global install that really is
# this package, then npx. The unscoped npm name `glassbox` belongs to someone
# else, so a PATH binary is used only when it resolves into @nilswidal/glassbox
# (checked without running it).
own_bin() {
  p=$(command -v glassbox 2>/dev/null) || return 1
  real=$(node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$p" 2>/dev/null) || return 1
  case "$real" in */@nilswidal/glassbox/*) return 0 ;; *) return 1 ;; esac
}
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/dist/cli/index.js" ]; then
  set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli/index.js"
elif own_bin; then
  set -- glassbox
else
  set -- npx -y @nilswidal/glassbox
fi

case "$event" in
  post-edit)
    # The hook input is JSON on stdin; take tool_input.file_path.
    file=$(node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const p=JSON.parse(s).tool_input?.file_path;if(typeof p==="string")process.stdout.write(p)}catch{}})' 2>/dev/null)
    [ -n "$file" ] || exit 0
    # --files=<path> so a name starting with "-" is never read as a flag.
    "$@" refresh --root "$dir" --files="$file" --quiet >/dev/null 2>&1
    ;;
  session-start)
    "$@" refresh --root "$dir" --sync-md --no-claude-md --quiet >/dev/null 2>&1
    ;;
esac
exit 0
