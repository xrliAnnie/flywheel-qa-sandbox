# FLY-2363 InfraBot 传感器 — 调研
Issue: FLY-2363 (https://linear.app/geoforge3d/issue/FLY-2363)
日期: 2026-09-13
基于: exploration.md

## 复用已有探针，仅补启用前检查

`packages/teamlead/src/bridge/plugin.ts` 的 `probeInfraBots` 从目标变量读取 label；空值跳过。`launchctl.ts` 将裸 label 解析成 `gui/<uid>/<label>`，只有 `state = running` 为 true，明确找不到为 false，权限错误/超时为 unknown。`fleet-sensors.ts` 的 BOT 传感器默认启用，`FLYWHEEL_FLEET_SENSOR_BOT=0` 可关闭；还须实核生产运行字节和调度。

首次 false 创建 `infra_bot_down`，同 episode 锁存并通过 durable active ticket 避免重启后重复；后续 true 清除锁存并静默 resolve。GREEN 是对应工单恢复证据，不要求第二条恢复告警。自动修复会 `launchctl kickstart -k` 同 label，所以武装本身可能触发生产变更，不能在当前失败基线上盲目添加变量。

候选配置只有一行：

```dotenv
FLYWHEEL_CODEX_INFRA_BOT_JOB=com.flywheel.lead.flywheel-codex-infra-bot-lead
```

Bridge wrapper 对 `.env` 使用 allexport；是否已被当前进程读取需 `ps -E` 或等价 host 进程证据，不能只凭文件推断。

## 验证范围

现有 `fleet-sensors.test.ts` 可验证 episode 行为；`scripts/qa-fly-1082-fleet-alerts-e2e.mjs` 使用 seam，不是本单生产 RED→GREEN 证明。Lead 要求新增只读启用前检查；采用 Node 标准库执行 launchctl，node:test 覆盖拒绝与稳定通过路径。

生产验收需精确 target、当次授权、健康前置状态、停起时间及 pid/lstart、真实告警 URL、相同 correlation key 的 active→resolved 证据。先排除当前启动失败，再开停机窗口；启动失败原因修复是否另单由 Lead 决定，不扩入本单。

## 最小 preflight 设计

新增只读 CLI `node scripts/infra-bot-sensor-preflight.mjs <bare-label>`：验证 label 字符、读取 gui/current-uid 的 job。首个样本必须包含顶层 state=running、正整数 pid 和 runs；等待 35 秒（超过本机 ThrottleInterval=30）后再次读取，相同 pid/runs 且仍 running 才通过。非运行、字段缺失、命令失败/超时、pid 或 runs 改变均非零退出，输出明确原因，不执行任何配置写入或 launchd mutation。历史非零退出码但当前跨窗口稳定可通过，避免把已恢复实例永久锁死。

这是本 label 30 秒重启节奏的启用准入观察，不保证未来永不退出，也不证明 TUI/对话健康。检查失败时不打印启用配方；成功时打印精确配置行供获批执行人使用。运行时传感器保持原样，防止启用后把真实掉线过滤掉。测试通过依赖注入提供两次输出及等待函数，不增加生产 env 开关。

部署模板 `fleet/example/env.example` 保持 key-only：新增空变量及说明，注释写明本生产实例 label、preflight 命令和 runbook 链接；不把本机 label 激活为其他 host 默认值。
