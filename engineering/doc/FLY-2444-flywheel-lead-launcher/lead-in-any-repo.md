# FLY-2444 任意仓起一个 Lead — 一页文档
Issue: FLY-2444 (https://linear.app/geoforge3d/issue/FLY-2444/产品-任意仓起一个-lead最小闭环flywheel-lead-launcherclaude-codex-注册一行-一页文档raya)
日期: 2026-09-08
基于: plan.md

本页是 macOS launchd 最小闭环。先 `cd` 到要接入的项目仓根目录，并只在下列六处填真实值；后文不再出现新占位符。

```bash
set -euo pipefail
export FW_PROJECT='<project>'
export FW_LEAD_ID='<lead-id>'
export FW_CHANNEL_ID='<channel-id>'
export FW_BOT_USER_ID='<bot-user-id>'
export FW_TOKEN_ENV='<BOT_TOKEN_ENV>'
export FW_MESSAGE_ID='<snowflake>'
export FW_PROJECT_ROOT="$PWD"
```

成功判据：`printf '%s\n' "$FW_PROJECT/$FW_LEAD_ID"` 只打印目标项目和 Lead；`test "$FW_PROJECT_ROOT" = "$(pwd -P)"` 退出 0。

## 1. 装

安装 Flywheel，不 clone flywheel 仓：

```bash
npx @flywheel-ai/onboard
```

引导完成后加载已安装 runtime 的固定路径：

```bash
. "$HOME/.flywheel/bin/lib/host-config.sh"
host_config_load
set -a; . "$HOME/.flywheel/.env"; set +a
export FW_BRIDGE_URL="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}"
export FW_LEAD="$HOME/.flywheel/bin/flywheel-lead.sh"
export FW_PROJECTS="$HOME/.flywheel/projects.json"
export FW_RECEIPT="$HOME/.flywheel/state/summary-registry/migration-receipt.json"
export FW_MANIFEST="$HOME/.flywheel/manifests/${FW_PROJECT}-${FW_LEAD_ID}.json"
export FW_LABEL="com.flywheel.lead.${FW_PROJECT}-${FW_LEAD_ID}"
export FW_LOG="$HOME/.flywheel/logs/lead-${FW_PROJECT}-${FW_LEAD_ID}.log"
test -x "$FW_LEAD" && test -f "$FLYWHEEL_DIR/.flywheel-prebuilt"
```

成功判据：最后一条退出 0；launcher 必须来自已安装 runtime。

逐项核对公共前置：

```bash
curl -fsS --max-time 5 "${FW_BRIDGE_URL%/}/health" | jq -e '.ok == true and (.buildSha | type == "string" and length > 0)'
grep -Ec "^${FW_TOKEN_ENV}=.+$" "$HOME/.flywheel/.env" | grep -Fx 1
grep -Ec '^TEAMLEAD_API_TOKEN=.+$' "$HOME/.flywheel/.env" | grep -Fx 1
test -f "$FW_PROJECT_ROOT/.lead/$FW_LEAD_ID/identity.md" && test ! -L "$FW_PROJECT_ROOT/.lead/$FW_LEAD_ID/identity.md"
jq -er '.granularity | select(. == "per-lead")' "$HOME/.flywheel/summary-config.json"
```

成功判据依次是：health JSON 为 `ok:true` 且有 `buildSha`；两个 `grep` 都打印 `1`；identity 文件为非符号链接普通文件；最后一条打印 `per-lead`。任一失败即停止，不注册。

Claude 只执行这组：

```bash
export FW_HARNESS=claude
claude --version
"$HOME/.flywheel/bin/check-discord-plugin.sh"
```

成功判据：第一条打印 Claude 版本；checker 退出 0。checker/updater 缺失时停止，先完成受管 Discord 插件安装；不要绕过 preflight。

**已知边界（硬停止线）**：纯 npm 外仓安装目前不携带 Claude Discord 插件运维资产；完整产品化闭包属于 FLY-1835 / FLY-2388 线，不在本单中暗装。只有机器上已有获授权的 Flywheel 主仓 checkout 时，才可执行 `cd "$HOME/Dev/flywheel" && bash scripts/install-discord-plugin-ops.sh`；成功判据是随后 `"$HOME/.flywheel/bin/check-discord-plugin.sh"` 退出 0。没有该 checkout 的纯外仓 Claude Lead 必须停在 preflight，不能声称已打通。Codex 路径不依赖这两个插件脚本。

Codex 只执行这组。登录动作由 founder 本人在当前终端完成，不复制别的 Codex home 的 `auth.json`：

```bash
export FW_HARNESS=codex
install -d -m 700 "$HOME/.codex-$FW_LEAD_ID"
CODEX_HOME="$HOME/.codex-$FW_LEAD_ID" codex login
CODEX_HOME="$HOME/.codex-$FW_LEAD_ID" CODEX_INSTALL_DIR="$HOME/.codex-$FW_LEAD_ID/.local/bin" sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
test -f "$HOME/.codex-$FW_LEAD_ID/auth.json" && test ! -L "$HOME/.codex-$FW_LEAD_ID/auth.json"
"$HOME/.codex-$FW_LEAD_ID/packages/standalone/current/codex" --version
```

成功判据：`auth.json` 检查退出 0，最后一条打印 standalone Codex 版本。这是 FLY-2259 §4.0.2 的通用化同形，Codex home key 固定为 Lead id。

## 2. 注册

下面一条命令同时追加 registry 行、重铸并校验 per-lead summary receipt、物化 manifest；不要手改 `projects.json`：

```bash
"$FW_LEAD" register \
  --project-name "$FW_PROJECT" \
  --project-root "$FW_PROJECT_ROOT" \
  --lead-id "$FW_LEAD_ID" \
  --chat-channel "$FW_CHANNEL_ID" \
  --bot-token-env "$FW_TOKEN_ENV" \
  --bot-user-id "$FW_BOT_USER_ID" \
  --harness "$FW_HARNESS" \
  --summary-role recipient \
  --can-spawn-runners false \
  | tee "$HOME/.flywheel/state/${FW_PROJECT}-${FW_LEAD_ID}-register.jsonl"
```

成功判据：

```bash
grep -F '"effectiveAt":"next-bridge-restart"' "$HOME/.flywheel/state/${FW_PROJECT}-${FW_LEAD_ID}-register.jsonl"
jq -e --arg p "$FW_PROJECT" --arg l "$FW_LEAD_ID" '[.[] | select(.projectName == $p) | .leads[] | select(.agentId == $l)] | length == 1' "$FW_PROJECTS"
node "$FLYWHEEL_DIR/packages/flywheel-comm/dist/index.js" summary-registry verify-activation --projects-file "$FW_PROJECTS" --receipt-file "$FW_RECEIPT" | jq -e '.ok == true'
test -f "$FW_MANIFEST" && test ! -L "$FW_MANIFEST"
```

四条都必须退出 0。注册对 Bridge 的生效点是下一次 Bridge 重启：只等 00:00 / 12:00 PT 班车，或走 founder 明确批准的变更票；本手册不授权手动重启 Bridge。

## 3. 起

先做零写 preflight，再安装唯一 launchd job：

```bash
"$FW_LEAD" preflight "$FW_MANIFEST" | tee "$HOME/.flywheel/state/${FW_PROJECT}-${FW_LEAD_ID}-preflight.log"
grep -F "PASS preflight complete for ${FW_PROJECT}/${FW_LEAD_ID}" "$HOME/.flywheel/state/${FW_PROJECT}-${FW_LEAD_ID}-preflight.log"
"$FW_LEAD" install --project "$FW_PROJECT" --lead "$FW_LEAD_ID"
launchctl print "gui/$(id -u)/$FW_LABEL" | grep -E '^[[:space:]]*state = running[[:space:]]*$'
```

成功判据：preflight 只出现 `PASS` 且有最终完成行；install 打印 `installed`；launchctl 恰有一行 `state = running`。再核对所选 harness 的出生日志：

```bash
grep -E "tui-window: real TUI up \(${FW_PROJECT}-${FW_LEAD_ID}|\[lead\].*Comm DB:" "$FW_LOG"
```

成功判据：Codex 命中 `tui-window: real TUI up`，Claude 命中 `[lead] ... Comm DB:`。

## 4. 验

等 Bridge 完成获批重启后，先证明注册、泵、唯一进程与 inbox 八跳：

```bash
"$FW_LEAD" verify --stage live "$FW_MANIFEST" | tee "$HOME/.flywheel/state/${FW_PROJECT}-${FW_LEAD_ID}-live.log"
test "$(grep -Ec '^PASS #[1-8] ' "$HOME/.flywheel/state/${FW_PROJECT}-${FW_LEAD_ID}-live.log")" -eq 8
```

成功判据：恰有 #1–#8 八行 PASS。#6 若报 `Bridge has not restarted`，说明注册已成功但泵尚未挂载，继续等获批重启，不重复注册。

现在在该 Lead 的 Discord 频道发送一句 `flywheel mailbox probe`，复制这条入站消息的 snowflake 到开头的 `FW_MESSAGE_ID`，再跑：

```bash
"$FW_LEAD" verify --stage live --message-id "$FW_MESSAGE_ID" "$FW_MANIFEST" | tee "$HOME/.flywheel/state/${FW_PROJECT}-${FW_LEAD_ID}-message.log"
grep -E '^PASS #9 mailbox state=ACKED .*delivery_id=chat:' "$HOME/.flywheel/state/${FW_PROJECT}-${FW_LEAD_ID}-message.log"
```

成功判据：#9 明确打印 `state=ACKED`、`delivered_at` 与 `delivery_id`，证明入站已写 mailbox 并被泵投递。Codex 还必须出现 #10 PASS，证明同一轮回复经 Lead journal/outbox 和 Bridge dedup 出站；`SKIP #10 pending FLY-2442` **不算验收通过**。Claude 在 #9 后成功退出即完成它的 mailbox 路径证明。

cross-dept 频道现在必须留空；只有 FLY-2442 合入并另有授权后才允许配置。

### 恢复、停用与人工注销

注册进程若在两次原子写之间崩溃，先运行：

```bash
"$FW_LEAD" recover | tee "$HOME/.flywheel/state/${FW_PROJECT}-${FW_LEAD_ID}-recover.json"
```

成功判据：输出 JSON 为 `ok:true`；随后重跑同一条 register 命令，continuation 不会重复追加。

只停进程、不删注册行：

```bash
"$FW_LEAD" stop --project "$FW_PROJECT" --lead "$FW_LEAD_ID"
! launchctl print "gui/$(id -u)/$FW_LABEL" >/dev/null 2>&1
```

成功判据：stop 打印 `stopped`，第二条退出 0；registry、receipt、manifest 都保留。

彻底注销没有快捷命令。先执行上面的 stop，再在同一终端逐字运行：

```bash
export FW_UNREGISTER_DIR="$(mktemp -d -t flywheel-unregister-XXXXXX)"
cp -p "$FW_PROJECTS" "$FW_UNREGISTER_DIR/projects.before.json"
cp -p "$FW_RECEIPT" "$FW_UNREGISTER_DIR/receipt.before.json"
jq --arg p "$FW_PROJECT" --arg l "$FW_LEAD_ID" \
  'map(if .projectName == $p then .leads |= map(select(.agentId != $l)) else . end) | map(select((.leads // []) | length > 0))' \
  "$FW_PROJECTS" > "$FW_UNREGISTER_DIR/projects.next.json"
jq --arg p "$FW_PROJECT" --arg l "$FW_LEAD_ID" \
  '{assignments:[.assignments[] | select(.projectName != $p or .leadId != $l)],projectAggregators:.projectAggregators}' \
  "$FW_RECEIPT" > "$FW_UNREGISTER_DIR/assignments.next.json"
chmod "$(stat -f %Lp "$FW_PROJECTS")" "$FW_UNREGISTER_DIR/projects.next.json"
"$FLYWHEEL_DIR/scripts/flywheel-config-lock.sh" "$FW_PROJECTS.cfglock" 5 /bin/mv "$FW_UNREGISTER_DIR/projects.next.json" "$FW_PROJECTS"
export FW_PROJECTS_SHA="$(shasum -a 256 "$FW_PROJECTS" | awk '{print $1}')"
"$FLYWHEEL_DIR/scripts/migrate-summary-registry.sh" "$FW_PROJECTS" "$FW_UNREGISTER_DIR/assignments.next.json" "$FW_RECEIPT" "$FW_PROJECTS_SHA"
node "$FLYWHEEL_DIR/packages/flywheel-comm/dist/index.js" summary-registry verify-activation --projects-file "$FW_PROJECTS" --receipt-file "$FW_RECEIPT" | jq -e '.ok == true'
rm -f "$FW_MANIFEST"
! jq -e --arg p "$FW_PROJECT" --arg l "$FW_LEAD_ID" '.[] | select(.projectName == $p) | .leads[] | select(.agentId == $l)' "$FW_PROJECTS" >/dev/null
! jq -e --arg p "$FW_PROJECT" --arg l "$FW_LEAD_ID" '.assignments[] | select(.projectName == $p and .leadId == $l)' "$FW_RECEIPT" >/dev/null
```

成功判据：verify-activation 为 `ok:true`，最后两条都退出 0。若 re-mint 失败，在 Bridge 重启前逐字恢复并停止操作：

```bash
"$FLYWHEEL_DIR/scripts/flywheel-config-lock.sh" "$FW_PROJECTS.cfglock" 5 /bin/bash -c 'cp -p "$1" "$3" && cp -p "$2" "$4"' _ "$FW_UNREGISTER_DIR/projects.before.json" "$FW_UNREGISTER_DIR/receipt.before.json" "$FW_PROJECTS" "$FW_RECEIPT"
node "$FLYWHEEL_DIR/packages/flywheel-comm/dist/index.js" summary-registry verify-activation --projects-file "$FW_PROJECTS" --receipt-file "$FW_RECEIPT" | jq -e '.ok == true'
```

恢复成功判据仍是 `ok:true`。注销只在下一次获批 Bridge 重启后生效。
