# FLY-1942 通信层防线三件套 — C3 写入者实施证据
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: plan.md

## 范围与结果

实现 M2 发信前门 `runner-instruction-gate.ts`，接入 `land-cleanup-opportunity.ts` 与 `account-switch-consumer.ts`；不修改 StateStore 或其他写入者。活性来自 `resolveRunnerRecipientState`，即与 mailbox 同源的 StateStore 谓词。缺失/终结收件人跳过 mailbox，使用调用方提供的 issue/project/source 留持久事件，内容只存 SHA256 前 16 位。

Land cleanup 仅对 gate 接受的会话创建 shutdown control，requested/acked/timedOut 只统计接受集合，另回报 skipped。原 deterministic instruction ID、shutdown request ID 和正文保留。Account-switch 原 explicit ID 与 WAKE_TEXT 保留，跳过时增加 skipped_recipient，不清 declared state，不生成 account_switch_wake 事件。

## RED → GREEN

- 新 gate 测试先于模块创建：vitest 预期失败，无法解析 `runner-instruction-gate.js`；日志 `/tmp/fly1942-c3-gate-red.log`。创建最小模块后 **6 passed**，日志 `/tmp/fly1942-c3-gate-green.log`。
- 两个调用方先新增行为测试，再接门：**4 failed / 23 passed**。失败涵盖缺失/终结收件人仍收到 wake、land terminal 收件人仍计入及缺失 skipped 字段；日志 `/tmp/fly1942-c3-callers-red.log`。
- 接门后的第一次组合验证：**32 passed / 1 failed**，仅旧精确 outcome 断言缺新增 `skipped_recipient: 0`。同步该断言后运行最终组合：**33 passed / 0 failed**，3 个文件，日志 `/tmp/fly1942-c3-writers-final.log`。

最终命令：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/runner-instruction-gate.test.ts src/bridge/__tests__/land-cleanup-opportunity.test.ts src/bridge/__tests__/account-switch-consumer.test.ts
```

- Gate **6 tests**：真内存 StateStore + 真 CommDB；missing/completed/failed 零 unread 且 deterministic ID 全状态查询无行，event type/issue/project/source/content digest 正确；running/awaiting_review 接受；重放保留一个消息；explicit ID 的 inserted true→false。
- Land **2 tests**：原 shutdown ACK/bounded timeout 流；running/completed/failed 三会话仅一个通知/控制，返回 requested=1/skipped=2/acked=0/timedOut=1，两条 terminal audit。
- Account **25 tests**：保留原执行/回放/故障测试；新增 stale enumeration → 真 StateStore missing/terminal 两种状态，零通知、保留 declared state、审计和 skipped_recipient=1。
- 六个生产/测试文件 `pnpm exec biome check --write ...` 后检查通过；限定文件 `git diff --check` 通过。

## 合同细节与边界

`insertInstruction` 既有返回值是 string ID，即使 dedupe 重放亦返回该 ID；计划固定的窄依赖只有两种 insert API，未增加查询。故无 explicit instructionId 时 `inserted` 是 returned ID 的布尔值，**不能当作新行插入证明**。explicit-ID 分支原 API 返回实际插入布尔值。调用方只用 `queued` 控制行为；重放测试独立验证只有一行。

本证据为写入者范围，fallback 通知由主 runner 独立实现/测试。未运行 teamlead build（与主 runner 协调由其统一执行），未提交/推送、未操作生产 DB 或服务。零 schema 改动；revert 后恢复原写入者行为，已写 skip 事件无需迁移。
