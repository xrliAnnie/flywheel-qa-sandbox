#!/bin/bash
# Creates stub bin dir: gh, git wrapper, and flywheel-comm stub JS. Usage: stubs.sh <dir> <realgit>
set -e
D=$1
mkdir -p "$D/bin"
REALGIT=$(command -v git)
cat > "$D/bin/git" <<EOF
#!/bin/bash
if [ "\$1" = remote ] && [ "\$2" = get-url ] && [ "\$3" = origin ]; then echo https://github.com/xrliAnnie/flywheel-qa-sandbox.git; exit 0; fi
if [ -n "\$GIT_SHOW_FAIL" ] && [ "\$1" = show ]; then exit 128; fi
exec $REALGIT "\$@"
EOF
chmod +x "$D/bin/git"
cat > "$D/bin/gh" <<'EOF'
#!/bin/bash
# state: $STATE/pr = "num|STATE|title|base"
S="$STATE/pr"
log() { echo "gh $*" >> "$STATE/gh.log"; }
log "$@"
sub="$1 $2"; shift 2
get() { local k=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$k" ] && { echo "$2"; return; }; shift; done; }
case "$sub" in
  "pr list")
    st=$(get --state "$@"); jq=$(get --jq "$@")
    [ -f "$S" ] || exit 0
    IFS='|' read -r num state title base < "$S"
    if [ "$st" = open ]; then [ "$state" = OPEN ] && echo "$num"; else echo "$num $state"; fi ;;
  "pr create")
    [ -n "$GH_CREATE_FAIL" ] && exit 1
    echo "101|OPEN|$(get --title "$@")|$(get --base "$@")" > "$S"; echo https://github.com/x/pull/101 ;;
  "pr edit")
    IFS='|' read -r num state title base < "$S"; echo "$num|$state|$(get --title "$@")|$base" > "$S" ;;
  "pr view")
    js=$(get --json "$@"); IFS='|' read -r num state title base < "$S"
    case "$js" in
      title,baseRefName) echo "$title|$base" ;;
      title) echo "$title" ;;
      headRefOid) git --git-dir="$STATE/origin.git" rev-parse "refs/heads/project-slot-2-FLY-3033" ;;
      statusCheckRollup) echo 1 ;;
    esac ;;
  "pr checks") exit "${CHECKS_RC:-0}" ;;
  *) echo "gh stub: unknown $sub" >&2; exit 2 ;;
esac
EOF
chmod +x "$D/bin/gh"
cat > "$D/comm.cjs" <<'EOF'
const {execFileSync} = require('child_process'); const fs = require('fs');
const a = process.argv.slice(2); const S = process.env.STATE;
fs.appendFileSync(S + '/comm.log', a.join(' ') + '\n');
const get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
if (a[0] === 'turn') { console.log((process.env.TURN || 'yours') + ' phase=implement epoch=1'); process.exit(0); }
if (a[0] === 'progress') {
  const f = get('--file'); fs.writeFileSync(f, `---\nphase: ${get('--phase')}\nphaseCursor: ${get('--cursor')}\nupdated: ${new Date().toISOString()}${Math.random()}\nnextStep: "${get('--next')}"\n---\n`);
  execFileSync('git', ['add', '--', f]); execFileSync('git', ['commit', '-q', '--only', '-m', `chore(progress): FLY-3033 ${get('--phase')} ${get('--cursor')}`, '--', f]);
  process.exit(0);
}
if (a[0] === 'ask') process.exit(Number(process.env.ASK_RC || 0));
if (a[0] === 'complete') process.exit(Number(process.env.COMPLETE_RC || 0));
process.exit(0);
EOF
