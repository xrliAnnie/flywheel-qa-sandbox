#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
IDENTITY="$ROOT/.lead/claude-infra-bot-lead/identity.md"
failed=0

required=(
  "值守席位"
  "每条工单根消息都归你先看"
  "三个去向"
  "宁转勿吞"
  "永不自行 @Annie"
  "兜底 @Tadashi"
  "先发帖再记账"
  "记账 = 完成"
  "落账:待执行"
  "发帖前看 thread"
  "fetch_messages 失败不发帖"
  "一个 @"
  "handoff --to <leadId>"
  "owner 是 Codex bot 不 handoff"
  "已自动 RESOLVED 只 ack 不发帖"
  "旁路通报不回帖"
  "压力自述"
  "根因线"
  "alert-ticket outstanding"
  "--limit 25"
  "--since <cursor>"
  "只有该响应每条都已"
  "禁止游标先行"
  "newest-first"
  "25 条就是看得见的积压信号"
  "orphan_pane"
  "claude-infra-bot-lead 是唯一责任席位"
  "不要求任何 Department Lead 扫全机"
  "Bridge orphan sweeper"
)
for phrase in "${required[@]}"; do
  if ! grep -qF -- "$phrase" "$IDENTITY"; then
    echo "missing required identity contract: $phrase" >&2
    failed=1
  fi
done

forbidden=(
  "只响应:① Alerts 里显式 @你"
  "没被 @ 的工单你不动手"
  "修不掉才 @Annie"
  "先 ack 再发帖"
  "账本:<回执"
  "--to <@"
)
for phrase in "${forbidden[@]}"; do
  if grep -qF -- "$phrase" "$IDENTITY"; then
    echo "forbidden legacy identity contract remains: $phrase" >&2
    failed=1
  fi
done

extract_case() {
  local number="$1"
  sed -n "/FLY2076_CASE_${number}_START/,/FLY2076_CASE_${number}_END/p" "$IDENTITY"
}
for number in 2 3; do
  block="$(extract_case "$number")"
  mentions="$(grep -o '<@[^>]*>' <<<"$block" | wc -l | tr -d ' ')"
  last_payload="$(grep -vE '^<!--|^$|^```' <<<"$block" | tail -1)"
  if [ "$mentions" != 1 ] || [[ "$last_payload" != *"handoff --to <leadId>"* ]]; then
    echo "case $number must contain exactly one Discord mention and end with roster-id handoff" >&2
    failed=1
  fi
done

if [ "$failed" -eq 0 ]; then
  echo "[TEST] fly2076 identity sentinel ✓"
fi
exit "$failed"
