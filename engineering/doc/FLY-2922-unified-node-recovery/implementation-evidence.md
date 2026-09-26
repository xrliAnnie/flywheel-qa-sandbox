# FLY-2922 实现证据与剩余合同 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-26
基于: plan.md

当前仍在 implement；以下是第一块实现证据，不是整单验收、QA、CI 或 handoff 证明。批准计划正文保持 SHA-256 `7de9bef9d44818fa2a689a98dc517087154cafbe568126e6cb2aeb4edf11a1c5`，有效设计门 `d9ab4f85-f464-4fee-9c09-7af6295b0c9a` 已重新查询为 APPROVED。

## 第一块：FLY-2191 的恢复证据保留

根因在 `StateStore.pruneWorkflowDeadExecutionWatches`：原 SQL 把 TTL 到期、孤儿、run 非 active 三项用 OR 连接，因此 held 的新 watch 当即被删，active 的旧 watch 到 TTL 被删。dispatcher 在探测前调用此清理，所以旧体跨 TTL 再活动时没有证据可探。

按计划 §3.4 改为：只有 run completed/terminated 或确为孤儿，且达到 TTL 才可清理；active/held 的 active/tripped watch 保留，未知 run 状态保守保留。每批 200 条上限维持。未增加新 watch 状态或迁移。

- 红：StateStore 五个保留/终态 TTL 用例、dispatcher 两个重启后探测用例、孤儿批量边界用例共八个都在旧 SQL 上按预期失败。
- 绿：`vitest run` 按 `FLY-2191|retention TTL` 筛选，2 文件 / 8 用例通过。
- 定点完整文件：`StateStore.fly1385-dead-exec.test.ts` + `workflow-engine-dispatcher.test.ts`，151 passed / 1 原有 skip。skip 是原 #705 的非终态 session 管理拒绝，用例本来停用，不能算通过。
- `pnpm --filter "flywheel-teamlead..." build` exit 0，13 个受影响包及依赖。
- `pnpm lint` exit 0，25 warnings（仓库已有未改部分）；没有自动改动无关文件。
- FLY-1560 lexical guard 和 FLY-2567 compatibility guard：2 文件 / 24 tests passed。
- 受限 `vitest related`：同 2 文件 / 151 passed / 1 原有 skip，exit 0。配置只限制文件范围，保留原 setup/serial/超时。
- FLY-2211 kill-path inventory：1 文件 / 5 tests passed，exit 0。
- `git diff --check` exit 0。

日志（本机、非公开产物）：`/tmp/fly2922-watch-red.log`、`/tmp/fly2922-watch-orphan-red.log`、`/tmp/fly2922-watch-dispatcher-red.log`、`/tmp/fly2922-watch-green.log`、`/tmp/fly2922-watch-related.log`、`/tmp/fly2922-watch-vitest-related.log`、`/tmp/fly2922-watch-guards.log`、`/tmp/fly2922-watch-process-guard.log`、`/tmp/fly2922-build-preflight.log`、`/tmp/fly2922-lint.log`。

## 剩余批准合同（未实现或未验收）

1. 九张原单与新增 2901/2914 独立真实夹具，公共 stage/apply 到 dispatch 消费的证据；FLY-2191 的整个恢复链仍依赖统一入口。
2. canonical v2、receipt nullable 列、统一 hold 投影/历史 superseded 分类/active orphan、同事务真实 mint/CAS/权限与 replay。
3. 非根 lineage、根 startAuthority、rework/land/gate/state-only/recorded decision 消费、准入前失败 producer；保留设计 advisories 中的根连续性语义、排除 land/gate、pending 无 binding/owner 的事务内未启动证明。
4. enrolled complete 顺序/blocked failure 入口、删除 reconstruct_completion 例外，legacy 路由隔离。
5. carrier-close 不终结 run、done-close/显式 terminate、额度 target CAS 与旧请求 fence；watch 部分仅完成上面的独立 slice。
6. 完整消费者 sweep、其余守卫与定点验证、literal-last milestone、commit/push/PR、effective code review、正式 report + needs_review receipt + park。

最初通信 health 超时导致三个 stage 排队，progress CLI 以旧 onboard 阶段拒绝。已通过 ask --report `b47da4e1-7d60-4abf-8869-b6ef7783bcdc` 报 Lead；恢复后 progress CLI 成功提交 `bc80001e1`（implement 0/6）。未改通信库或伪造回执。


## 2026-09-26 implement 重开：准入前 producer WIP 审计

基线 `7e52c8dba` 含保留 WIP `d35da9cde`。TURN 为 implement / epoch 8，execution `76dcb547-4e56-43b6-8700-b04975fce7e0`。本块没有完成统一恢复事务，六组剩余合同不减少。

