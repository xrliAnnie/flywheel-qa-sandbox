# FLY-2603 标准 Codex Lead summary 回执 — 验证
Issue: FLY-2603 (https://linear.app/geoforge3d/issue/FLY-2603)
日期: 2026-09-15
基于: plan.md

## R1 历史验证（被下方 R2 取代）
- 安装：pnpm install --frozen-lockfile 成功；基线及改动后 pnpm -r build 成功。
- pnpm lint exit 0，21 warnings 为现有仓库告警，无附带修复。
- retention consumer gate: ok=true, errors=[]。没有 schema/保留策略变更；新增读取属于已登记 mailbox queue consumer。
- Red: 环境回归复现五字段缺失；修正测试 fixture 的时间/undefined 后 ACK red 精确为 2 failed / 9 passed（未写回 journal）。
- Green: VITEST_MAX_FORKS=1，6 个定向文件共 197 项通过：protocol ingress 11、runtime 129，其余四文件 57。首次组合执行 195 passed / 2 failed（旧 dry-run env_vars 文本断言）；仅更新两条期待文本，runtime 重跑 129 passed，未重复无关套件。
- 回归覆盖 app-server、TUI daemon、lead-actions MCP 身份/频道继承，非白名单秘密排除，MCP 额外秘密拒绝；batch 所有者校验、真实 CommDB receipt ingress、journal ACK 幂等、模拟两库间中断后重复 receipt 修复，以及错误 sender/source/type/ref/owner 不签收。
- 全仓 package aggregate 留给 exact-head CI，遵照 Lead simple_code“targeted tests once”限定；不声称本地 aggregate green。
- 无新增 shell test。未运行 macOS GUI/生产环境测试。

## 一手事故读回
只读 journal/comm.db；没有复制或修改生产数据库。
| seq | mailbox state | mailbox acked_at |
| --- | --- | --- |
| 117593 | ACKED | 2026-09-16T00:06:18.933Z |
| 117594 | ACKED | 2026-09-16T00:12:51.575Z |
| 117899 | ACKED | 2026-09-16T00:32:24.243Z |

三条 journal 均 ambiguous，HTTP 400 是处理后的 outbound 路径错误；lead-actions audit 均有 bridge_sent。修复让今后的 canonical batch receipt 同步写回对应 summary journal，不推断 merge 成功、不重放历史业务动作。

## 回滚与交接
无 migration；回退本 PR 即恢复旧行为。历史 ACK 不回填，既有时间戳不覆盖。
生产 summary PR 合并、载体重启后环境、真实回执，以及 memory 远端 push 由后续授权验证；本地测试不替代这些证据。尚未 merge/部署/重启，未派发 QA。
最终 exact-head code review 与 CI 通过外部 gate/PR 收据核对，审查期间不 push。

## R2 当前验证
- 最小补修过期清理入口：保留 protocol receipt 给既有 ingress 完成跨库 mirror，再由 inbox loop 终结。
- 回归先红：新增 expiry/restart 场景 1 failed / 11 passed，失败点为 protocol receipt 错误地已经 ACKED。
- 改后 VITEST_MAX_FORKS=1：mailbox-queue 26 passed；protocol-ingress 12 passed + codex-lead-runtime 129 passed，共 167 项受影响测试通过。
- packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh：64 passed / 0 failed；旧头本地与 CI 都为 62/2，现更新两个精确 env_vars 期待。
- pnpm -r build 通过；pnpm lint 通过（既有警告，无新增修复）。
- 无新增 shell 测试入口，沿用 CI 已登记的脚本。R1 的其余 MCP/TUI 定向测试仍为历史 evidence；新 head 全套 CI 必须独立通过。
- 按 Lead f984250f 裁定，撤回两条额外频道 allowlist 变更，不改 launcher 的 registry 优先规则。Lead 已单独修复 Raya registry，待重启；本 PR 不声明 roundtable 生产恢复。
- R1 code review HIGH shell-gate-env-vars-stale 与此前 design HIGH summary-receipt-missed-on-reconciler-batch-ack 均已补修。非阻断建议已报告 Lead，本次不扩展 producer 身份能力或其它消费者。

## R3 当前验证
- R2 exact-head CI 的 heavy 分片发现第二组旧 receipt 期待：mailbox-queue-capabilities.test.ts 的 queued/expired-claim 两例；flywheel-comm 其余 2601 项通过。
- 只修测试期待：reconciler 保留 QUEUED 或过期 LEASED receipt，新增 claimBridgeProtocol 重新认领为当前 owner 的断言；生产代码没有变动。
- VITEST_MAX_FORKS=1 完整 capabilities 文件 52 passed；该测试文件 biome check 通过。R2 build/lint、167 项 TS 与 64 项 shell 是生产代码对应的已有证据，未无理由重复。
- 消费者 sweep：检查 packages/flywheel-comm/src/__tests__ 与 packages/teamlead/src/bridge/__tests__ 中全部 reconcileExpiredLeases 调用及 receipt 状态期待，直接断言该过期 ACK 效果的是 mailbox-queue.test.ts 与 mailbox-queue-capabilities.test.ts；两组现均保留 receipt。ProtocolIngress 测试验证最终 journal mirror 和 protocol 终结。
- R3 head 仍需新的有效 code review 与全套 CI；不沿用 R2 的结果或宣称 full package green。

## R4 CI 隔离补修（Lead 授权 730a4110-a5d3-47ec-a153-3ccf1b407918）
- R3 head 87760ecb8 effective code review APPROVED，5 条非阻断建议已报告；未宣称 governance settled。
- CI 35045342328 两次仅 shard 2 性能断言失败：tail wall 284.964/67.483ms（门槛 50ms），CPU 8.937/9.155ms；14 个其它 job 通过，独立性能 job tail max 8.396ms。main CI 35032419547 也有同测试 124.746ms 失败。
- 按 Lead 限定，仅在 shard helper 增加该文件的原生 --exclude；性能测试体、阈值、cost inventory、workflow 均不变，现有 dedicated job 是 CI 中唯一运行入口。
- 定向测试先红（缺失排除参数），改后 2 passed，含真实 Vitest discovery 对照：分片覆盖除性能测试外所有测试，独立 job 命令仍存在。首次全文件运行未结束且无输出，已中断，不计为通过。
- R4 仅 CI helper 与测试变更；新 head 仍需新 code review 与 exact-head CI，不沿用 R3 审查结论。
