# FLY-2377 Self-ship 后线程立即归档 — 实施证据
Issue: FLY-2377 (https://linear.app/geoforge3d/issue/FLY-2377/self-ship-后-issue-thread-立即归档去掉最后一条消息后安静-60-分钟窗口founder-2026-09-06-选-b)
日期: 2026-09-06
基于: plan.md

## 交付结果

- post-ship finalization 继续使用 terminal authority 与既有 FLY-2028 frontier/补偿路径，但显式选择 `timing: "immediate"`，不再等待最后消息后的 60 分钟安静窗口。
- 每次 execution 或 land closeout 为每个线程生成确定性 `post_ship_archive` receipt；完全匹配的热库或冷库 receipt 会直接完成重放，不再读取或 PATCH Discord，因此 founder 后续重新打开线程不会被旧 closeout 再次归档。
- receipt 缺失时仍执行 Discord 现态、frontier fence、归档后验证与 reopen 补偿；receipt payload 无效或不匹配时 fail closed。
- 已移除 post-ship-only quiet queue 注入和 enqueue；非 ship 的 done-cleanup / terminate / abandon 调度与 `ISSUE_THREAD_QUIET_WINDOW_MS` 常量保持原语义。

## TDD 证据

按 RED → GREEN 顺序覆盖：近期消息立即归档、热/冷 receipt replay、精确 `session_event_replay` 竞争、已有本地 epoch 且 Discord 已归档、无本地 epoch 但 Discord 已归档、旧 epoch 重开后的 immediate 路径、PATCH 后仍 open 的失败、post-ship 顺序与 frontier 变化、post-ship queue wiring 删除、补偿先于 receipt replay、payload mismatch/invalid、founder 重开后相同 receipt 零 Discord I/O、land operation stale epoch。

- 归档与 post-ship 聚焦套件：5 files / 133 tests passed。
- 相关 wiring 集成套件：5 files / 66 tests passed。
- fetch stub hygiene：2 files / 64 tests passed。
- TeamLead 最终提交头全套：858 files / 11,412 tests passed / 6 skipped；无断言失败。Vitest 在全部断言结束后仍报告既有 `[vitest-worker]: Timeout calling "onTaskUpdate"`，因此进程退出码为 1。

## 全仓门禁与宿主隔离

- `pnpm -r build`：21 个 workspace 全部通过。
- `pnpm lint`：本次变更的 13 个可处理 TS 文件全部通过 Biome；根命令仍因 `packages/teamlead/src/StateStore.ts` 超过 1 MiB 上限退出 1。该文件在 `origin/main` 已为 2,163,682 bytes，本次新增后为 2,164,932 bytes，因此不是本单引入的阈值越界；未为本单放宽 lint 配置。
- `pnpm test:packages:run` 的安全等价运行显式排除 `packages/core/test/tmux-viewer.macos.test.ts`，避免 resident 宿主实际驱动 Terminal.app。默认聚合在 TeamLead 高并发下出现一个 mailbox cleanup timeout 与本次相关的旧审计断言；后者已按确定性 receipt 契约修正，前者隔离连续两次 19/19 通过。最终单并发聚合在未改动的 `flywheel-comm/visual-capture` 出现一次锁级联，隔离复跑 65/65 通过。最终 TeamLead 全套断言结果见上。
- `bash scripts/__tests__/fly2045-milestone-layout.test.sh`：32/32 passed。
- 本单未新增或修改 `scripts/__tests__/*.test.sh`；没有 rendered surface，视觉核验不适用。

## 边界

未修改获批 `plan.md`、`CLAUDE.md`、done-cleanup / terminate / abandon 的归档语义、quiet-window 数值、线上配置或 secrets。未 dispatch QA、请求 ship approval、merge、deploy 或重启服务。
