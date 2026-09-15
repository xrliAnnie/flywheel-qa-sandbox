# FLY-2561 待批标题 — 验证记录
Issue: FLY-2561 (https://linear.app/geoforge3d/issue/FLY-2561)
日期: 2026-09-14
基于: plan.md

- pnpm install --frozen-lockfile: passed (19.6s)。
- baseline pnpm -r build: passed。
- baseline issue-display + refresher: 101 passed。
- 生产受管 StateStore 源码回放：三单各三种 park 输入均 approve；reviewHeld=false。见 snapshot-replay.json。
- 生产受管 CommDB：三张 approve_to_ship question 均无 response，owner 为各自 QA execution；见 comm-snapshot-evidence.json。
- RED: founder-approval-projector 两个 projection 回调断言失败；void 回调断言失败。
- 初版新 integration fixture 缺少 workflow_ship_target_binding，属于 fixture setup failure，不算行为红灯；补足真实 node PR binding 后重跑。
- RED 重跑：integration 正确失败于 refresh 调用 0 次，期望 1 次；materializer replay 回调和 callback error logging 断言也为红。3 files / 5 failed / 81 passed。
- 完整聚合验证、代码评审、精确头 CI、报告发布及 handoff 尚未完成。

## 恢复实现验证（2026-09-14）

- 当前 TURN：implement epoch 5；R4 design effective APPROVED，question 968a9bde-c40d-430b-a5ed-5b469478f8d1。
- 实现提交：dd51a6da1。只修改 materializer、source projector、void callback 与 plugin 接线。
- RED：恢复后重跑 4 files，8 failed / 81 passed；void suite 3 failed / 20 passed，均为缺少回调或启动接线断言。
- GREEN：6 files / 158 tests passed（materializer、source projector、void lifecycle、wiring、issue-display、refresher），19.45s。
- pnpm lint：exit 0（现有 warning）；pnpm -r build：exit 0。
- 当前源码重跑原生产副本提取数据：FLY-2553/2554/2555 三种 park 输入均 approve；这证明 derive，无生产写入或上线验证。
- 报告：https://fw-reports-624a39.vercel.app/r/bd9338c98f518140515bcd536dfc5df4/ ，publish-only；verify-report HTTP 200，expect FLY-2561 pass。
- package gate、code review（6aa6e4cd-b887-4b3d-9287-bf4ac17438f0）、PR / exact-head CI 尚在进行。
- 无 schema/migration 或新 scripts shell test；回滚撤销四处显示通知补丁，不更改审批状态机或轮询周期。

## 当前头评审与 CI 容量失败

- 0f0395ff896f1f75e7c2f4acf9a467ec88a34598 code review effective APPROVED：question 017fd8b3-0dc9-48c2-a948-0a214320afd6，request ef1769b3-6b04-4781-9214-6263fb675f3b。
- 非阻断建议已报告 Lead：runner_ship 批准虽 enqueue，现有 derive 可能保持待批直到 carrier 推进；void 在卡片编辑前通知依赖 durable superseded；AST Map 可能遮盖未来重复调用点；非生产调用缺 log 时可能静默；milestone PR 字段应写具体编号。
- CI run 34906441662：所有 Unit、Quick Gate、其他分片通过；Script Tests 1/5 在所有测试步骤完成后被容量守卫拒绝。elapsed=1022s，budget=1020s，cap=1200s，usage=85%。CI OK 随依赖失败。不能报告为 CI green。
- 本分支未改 ci.yml 或 ci-job-elapsed-tripwire.sh。用 start=1000、now=2022 回放同一脚本，确定性复现 exit 1；不放宽阈值、不将其裁为 flake、不盲目 rerun。
- Lead question 79581c42-516b-43d5-a6c7-3aaf9d924fbc 请求单独修复容量或授权整组测试搬迁。最长步骤 FLY-2331=170s、FLY-1663=149s、FLY-1814=136s、FLY-1929=116s；分片4总534s。
- 本地 package gate 继续运行；完整结果及最终 head review/CI 仍待完成。

## Lead handoff ruling

Question 79581c42-516b-43d5-a6c7-3aaf9d924fbc：Lead 明确禁止本单修改 CI/容量守卫，将容量搬迁路由到 FLY-2562；要求原样记录 CI red 并立即 complete --route needs_review --pr 1197。此为 handoff 授权，不是 CI green 裁定。

本地 package gate 仍运行在 teamlead，前 11 包 passed；无最终聚合收据，不据其声称全仓通过。FLY-2562 合入后，需持有 implement TURN 再 merge origin/main 一次，重新获取 exact-head CI，禁止盲目 rerun。