- MEDIUM `preadmission-producer-rework-carveout`：StateStore 在读取最新 dispatch 且证明 pending / 无 binding、activation、owner、completion 后，按持久 reason 的 `rework_replacement:` 前缀或同 tuple 的 open rework target 明确返回 `rework_delivery_owned`。不写 run hold、诊断 episode 或改变投递，由 FLY-2921 coordinator 计数。直接调用 producer 的两个反例（正常 reason、错误 reason 但有持久目标）在修改前均错误返回 held；修改后同时验证 run/node/delivery/events/ledger 未变。普通节点的结构性拒绝、跨重启暂时错误计数和 admission 竞争保护继续通过。
- WIP 构建失败根因：准入失败错误调用只接受死体复活 disposition 的 `workflowDeadExecutionAlertPayload`，还会发送 FALSE-POSITIVE 标题。先加断言复现错误标题，再改为准确的准入失败告警，并在 StateStore/LeadAlertNotifier 两端既有 metadata union 中声明 `pre_admission_failed`。没有放宽原死体复活 helper。
- WIP dispatcher 的一处长行格式已按 biome 修正。
- 原 WIP producer 的红测试历史未经此轮重新证明；本轮为上述 carveout / alert 补有明确红绿证据，不将继承测试的现状称作新增 TDD。

当前已核验本机证据（不等于整单完成/QA/CI）：

| 范围 | 结果 | 日志 |
|---|---|---|
| carveout 红 | 2 failed，实际错误返回 held | `/tmp/fly2922-rework-carveout-red.log` |
| 告警红 | 1 failed，实际错误标题 FALSE-POSITIVE | `/tmp/fly2922-producer-alert-red.log` |
| producer/FLY-2504 子集 | 21 passed | `/tmp/fly2922-producer-green.log` |
| dispatcher + dead-exec 两个完整定点文件 | 165 passed / 1 原有 skip | `/tmp/fly2922-producer-focused.log` |
| owning-package vitest related，配置仅限上述两个相关文件 | 165 passed / 1 原有 skip | `/tmp/fly2922-producer-related.log` |
| FLY-1560 / FLY-2567 / dispatch seam / FLY-2248 守卫 | 4 files / 41 passed | `/tmp/fly2922-producer-guards.log` |
| FLY-2211 kill-path inventory | 1 file / 5 passed | `/tmp/fly2922-producer-kill-guard.log` |
| pnpm lint | exit 0，25 warnings，未自动改无关代码 | `/tmp/fly2922-producer-lint-green.log` |

消费者 sweep：按四个变更 TS 文件的完整路径、文件名、父目录执行 `git grep -lF`，1872 个去重匹配保存于 `/tmp/fly2922-producer-consumers.json`，每条处置在 `/tmp/fly2922-producer-consumer-disposition.tsv`。精确符号 sweep 证明 producer 的唯一生产调用在 dispatcher catch；诊断事件无其他当前消费者。保留上述结构/兼容/进程守卫，文档、证据和其他 StateStore 子系统的路径引用按本 slice 排除。后续恢复/complete/close/receipt schema 变更必须重新选测，不能沿用本块排除结论。未执行本地全包或全仓测试。

Lead 对 question `d0680b7b-9362-4d25-8126-f43dbea7ddf5` 的当前答复：FLY-2921 仍在实现，无 PR/可同步实现 SHA，合入顺序未定；本单不等待，后合者同步全部 pending 消费路径、不 force-push。已通过 report `489b839e-18a0-4624-9e20-6ec0661cb1ef` 确认。PR 仍未创建，该 merge-order 约束必须写进最终 PR body。

本块追加验证：
- `pnpm --filter "flywheel-teamlead..." build` exit 0（`/tmp/fly2922-producer-build-final.log`）。
- LeadAlertNotifier 的受限 related：1 file / 69 passed（`/tmp/fly2922-producer-alert-related.log`）。
- 公共 dispatcher 真实替身的无效/超长 context 两个负控追加断言 run active、零 recovery episode：2 passed（`/tmp/fly2922-producer-rework-consumer.log`）。
- 全仓 lint 最后一次 exit 0（`/tmp/fly2922-producer-lint-final.log`）；测试追加断言后 3 文件 biome 检查通过。
- dependent typecheck 首次因缺少 voice-bridge dist 失败；`pnpm --filter "flywheel-voice-bridge..." build` 补齐后，`pnpm --filter "...flywheel-teamlead" typecheck` exit 0，teamlead/voice-codex 均通过（`/tmp/fly2922-producer-dependent-types-verified.log`）。
