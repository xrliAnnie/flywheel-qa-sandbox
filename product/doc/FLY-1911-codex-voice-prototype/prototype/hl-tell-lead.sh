#!/bin/zsh
# 分身用这个联系 Honey Lemon 本人(FLY-1911 实验 A)。
#
# ⭐ 它不限制你能说什么。它只决定你说的话**能不能被盖「已核」的章**:
#   · 可以重查的事(runner 状态 / PR / 仓库)⇒ 加 --check <名字>,**我们这一侧自己去跑那条查询**再核对
#   · 其它的话(她说了什么、这场会开了多久)⇒ 照发,但会标成「它说的,未核」
#   ⛔ 你给不了命令,只能给名字 —— 命令由我们这边固定写死。
#
# 用法:
#   hl-tell-lead.sh --check runners '……'     # 我们会自己查 runner 状态,核对你话里的编号/数字
#   hl-tell-lead.sh '……'                     # 照发,标「未核」
# 名字目前只有: runners(哪些 runner 会话活着) · prs(未合并的 PR) · head(主仓最新一次提交)
set -u
CHECK=""
if [[ "${1:-}" == "--check" ]]; then CHECK="${2:-}"; shift 2; fi
MSG="${1:-}"
[[ -z "$MSG" ]] && { print -u2 "用法:hl-tell-lead.sh [--check runners|prs|head] '要说的话'"; exit 2 }
DIR="$HOME/.fly1911/outbox"; BEAT="$DIR/.relay-alive"
mkdir -p "$DIR" 2>/dev/null
[[ -f "$BEAT" ]] || { print -u2 "⛔ 中继没在跑(没有心跳文件)。这条**发不出去**,别跟她说你告诉过 Honey Lemon 了。"; exit 3 }
AGE=$(( $(date +%s) - $(stat -f %m "$BEAT") ))
(( AGE > 20 )) && { print -u2 "⛔ 中继看起来死了(心跳 ${AGE} 秒没更新)。这条**发不出去**,别跟她说你告诉过 Honey Lemon 了。"; exit 3 }

ID="$(date -u +%Y%m%dT%H%M%S)-$$"
{ [[ -n "$CHECK" ]] && print -r -- "CHECK: $CHECK"; print -r -- "---"; print -r -- "$MSG" } > "$DIR/$ID.msg"
print "已写入待发队列($ID),等回执…"
for i in {1..25}; do
  [[ -f "$DIR/$ID.receipt" ]] && { print "回执:"; cat "$DIR/$ID.receipt"
    grep -q '"送出": true' "$DIR/$ID.receipt" && { print "⚠️ 回执只说明中继把它交给了投递系统,**不等于 Honey Lemon 已经看到**。"
      grep -q '"核对": "不符"' "$DIR/$ID.receipt" && print -u2 "⚠️ 而且核对结果是【不符】:我们自己查出来的和你说的对不上,消息已按原样送出并标注。"
      exit 0 }
    print -u2 "⛔ 回执说没送出去。别跟她说你告诉过 Honey Lemon 了。"; exit 4 }
  sleep 1
done
print -u2 "⛔ 等了 25 秒没有回执 —— **没确认送出**。⛔ 不许说「我已经告诉 Honey Lemon 了」,如实说没确认送到。"
exit 5
