# FLY-2597 Thread attention — 验证记录
Issue: FLY-2597 (https://linear.app/geoforge3d/issue/FLY-2597)
日期: 2026-09-15
基于: implementation.md

## 验收证据范围

| 要求 | 自动化证据 |
| --- | --- |
| 三种点亮来源，founder 回复熄灭，ship 优先 | `founder-attention-sync.test.ts` 从 durable facts 同时驱动 page 与 refresher，覆盖 gate、forwarded ask、standalone ask、reply、terminal、ship priority |
| answered linked question 与非 ship gate 回复水位 | `founder-attention-facts.test.ts`；回复不回答 gate，仅消除提醒 |
| 无 session 的 Epic 与重启后的清除重试 | `issue-display-refresher.test.ts`、`founder-ask-scan.test.ts` |
| 既有 QA/review hold 一致 | `founder-attention-visibility.test.ts` 与既有 display 回归 |
| explicit marker 的发送和失败路径 | send/withdraw route tests，包含首块成功、部分发送、全失败、恢复 thread、身份校验 |
| 纯记录不 bump Discord | Epic intake schema/observer/route/StateStore quiet receipt 与 replay 测试；两套 Lead rules 同步 |
| 回滚 | `founder-attention-rollback.test.ts`，只读默认、精确前缀、显式 apply、无网络负面输入校验 |

## 完整 gate

首轮 `VITEST_MAX_FORKS=1 pnpm test:packages:run` 退出 1，完整 receipt 为 `package-gate-r1.json`，不能作为通过证据。
受测 head：`41f544f0fbb19bd2b3ec85c7305b3081e7ccfcff`。
该 head 的 `pnpm lint` 通过（21 warnings）；`pnpm -r build` 通过。
CI structure 与 retention consumer gate 通过。
首轮 teamlead 完成 1,200 文件，Vitest 汇总 30 个失败测试；自定义 receipt 的 failed 计数为 41，并记录一次缺失 mock 方法的异步错误。其它所有包通过。

修复：补齐两组 GatePoller mock 的新查询方法；founder 列表断言由旧的两项改为只显示有效状态的一项；审阅 ON/OFF 相同规则变化，并以固定补丁重放历史 bundle，更新兼容性说明与 source/bundle golden。`capture-rule-evolution.py` 先验证旧 bundle 完整哈希再应用固定补丁，两次运行产物字节相同。心跳断言及 FLY-1995 超时在单独复测中通过，未修改实现或放宽阈值。

自审增量：移除共享 reader 对 gate 节点名的硬编码（StateStore 已核快照权威）；回滚 inventory 必须提供字符串；移除误加的 StampDeps 字段。真实 StateStore custom gate 及三种输入负例先红后绿。临时副本类型检查因借用依赖链接出现三个既有迁移入口的 TS2742，不计为通过；原工作树 build 为正式证据。

修复后聚焦验证：5 文件 37 测试通过（原 aggregate 失败相关）；6 文件 48 测试通过（规则、权威、facts、page/title、rollback）。修复后 `pnpm lint` 通过，21 warnings。修复后的 `pnpm -r build` 通过。最终完整 gate 在最终 PR head 继续，最终结果通过 PR 与正式交接 receipt 记录，不将本首轮失败或聚焦测试冒充 aggregate 通过。

## Review 与 CI

原 head `4f1cd6eb7384fd4d78b0045b6e260a8e5e0205a9` review gate `2d88ee47-5afd-4e1b-a0dd-3c8e69a0640d` effective CHANGES_REQUESTED；CI `35049015888` 失败。返修后以新完整 SHA 的 effective verdict 与 CI 为准。

## 真机与视觉证据

- 真机 Discord title 点亮/熄灭：未执行。
- founder 真人回复：未执行。
- 固定页实际发布及截图：未执行。
- 本地 DOM/同源渲染断言：通过；本地 Chrome fixture 截图退出 134，无图片产物。
- QA 必须使用专属测试 thread/频道；本轮没有触碰 founder 的真实业务 thread，未 merge/deploy/restart。

## 2026-09-16 R1 返修验证

Lead 授权与具体修复见 repair-r1.md。真实 StateStore 中间 holder 排除证明先独立通过（1 项），在生产代码不变时将其接到 page sources；抽取共享 fixture 后两个套件 46 项通过。新增行为测试先复现 7 failed / 72 passed；修复后 6 文件 155 项通过，包含真实权限、alias 点亮/熄灭、同源端到端、缺链接摘要、visibility unavailable 和现有 title refresher 回归。

本轮 `pnpm lint` 退出 0（21 warnings），`pnpm -r build` 退出 0。完整包 gate、最终 head CI 与新一轮代码审查尚待执行/结果；本段不是完整 gate 通过声明。原 head CI 35049015888 的两处失败保留：旧夹具断言与 observation-performance 63.648ms > 50ms，未重跑。真机/固定页发布截图仍未执行。

### R1 完整包 gate（失败，不属于 RPC-only 可接受例外）

`VITEST_MAX_FORKS=1 pnpm test:packages:run` 在修复代码 head `64c2f0c474943b844f4be66f1f3aacd91a0e1e6e` 上完整执行，2026-09-16 05:09:53Z 退出 1；17 包全部跑到，13 passed / 4 failed。完整 receipt 见 `package-gate-repair-r1.json`。Vitest 汇总每个失败包均为 1 个失败测试，自定义 reporter 的事件计数并不等于失败测试数。

- claude-runner：1 failed / 1340 passed / 2 skipped；4096-file memory-seed 测试超过 60000ms。
- comm：1 failed / 2600 passed / 3 skipped；lead-registry migration-plan 测试超过 5000ms。
- config：1 failed / 842 passed；runner-config-writer symlink fixture 创建时 EEXIST。
- teamlead：1200 文件全部完成，1 failed / 15155 passed / 7 skipped；observation-performance tail 99.103ms > 50ms，另有一次 onTaskUpdate RPC 超时。性能测试不重跑、不改阈值；合入的 PR #1216 仅将其排除出 CI shards，不会改变本轮本地失败事实。

未将此 gate 报为 aggregate green 或 RPC-only 通过。合入 main 后的 lint/build、定向验证与最终 head CI 各自单列。

### 合入 main 后验证

代码 head `0284a1fb791b8875f0683318bf858ce730f5cd34`：`pnpm lint` 退出 0（22 warnings），`pnpm -r build` 退出 0；同一 6 个 attention suites 155/155 通过；CI structure shell gate 通过，retention consumer gate 8/8 通过。

使用各自全新 TMPDIR 单独复查：memory-seed 26/26、lead-registry-cli 31/31、runner-config-writer 21/21 通过；未修改测试/实现/时限。以上仅是窄验证，不是完整 gate 通过。

Lead 在 report question `629c2c04-8ae7-43fe-a85d-a8eff3118009` 回复：同时有 FLY-2612 和 FLY-2519 在该主机执行完整套件，按 host contention 处理本轮四项红；保留原 receipt，限定 config/lead-registry 独立验证通过即停止，不重跑 performance 或完整套件，之后一次 push/review，以新 head CI 为准。该主机并发信息来源为 Lead，未自行进行进程取证；本地 aggregate 仍记录 failed，未用 ruling 将其改写为 green。memory-seed 的额外窄验证在这条回复送达前已完成，之后未再重跑。

合入后的 `node --test scripts/__tests__/teamlead-shards.test.mjs` 9/9 通过，含新 CI performance 排除规则、完整覆盖和真实分片执行检查。

## Lead 补充核查返修

详见 followup-r2.md。原冻结 head 25506459c effective APPROVED，完整 CI 35058953080 success，原始结果已归档 code-review-r2.json / ci-r1-approved-head.json。新指令要求补修后台子任务链接与 Markdown founder 过滤，故该批准不能移用到后续 head。

新增行为先红：后台 child link undefined；34 条 Lead 问题混入 Markdown founder 区；Markdown 子任务未输出有效 thread URL。修复后：Bridge 接线完整套件 3/3，页面/物化/StateStore 绑定 60/60，最终 HTML/Markdown 渲染 90/90；相互重叠的套件不累加成总数。pnpm lint 退出0（22 warnings），pnpm -r build 退出0。保留一次组合测试中既有 Bridge 启动 5s timeout 的失败日志描述，未改时限；其后独立完整接线套件通过。未重跑完整包/性能测试，遵从 Lead 629c2c04 的限制。新 head 的 CI/review 仍需重新执行，真机与固定页发布仍未执行。
