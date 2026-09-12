# FLY-2520 账号到期排序 — 恢复审计
Issue: FLY-2520 (https://linear.app/geoforge3d/issue/FLY-2520)
日期: 2026-09-11
基于: plan.md

当前实现 TURN epoch=2 已确认。恢复时 HEAD 为 57de40d9b，工作树干净，仅有设计文档，无产品代码变更。已按注入要求重跑 onboard/brainstorm，阅读 CLAUDE.md、产品体验规格、架构和参考材料。

## 设计门禁实际状态

R2 question a36fc9e1-ff07-4268-a717-01eae1cd2d8e 已返回 CHANGES_REQUESTED，并非无判决。完整响应保存在 design-review-r2.json。唯一 HIGH：retirement-reuses-quota-trigger-fabricates-resetat。尚不能开始实现；不修改 pinned plan。

已向 Lead 提交非阻塞问题 f3791d2b-87f6-40e6-a30c-33a51d8bed7a，请求授权技术修订后注册 R3。当前没有 Linear MCP；注入 issue 全文与 Lead 交接裁定可读，已向 Lead 请求全文读取入口。

## 当前源码证据与后续测试入口

- account-candidate-selector.ts：rank 按 resetMs/name 排序，verifyAndRankCandidates 保留 headroom 分组及 auth/model/cooldown 守卫。退休键必须在每个组内改变排序，不能绕过排除。
- account-store.ts：selectNextAccount 有 preferredOrder 与 legacy 两条路径，两者都需要到期守卫，防止验证到执行之间跨过 deadline；legacy quota scope 排序需要同一 min 键。null/model scope 的原姓名语义保留。
- quota-monitor.ts：nextUsageDueAt 的 local_scan 返回发生在 readSnapshot 之前；backoff 与缺失/过期 credential 返回发生在 usage fetch 之前。只在 fetch 前插退休检查不足以满足需求。
- handleAccountDead 已复用 account_dead trigger、候选验证、失败/no-target episode、成功去重，且不受 quota minSwitchInterval 检查影响。当前成功会清空 reviveEpoch；不能把它描述成已证明 runner pane 恢复。
- quota-monitor-config.ts 默认 paneScanSeconds=60。到期检查可复用现有 pass；仍需测试 nextUsageDueAt/backoff/credential 不可读和机器权威冲突。
- scripts/lead-alert.sh 的 eventId 是 project|lead|kind|signature 的 SHA-1；sent/queued receipt 持久化。稳定 account+retirement signature 可支持投递去重，无需给严格键集的 quota-monitor-state 增加字段。需测试跨 pass、重读、投递失败和路由不私信 founder。
- capacity-snapshot.ts 当前 validInstant 是宽松 Date.parse；新增 retirement 展示必须消费共享严格校验，避免 malformed 令整块 capacity 不可读或被渲染为似是而非日期。
- 现有测试入口：account-candidate-selector.test.ts、account-store.test.ts、quota-monitor.test.ts、quota-monitor-alert.test.ts、bridge/__tests__/capacity-snapshot.test.ts、patrol-tick-render 测试。monitor harness 已覆盖 account_dead bypass cooldown、successful episode 去重及 no-target 重试。

## 验证与交付约束

Lead instruction 3bc31ed8-9a55-4661-879e-5fe53dd4a441 指定宿主只跑定向测试与 lint/build，不在宿主跑全量；审绿及精确 HEAD CI 绿后 needs_review。完整指令已通过 DONE report 回执。生产 claude-accounts.json 与 monitor 重启归 Lead/QA，本实现体未触碰。

下一步：消费上述待答问题；如授权修订，明确 account_dead 承载、提前检查位置、warning 去重与无伪造 reset 的恢复语义，注册 R3 并等待有效 verdict，再开始逐条 TDD。

## 恢复基线测试

2026-09-11，在 7dd49dd7c 上执行 `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-candidate-selector.test.ts src/__tests__/account-store.test.ts src/__tests__/quota-monitor.test.ts src/bridge/__tests__/capacity-snapshot.test.ts`：4 文件、184 测试通过。日志 `/tmp/fly2520-resume-baseline.log`。这是变更前基线，不是 retirement 行为或全量 CI 证明。

## Implement resume epoch 3

2026-09-11：TURN yours implement epoch=3；HEAD cdcd321d7；工作树干净，仍无产品代码。重新完成 onboard/brainstorm 并恢复 design_review stage。消费 R3 a868e4b5-abd8-44d3-a0bb-d08a7a03c496，有效 verdict=CHANGES_REQUESTED；完整响应在 design-review-r3.json。

唯一 HIGH findingKey=retirement-recheck-loop-unthrottled：当前 local_scan 的 nextUsageDueAt 守卫限制 account_dead 失败重试；把退休检查移到该守卫前会令无候选场景每 60 秒全池 usage probe/observation 写入，并重复刷新 unavailable.markedAt。源码 quota-monitor.ts handleAccountDead 和 local_scan 顺序确认此风险。

已注册 Lead question 1627fcd3-7344-4934-973c-f29ac816d568，请求授权 pinned plan 修订及超出先前最多 R3 的新评审。具体提案：首次到期不受 usage/backoff 阻断；已有同账号失败 deadAccountEpisode 仅到现有 nextUsageDueAt 再扫描，使用现有 pollIntervalMs 调度且保留首次 unavailable.markedAt；测试 +60s 无探测/写入、状态重读不重复、到期重试恢复。不新增状态 schema。尚未获授权，未改 plan 或产品代码，不把 pending 当 blocked。
