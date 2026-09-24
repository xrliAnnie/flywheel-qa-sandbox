#!/usr/bin/env bash
# FLY-2782 原型 1：Claude Code 会话级「退下 → 按 session id 拉起」实测
# 只做实验，不进生产路径。
#
# 用法：
#   ./claude-resume-probe.sh warm            # 新建会话 → 退出 → 立刻 resume（缓存热）
#   ./claude-resume-probe.sh cold <sid> <dir> # 冷 resume 一个已死会话（只读，fork，不污染原记录）
#
# 三个必须知道的坑（都实测踩过）：
#   1) --disallowed-tools 是变长参数，会把后面的位置参数 prompt 一起吞掉 → prompt 必须走 stdin。
#   2) resume 时换模型会在本地重建完（~60s）之后才在 API 侧报 "Prompt is too long"。
#      原会话跑在大窗口模型上时，必须用同窗口的模型 resume。
#   3) --fork-session 会写到一个新 session id，原始 transcript 不动 —— 做只读探测时必加。
set -euo pipefail
MODEL="${MODEL:-claude-haiku-4-5-20251001}"
OUT="${OUT:-$(pwd)/out}"; mkdir -p "$OUT"

run() { # run <label> <outfile> <args...>  ; prompt 从 stdin 进
  local label="$1"; shift; local out="$1"; shift
  local s e
  s=$(date +%s.%N)
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p --output-format json --model "$MODEL" "$@" > "$out" 2>"$out.err" || true
  e=$(date +%s.%N)
  printf '%-14s WALL=%.1fs  ' "$label" "$(echo "$e - $s" | bc)"
  python3 - "$out" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print('(no json)', open(sys.argv[1]+'.err').read()[:200]); raise SystemExit
u=d.get('usage',{})
print('local_rebuild=%sms ttft=%sms  cache_create=%s cache_read=%s  result=%r'
      % (d.get('time_to_request_ms'), d.get('ttft_ms'),
         u.get('cache_creation_input_tokens'), u.get('cache_read_input_tokens'),
         str(d.get('result'))[:80]))
PY
}

case "${1:-warm}" in
  warm)
    SID=$(uuidgen | tr 'A-Z' 'a-z')
    echo "session id = $SID"
    echo "记住一个口令：MOONGATE-4711。只回复 OK。" | run "R1 新建"   "$OUT/r1.json" --session-id "$SID"
    echo "刚才我让你记的口令是什么？只回口令本身。" | run "R2 热resume" "$OUT/r2.json" --resume "$SID"
    ;;
  cold)
    SID="${2:?需要 session id}"; DIR="${3:?需要原会话的 cwd}"
    cd "$DIR"
    echo "只凭已有对话回答，不要调用任何工具：这个会话在做哪个 FLY 单？最后完成的一件具体事是什么？两句话内。" \
      | run "冷resume" "$OUT/cold.json" --resume "$SID" --fork-session \
            --disallowed-tools "Bash,Edit,Write,NotebookEdit,Task,WebFetch,WebSearch"
    ;;
esac
