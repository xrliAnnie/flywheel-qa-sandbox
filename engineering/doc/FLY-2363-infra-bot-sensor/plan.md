# FLY-2363 InfraBot 传感器 — 实施计划
Issue: FLY-2363 (https://linear.app/geoforge3d/issue/FLY-2363)
日期: 2026-09-13
基于: research.md

## 范围与停止线

仅确定留空意图并落实对应分支；优先复用现有探针，零运行时传感器修改，仅新增启用前 CLI。计划审查不等于生产操作授权。实现体不重启 Bridge/Lead，不自行派发 QA，不复用 FLY-2239 已延期的强停授权。

1. 保存只读证据和 Lead 裁定：无意漏配，当前出生自锁归 FLY-2530。进程 env 的 EPERM 限制如实保留，由 Lead 开窗时补证。
2. 按 research 的最小设计 TDD 新增只读 preflight CLI：严格顶层 launchctl 字段；35 秒两次采样必须 running 且 pid/runs 稳定。测试涵盖当前 spawn-scheduled/exit=3、短暂 running 后失败、pid/runs 改变、未知/失败/超时、无效 label、嵌套字段假阳性，以及稳定恢复后历史非零退出码不误拒绝。只使用标准库，CI 显式枚举新 node:test 文件。
3. 更新 `fleet/example/env.example` 的空 key 与注释，新增 `enable-runbook.md` 给出配置位置和精确一行。Lead 执行路径必须先跑 preflight；失败即停止，不获取可用启用配方。不修改 Bridge 启动路径或运行探针。
4. 以下生产收官步骤仅由 Lead 在 FLY-2530 合入、恢复健康基线且取得新 founder 授权后执行：先验证部署版本，运行 preflight，按 research 一行更新 ~/.flywheel/.env（Bridge plist 通过 wrapper 读取；不要在两处引入冲突值），按获批流程重启生效并回传进程变量。自动 kickstart 也须纳入窗口。
5. founder 当次授权须明确精确实例 `gui/501/com.flywheel.lead.flywheel-codex-infra-bot-lead`、执行人、窗口、停/恢复方式与最多 10 分钟恢复界限；执行前确认调度周期能覆盖窗口。由该执行人留 baseline，然后停一次，确认一条目标 `infra_bot_down` 真实告警及 durable active 工单，再恢复并证明同一工单 resolved。KeepAlive 或自动修复可能抢先恢复，未观察到 RED 就判本次未验证，不反复强停补数。
6. 保留 T0/T1/T2、pid/lstart、job state、告警 URL、精确 correlation key `machine|infra-bot:codex|infra_bot_down|` 及前后状态；若现场代码常量不同，先核对并使用现场精确值。不可用 mock、日志缺失或其他 residency 告警替代。需要 DB 证据时只用托管 snapshot 工具，不复制 live DB。
7. 任一恢复失败或达到界限，由授权执行人按开窗前批准的恢复步骤恢复可用性，保存 FAIL 并停止后续强停；回滚移除本次新增变量并通过同样获批流程生效，验证不再武装。不得把最终恢复可用改写为验收通过。
8. 本轮实现交付完成后，完成要求的 lint/build/package tests，记录真实结果；走新鲜 code review、milestone 最后一提交及 PR，向 Lead 报告并执行 `complete --route needs_review --pr <NUMBER>`。按 Lead 此次裁定，PR/needs_review 是实现交接边界；外部生产验收仍为 Lead 后续收官，不宣称 issue 已完成。

## 验收矩阵

| 要求 | 权威证明 | 当前状态 |
|---|---|---|
| 现状与历史 | env/plist/进程过滤采样 + git/文档检索 | 进程 env 待补 |
| 意图 | Lead 裁定与理由/来源 | gate 已答：无意漏配 |
| 本轮配置模板/guard/方案 | TDD + 文件 + 审查 | 待实现 |
| 无意则配置生效 | 正确 label + 运行进程 env + 健康基线 | 未执行 |
| RED→GREEN 各一次 | 当次授权 + 真实告警 + 对应工单 resolved | 未执行 |
| 实现交接 | 检查、审查、PR、complete 回执 | 未执行 |
