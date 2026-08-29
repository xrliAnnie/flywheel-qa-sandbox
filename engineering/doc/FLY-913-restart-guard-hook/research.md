# FLY-913 部署护栏 — PreToolUse hook 硬拦手动重启 — 调研

Issue: FLY-913 (https://linear.app/geoforge3d/issue/FLY-913/infraguardrail-部署护栏-pretooluse-hook-硬拦手动-bridgelead-重启物理强制走-restart)
日期: 2026-07-06
基于: exploration.md

本文档 = 代码库审计事实 + hook 协议核实,全部一手验证(grep/读源码/官方文档),供 plan.md 直接引用。

## 1. 先例:discord-reply-enforcer(FLY-387)—— 可复用的完整模式

| 维度 | 事实 | 出处 |
|------|------|------|
| 形态 | 单文件 python3(stdlib only),per-invocation 执行 | scripts/hooks/discord-reply-enforcer.py |
| source 位置 | 仓库 scripts/hooks/,测试同目录(test-discord-reply-enforcer.py + install merge 测试) | scripts/hooks/ |
| 部署位置 | cp 到 ~/.flywheel/bin/(hook 文件热更新 = 重新 cp,零重启) | claude-lead.sh:789 |
| 接线 | claude-lead.sh::install_discord_reply_enforcer_hook —— jq merge 进全局 ~/.claude/settings.json,只删/加自己的条目、保 sibling hook、空组丢弃、坏 JSON 跳过不写(fail-open)、mktemp+mv 原子写 | claude-lead.sh:769-841 |
| jq 1.6 坑 | macOS jq 1.6 parse error 仍 exit 0,有效性靠「输出非空」判定,绝不拿空结果覆盖 settings | claude-lead.sh:797-800 |
| 失败语义 | hook 内部错误 fail-open(exit 0),绝不 wedge session | 文件头注释 |
| 测试模式 | bash 断言脚本跑 jq merge 矩阵(幂等/删旧/保 sibling)+ python 单测吃 stdin JSON fixture | scripts/hooks/test-reply-enforcer-install.sh |

**结论**:FLY-913 逐项镜像此模式,唯一差异是事件类型(Stop → PreToolUse/Bash)与判定逻辑。

## 2. PreToolUse hook 协议(官方文档核实,2026-07-06)

- **stdin 输入**:JSON,关键字段 `tool_name`("Bash")、`tool_input.command`(完整命令串)、`session_id`、`cwd`、`permission_mode`。
- **deny 输出**(推荐,exit 0):
  ```json
  {"hookSpecificOutput": {"hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "<回灌给 agent 的报错,即正确命令指引>"}}
  ```
  `permissionDecisionReason` 会作为报错喂回 agent —— 这正是「拦下时给出正确命令让 agent 无脑改用」的载体。exit code 2 + stderr 也能拦,但 JSON 是官方推荐、语义更清晰。
- **放行**:直接 exit 0 无输出(不需要显式 allow)。
- **接线生效时机**:现版 Claude Code 对 settings 文件有 **file watcher**,「Direct edits to hooks in settings files are normally picked up automatically」——即首次接线**可能**对运行中 session 也生效。此行为需真机验证(QA 步骤);保守下限是:新 session 立即生效,已运行 session 最迟在其下次正常重启后生效。hook **文件本体**(~/.flywheel/bin 下的 .py)每次调用现读,更新真·零重启。

## 3. 正规重启 flow 的形态(allowlist 的目标)

### 3.1 restart-services.sh(FLY-20 起,scripts/restart-services.sh)

- 完整职责:diff 分析 → idle wait → **pnpm build** → 重启(launchctl kickstart)→ 健康检查(port-release fail-closed,FLY-516)→ **Discord notify** → deployed-sha 记录(FLY-727 部署事件账本)。手动 kickstart 漏掉的正是 build/播报/回滚三件事。
- 用法:`restart-services.sh [--force] [--dry-run]`。
- 内部 launchctl 调用(start_bridge:725 kickstart com.flywheel.bridge;restart_lead:842 kickstart com.flywheel.lead.<project>-<leadId>)发生在**脚本子进程**里 —— PreToolUse 只见 agent 敲的顶层命令串,所以放行脚本本身即可,内部 launchctl 不过 hook。
- 存在两份:仓库 `~/Dev/flywheel/scripts/restart-services.sh` 与部署副本 `~/.flywheel/bin/restart-services.sh`。allowlist 两个路径形态都要认。

### 3.2 update-flywheel.sh(FLY-270 updater / self-ship)

- launchd job `com.flywheel.updater` 驱动(QueueDirectories on ~/.flywheel/self-ship-pending.d + 定时 sweep),**不经过任何 Claude session 的 Bash**,与 hook 无交集。
- agent 手动触发 self-ship 的正规形态是往 self-ship-pending.d 落 marker(flywheel-land / ship 流程),不是直接跑 updater;但 `update-flywheel.sh` 本身列入 allowlist(诊断/手动补跑是合法运维)。

### 3.3 launchd 标签面(block pattern 的目标)

- `com.flywheel.bridge`(Bridge)
- `com.flywheel.lead.<project>-<leadId>`(全部 Lead daemon,含 companion,如 com.flywheel.lead.growth-mufasa-lead)
- `com.flywheel.updater`(updater 本身也不该被手动 kickstart/bootout)
- 统一特征:**`com.flywheel.` 前缀**。QA slot / 测试 bridge 不用这些标签(529 Room 是 worktree 直跑进程),天然不误伤。

## 4. 事故命令形态盘点(block 矩阵的输入)

本次(2026-07-06)及历史(FLY-176 workaround、FLY-239 教训、bridge-ship-discipline.md)出现过的手动重启写法:

1. `launchctl kickstart -k gui/501/com.flywheel.bridge`
2. `launchctl bootout gui/501/com.flywheel.lead.xxx` + `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.flywheel.xxx.plist`
3. `pgrep -f run-bridge | xargs kill -9`(MEMORY 里记载的 FLY-176 workaround —— 正是要被护栏收编的形态)
4. `pkill -f run-bridge` / `pkill -f claude-lead.sh`(FLY-239 教训:pattern-sweep 会误杀 QA slot)
5. `kill <pid>` + `nohup npx tsx scripts/run-bridge.ts &`(杀后裸手拉起,漏 build)
6. `launchctl kill SIGTERM gui/501/com.flywheel.bridge`

**分类结论**(与 exploration §3.4 一致):
- launchctl **变更类**子命令(kickstart/bootout/bootstrap/kill/stop/unload/load/enable/disable/remove)+ 命令串含 `com.flywheel.` → 拦。只读子命令(print/list/blame/dumpstate 等)→ 放(诊断刚需,restart_lead 检测 daemon 就用 print)。
- kill 族(kill/pkill/killall/xargs kill)+ 命令串含 flywheel 进程标识(`run-bridge`、`claude-lead.sh`、`flywheel-bridge-wrapper`、`flywheel-codex-lead-wrapper`、`com.flywheel`)→ 拦。裸 `kill <pid>`(无标识)不可分类 → 放(已知盲区,exploration §3.5)。
- 裸手拉起 bridge:命令串含 `run-bridge`(scripts/run-bridge.ts 直跑,任何 nohup/npx/tsx 包裹)且非 allowlist 形态 → 拦。

## 5. Bypass「响」的落地件:lead-alert.sh(FLY-83/FLY-368)

- `scripts/lead-alert.sh`:**独立于 Bridge 的 shell 告警器**(Bridge 挂了也能发——这正是 bypass 场景的典型环境:Bridge 坏了才需要手动干预)。
- 机制:projects.json 解析频道+token → eventId=sha1(project|lead|kind|signature) → claims.db 去重(单 sqlite3 事务)→ Discord POST → **失败 spill 到 ~/.flywheel/alert-queue/**(deadletter 兜底)。
- **约束 1**:`--kind` 是硬白名单(lead-alert.sh:72 case 分支),现有枚举无合适语义 → 需新增 kind `restart_guard_bypass`(纯 shell 侧改动;lead-alert.sh 直发 Discord,不经 Bridge,Bridge 侧无需同步改)。
- **约束 2**:默认 signature=当天日期 → 同 kind 每天最多一条。bypass 每次都必须响 → hook 调用时传 `--signature <时间戳+命令hash>` 唯一化,绕开日去重。
- **「必须响」的可判定语义**:hook 拿 lead-alert.sh 的 exit code —— 0(已发或已认领)与 2(POST 失败但已落 queue,必达)都算「响了」;1(配置错误,一条都没落下)算失败。加上审计日志写入成功,两者同时满足才放行 bypass;任一失败 → deny(bypass 记账路径 fail-closed;正常判定路径仍 fail-open)。

## 6. 审计日志

- 落点:`~/.flywheel/logs/restart-guard.log`(reply-enforcer 同款 telemetry 风格:JSON lines,含 ts/session_id/cwd/decision/command 截断/bypass reason)。
- 记录事件:每次 deny、每次 bypass 放行。普通放行(不匹配任何 pattern)不记(避免全机 Bash 流量刷日志)。

## 7. 风险与开放点(供 plan 消化)

| # | 风险 | 处置 |
|---|------|------|
| R1 | allowlist 子串判定被拼接绕过(`restart-services.sh; launchctl kickstart …`) | 判定顺序:先扫 block pattern,命中后仅严格全命令匹配 allowlist 才放行;测试矩阵含拼接用例 |
| R2 | 误拦 QA slot / runner-terminal 正常操作 | block pattern 全部锚定 flywheel 专属标识(com.flywheel. / run-bridge / claude-lead.sh / wrapper 名);529 Room 不用这些标签;测试矩阵含 QA 场景负例 |
| R3 | hook bug wedge 全机 Bash | 判定路径 fail-open(任何异常 exit 0);python3 stdlib 无依赖;单测覆盖坏输入(空 stdin/非 JSON/缺字段) |
| R4 | settings.json merge 写坏(全机 hooks 失效) | 逐字复用 reply-enforcer 的 jq merge 防御(非空校验 + mktemp/mv + 坏 JSON 跳过);install merge 测试矩阵 |
| R5 | bypass 被 agent 滥用成常规路径 | 强制响(Annie 每次看见)+ 审计日志;报错不宣传 bypass;「响-bypass vs 封死」ship gate 交 Annie 终拍 |
| R6 | 运行中 session 何时生效不确定(file watcher vs 快照) | 真机 QA 显式验证两种情形;文档按保守下限承诺(新 session 立即,老 session 最迟下次正常重启) |
| R7 | restart-services.sh 自身有 bug 时(如 FLY-176)无人能修 | 人在裸终端操作不过 hook(天然人类逃生口);agent 侧走响-bypass;都留痕 |

下游:→ plan.md。
