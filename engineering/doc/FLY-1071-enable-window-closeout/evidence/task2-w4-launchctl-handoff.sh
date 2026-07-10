#!/bin/bash
# FLY-1071 Task 2 — W4 (codex-infra-bot-lead) launchctl handoff script
# 背景:W4 crash-loop 根因 = ~/.codex-infra-bot auth 失效 (refresh_token_reused)。
# 修复顺序必须是:停 job → (runner 做 fresh login) → 拉起 job,
# 避免 KeepAlive 重启的 app-server 与 codex login 竞争写 ~/.codex-infra-bot。
# runner 被 FLY-913 护栏拦了 launchctl,按先例递交本脚本给 Tadashi 执行。
#
# 用法(两步,中间等 runner 报告 login 完成):
#   bash task2-w4-launchctl-handoff.sh stop    # 第一步:停 job(runner 随后做 fresh login)
#   bash task2-w4-launchctl-handoff.sh start   # 第二步:runner 报告 login OK 后再跑
#
# 本脚本只碰 com.flywheel.lead.flywheel-codex-infra-bot-lead 这一个 job,不碰 Bridge/其他 Lead。

set -euo pipefail

JOB_LABEL="com.flywheel.lead.flywheel-codex-infra-bot-lead"
PLIST="$HOME/Library/LaunchAgents/${JOB_LABEL}.plist"

case "${1:-}" in
  stop)
    echo "[handoff] bootout ${JOB_LABEL} ..."
    # 不加 || true:若被护栏/权限拒绝要让失败原样可见(Tadashi 抓的 bug)
    launchctl bootout "gui/$(id -u)/${JOB_LABEL}"
    sleep 2
    if launchctl print "gui/$(id -u)/${JOB_LABEL}" >/dev/null 2>&1; then
      echo "[handoff] FAIL: job still present after bootout"
      exit 1
    fi
    echo "[handoff] OK: job booted out at $(date '+%H:%M:%S'). Runner 可以开始 fresh login。"
    ;;
  start)
    echo "[handoff] bootstrap ${JOB_LABEL} ..."
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    sleep 3
    launchctl print "gui/$(id -u)/${JOB_LABEL}" | grep -E "state|pid" || true
    echo "[handoff] OK: job bootstrapped at $(date '+%H:%M:%S')。Runner 接手观察起满。"
    ;;
  *)
    echo "usage: $0 stop|start" >&2
    exit 2
    ;;
esac
