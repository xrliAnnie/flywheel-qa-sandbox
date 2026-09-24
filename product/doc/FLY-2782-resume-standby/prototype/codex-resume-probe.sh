#!/usr/bin/env bash
# FLY-2782 原型 2：Codex 会话级「退下 → 按 session id 拉起」实测
# 只做实验，不进生产路径。
#
# 用法：
#   ./codex-resume-probe.sh warm         # 新建 → 退出 → resume
#   ./codex-resume-probe.sh cold <sid>   # 冷 resume 一个已死 session（只读沙箱）
#
# 坑：
#   1) `codex exec resume ""`（空 id）不会报错，会静默新建一个全新 session。
#      我第一轮就是这么拿到「我不知道」的假阴性。取 id 必须从 rollout 文件名解析并核对。
#   2) codex resume 是**就地**写回同一个 rollout 文件，没有 fork 选项。
#   3) BSD find 不支持 `-newermt "-3 minutes"`，取最新 rollout 要用 stat 排序。
set -euo pipefail
MODEL="${MODEL:-gpt-5.6-sol}"

newest_sid() {
  find ~/.codex/sessions -name "rollout-*.jsonl" -print0 \
    | xargs -0 stat -f '%m %N' | sort -rn | head -1 | cut -d' ' -f2- \
    | xargs basename | sed -E 's/^rollout-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+-//; s/\.jsonl$//'
}

timed() { local label="$1"; shift; local s e
  s=$(date +%s.%N); "$@" >/tmp/cx.out 2>/tmp/cx.err || true; e=$(date +%s.%N)
  printf '%-14s WALL=%.1fs  tokens=%s  answer=%s\n' "$label" "$(echo "$e - $s"|bc)" \
    "$(grep -A1 'tokens used' /tmp/cx.err | tail -1 | tr -d ' ')" "$(tail -1 /tmp/cx.out)"
}

case "${1:-warm}" in
  warm)
    timed "R1 新建" codex exec --model "$MODEL" -c model_reasoning_effort=\"low\" --skip-git-repo-check \
      "记住一个口令：MOONGATE-4711。只回复 OK。"
    SID=$(newest_sid); echo "session id = $SID"
    timed "R2 resume" codex exec resume "$SID" --model "$MODEL" -c model_reasoning_effort=\"low\" --skip-git-repo-check \
      "刚才我让你记的口令是什么？只回口令本身。"
    ;;
  cold)
    SID="${2:?需要 session id}"
    timed "冷resume" codex exec resume "$SID" --model "$MODEL" -c model_reasoning_effort=\"low\" \
      -c sandbox_mode=\"read-only\" -c approval_policy=\"never\" --skip-git-repo-check \
      "只凭已有对话回答，不要调用任何工具：这个会话在做哪个 FLY 单？最后完成的一件具体事是什么？两句话内。"
    ;;
esac
