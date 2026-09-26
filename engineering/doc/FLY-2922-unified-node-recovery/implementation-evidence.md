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
