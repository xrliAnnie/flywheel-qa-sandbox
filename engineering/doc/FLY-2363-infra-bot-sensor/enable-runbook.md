# FLY-2363 InfraBot 传感器 — 启用与验收
Issue: FLY-2363 (https://linear.app/geoforge3d/issue/FLY-2363)
日期: 2026-09-13
基于: plan.md

## 决策和责任

Lead 答复 `86eefe5a-71a4-4620-9773-3311f4af79bf`：无意漏配。FLY-2239 的延期仅针对强停演练。FLY-2530 正在修复当前 `lead-job-running` 自锁；它合入且现场恢复后，Lead 取得新的 founder 当次授权，再执行本页生产步骤。实现 PR 只交付配方、预检和方案。以下未执行，本文不是授权凭据。

设计审查 APPROVED 后，Lead 在 78dac302-f680-4d65-a3cd-aca61ad9e73f 裁定将现场窗口改为 30 分钟、停机方式限定 bootout。此页承载该后续操作裁定，已 pinned 的 plan.md 不修改。

## 配置配方

生产唯一目标：`com.flywheel.lead.flywheel-codex-infra-bot-lead`，当前 uid=501，完整 target 为 `gui/501/com.flywheel.lead.flywheel-codex-infra-bot-lead`。其他 host 先重新核对 uid、label 和对应载体，不能复制本机坐标作为默认值。预检只认 launchctl 顶层 state/pid/runs；现有运行时探针用整段 `/state = running/` 匹配，可能命中嵌套或 job state 行，两者并不等价。本 PR 不修改运行时探针。

模板注释不会随真实 host capture 传递；本 runbook 是长期保留的操作说明。

配置文件为 `~/.flywheel/.env`，新增且只保留一个定义：

```dotenv
FLYWHEEL_CODEX_INFRA_BOT_JOB=com.flywheel.lead.flywheel-codex-infra-bot-lead
```

`~/Library/LaunchAgents/com.flywheel.bridge.plist` 的 ProgramArguments 调用 `scripts/flywheel-bridge-wrapper.sh`，后者用 allexport 读取该文件。不需要修改 plist；不要在 plist 的 EnvironmentVariables 和 .env 放不同值。`FLYWHEEL_FLEET_SENSOR_BOT=0` 会关闭 BOT 传感器，现场必须确认进程中没有关闭它。模板只提供空 key，不自动武装新 host。

## 启用准入（失败即停止）

1. 记录 FLY-2530 部署 SHA/回执，确认 job 已脱离循环退出，TUI 可见且 InfraBot 可以回应；不能只以旧日志或瞬时 `running` 判健康。
2. founder 当次授权明确此实例、操作者、窗口、停/恢复动作、自动 kickstart 及 30 分钟恢复界限。Bridge 重启按 Lead 获批流程执行；本实现体不重启。
3. 在实际 host 用户会话运行：

   ```sh
   node scripts/infra-bot-sensor-preflight.mjs com.flywheel.lead.flywheel-codex-infra-bot-lead
   ```

   命令只读，等待 35 秒；两次顶层 state 必须 running、pid/runs 必须存在且保持相同。它覆盖当前 30 秒 KeepAlive 重试节奏，不证明未来活性。缺失/不明/失败、退出/再启动均拒绝，非零退出时不得继续配置。不要忽略返回码。历史非零退出码但当前跨窗口稳定不应被永久拒绝；TUI/回应另行验证。
4. 预检成功后立即在获批窗口按上一节新增变量，保留原值与修改时间。若执行中拖延或目标状态改变，重新预检。按获批流程令 Bridge 重读环境，再记录新 Bridge pid/lstart、版本和仅目标变量的 `ps -E` 提取结果，禁止保存整份环境。此项是强停前的硬前置：必须由可读取进程环境的 host 会话取得，EPERM 或无法核实就停止，不得以 .env 文件内容代替。
5. 核实生产探针与 BOT tick 已运行；确认精确 job target 健康、没有既存未解决的目标 episode。若已有 active 告警，先解释并解决，不用它充当本次人为停止证据。

## 一次 RED→GREEN

现场默认 BOT cadence = 3 秒 GatePoller tick × 200 ≈ 10 分钟，另加 tick 执行耗时；RED 和 GREEN 各需一次采样，因此 Lead 指定总窗口 30 分钟。开窗时仍须核实真实调度及余量，超出则不开窗。

操作者在强停前记录 UTC T0、job pid/lstart、runs、state、InfraBot 可用性和目标告警基线。确认当前 BOT 调度能在窗口内观察掉线；按当次授权对精确 target 执行一次 `launchctl bootout gui/501/com.flywheel.lead.flywheel-codex-infra-bot-lead`，记录 UTC T1；不要 kill 进程，KeepAlive 会在采样前复活。bootout 后探针应读到 could not find service；此时自动 kickstart 无法启动未注册 job，应记录失败/needs_human，而不是把它当作恢复。

RED 必须新增且只有一条 `infra_bot_down`，目标 `lead_id=infra-bot:codex`、`project_name=machine`、correlation key `machine|infra-bot:codex|infra_bot_down|`；保存真实告警 URL、event_id、目标 job label 和 active 工单证据。其他 residency 告警、fixture 告警、单纯 launchctl 非运行都不能替代。

Lead 已在问题 42835680-31cd-4b94-a665-e77188547f43 确认因果顺序：bootout → RED active 留痕 → 以当次批准的 bootstrap/kickstart 流程重新加载对应 plist → 下一次 tick GREEN resolved 留痕。恢复后记录 UTC T2、新 pid/lstart、runs、state、TUI 与回应。GREEN 必须证明上述同一工单变为 resolved、active 计数归零，且没有重复新建 episode。该传感器静默 resolve，不要求另发恢复告警 URL。

KeepAlive/ARC 若太快恢复、没有真实 RED，记“本次未验证”，不得反复强停凑验收。到 30 分钟或恢复出错立即按批准的恢复步骤保可用性，记录 FAIL、停止演练并报告 Lead。若需撤销武装，只移除本次新增变量并按获批流程使 Bridge 生效；保留失败与恢复原始证据。

若需要 DB 证据，只使用 `scripts/flywheel-snapshot-control.mjs runner ...` 的托管快照，放入对应 execution 的 `/tmp/flywheel-snapshots/<exec>/`，不复制 live DB；关闭句柄并遵守清理限制。

## Lead 收官回填（当前全部未执行）

| 项目 | 收官证据 |
|---|---|
| FLY-2530 生效与健康 baseline | 部署 SHA/回执、pid/lstart、TUI/回应 |
| 当次授权 | founder 消息 ID、实例、执行人、窗口及动作 |
| preflight | 命令、时间、退出码、稳定 pid/runs |
| 配置生效 | 原值、新值、Bridge 新代目标 env、BOT tick |
| RED | T1、真实告警 URL、event_id、active 工单 |
| GREEN | T2、恢复载体与可用性、同工单 resolved |
| 结果 | PASS/FAIL、异常及恢复、证据目录 |

只有这些现场证据齐全，Lead 才能把 issue 的生产验收标为完成；实现 PR 和 needs_review 回执不等于生产验收。

启用后的多 episode 抖动/回滚规则由 Lead 明确列为 follow-up，本 PR 不自行新增自动撤销武装行为。
