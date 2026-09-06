# FLY-2298 founder_review 等待判据 — 实施证据
Issue: FLY-2298 (https://linear.app/geoforge3d/issue/FLY-2298/病根-dwell-的是否等-founder判据不认-founder-review-卡-question-checkpoint)
日期: 2026-09-06
基于: plan.md

## TDD

- RED：`node-dwell-control.test.ts` 因 `readOpenFounderReviewGates is not a function` 失败；规则合同因缺少第三判据失败。
- RED：`lead-patrol-snapshot.test.sh` 为 founder_review 新增的 8 条 route/episode 断言全部失败，既有用例继续通过。
- GREEN：定向 TypeScript 合同 39/39 通过；完整 patrol shell 329/329 通过。
- Review round 1 的 MEDIUM advisory 指出两个缺口：上一轮迟到的 `waiting_founder` 收据可能按时间戳吞掉新卡，以及缺少 cross-run/cross-execution 和终态 gate 的负向覆盖。
- RED：迟到收据 fixture 在新卡 episode 上错误产生 `waiting_episode_reminded=yes`；writer 在缺少 episode provenance 时错误接受 `waiting_founder`；新增 cross-run/cross-execution 与 answered/superseded/disposed fixtures 固定 exact-match 边界。
- GREEN：`waiting_founder` 收据现在必须携带快照行的 `episodeStartedAt`，旧表原位迁移并保留 legacy rows；定向 TypeScript 41/41、完整 patrol shell 331/331 通过。新卡只接受 exact episode 收据，上一轮迟到/legacy 收据不会抑制新 episode。
- Review round 2 的两个 MEDIUM advisory 继续沿同一 contract 收口：RED 证明 founder_gate/approve 路径仍会用迟到 `examined_at` 吞掉新 episode，且 writer 会接受早于节点或位于未来的合法格式时间；GREEN 后三个 founder-wait 形状全部按 exact episode 去重，writer 以 `episode_before_node` / `episode_in_future` fail closed，定向 writer 11/11 与 patrol shell 331/331 通过。

## 代码审查

- guarded `codex:rescue` companion 已按要求调用，但本机 nested macOS seatbelt 在读取仓库前即以 status 71（`sandbox_apply: Operation not permitted`）退出；该启动失败不作为审查 verdict。
- 正式 code review round 1：question `92cd3800-d2c0-4a8a-8d81-6ead16a8e2e1`，request `d694a78e-8ace-4696-aec5-9fa2c9611fec`，reviewed head `f089ca30cdf6d00eee9734c617bdeda010ff5791`；`APPROVED`、无 blocking finding，两个 MEDIUM advisory 已全部以回归测试和上述 episode provenance 修复。Lead advisory report：`0c4a33e7-3836-48cf-b42c-6c891a396cee`。
- 正式 code review round 2：question `e122649f-d024-47cd-b63e-08d2464f44f5`，request `4774d3d5-abce-4fdc-a40a-d4215c7f58ef`，reviewed head `a1594f717f64ecf88eac23f2c7a289d12353d424`；`APPROVED`、无 blocking finding。两个 MEDIUM advisory 已用统一 exact-episode 比较和 writer 时间线校验修复；Lead advisory report：`dac07865-c637-45ca-9171-3523a00f918a`。
- 正式 code review round 3：question `7bd19d7e-e674-4fdc-9d9e-923edbd664ad`，request `852669eb-a364-4a25-a6f0-0702291b7acf`，reviewed head `f0ca875f05177a4422cae1f962a08711c6766af8`；`APPROVED`、无 blocking finding。两条 LOW advisory 已按 `[lead-instruction dbd13db2-6615-479c-a7b5-937846c510bf]` 作为最终 residue 记录，不开 round 4；Lead advisory report：`d221850d-d799-4727-b033-a082aba3a423`。

## Residue

- 迁移前的 `waiting_founder` 收据没有 `episode_started_at`。部署后的首个 patrol tick 会把仍在等待的 legacy episode 各重武装一次；新收据落库后恢复 exact-episode 抑制。这是一次性、fail-loud、自愈的兼容性副作用。
- writer 当前覆盖生产 `workflow_run_node.started_at` 的 SQLite UTC 空格格式与带时区 ISO 格式；若未来写入方引入不带时区的 `YYYY-MM-DDTHH:MM:SS`，`Date.parse` 会按本地时区解释。当前生产写入点不可达该形状，后续扩展写入域时应先统一时间归一化。
- 获批 `plan.md` 的 design-review blob 已 pinned，implementation 节点按不可改写边界未回写计划正文；以上 residue 记在本实施证据和 PR 交付说明中。

## macOS GUI 排除口径

Lead 对问题 `01b0f3b0-0052-4ef9-a600-a015fd8d0f40` 的批准原文：

> Approved gate shape (same as FLY-2239 #1093 and FLY-2337 precedents): run the full-repo gate with packages/core/test/tmux-viewer.macos.test.ts explicitly excluded, and record the exclusion verbatim in implementation-evidence.md as the approved macOS GUI exclusion. Constraints: single worker, --pool=forks --poolOptions.forks.maxForks=1 (VITEST_MAX_THREADS is inert here), because four bodies share this machine and parallel full packages collide. The exact unfiltered gate is what CI runs on the PR head; treat CI 14/14 green as the authority for the exact gate and your local run as confirmation, not the other way round. Do not open Terminal.app under any variant.

本地 full-package gate 因此必须显式排除 `packages/core/test/tmux-viewer.macos.test.ts`，并以单 worker forks 运行；PR exact head 的未过滤 CI 14/14 才是准确全仓门的权威证据。

## 最终验证

- `pnpm lint`：exit 0；只报告仓库既有 warning，没有 error，也没有自动改写。
- `pnpm -r build`：exit 0。
- 定向 TypeScript：`pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.node-dwell-review.test.ts src/__tests__/node-dwell-control.test.ts src/__tests__/fly369-patrol-rule.test.ts`，3 files、41 tests 全绿。
- 修改过的 shell suite：`bash scripts/__tests__/lead-patrol-snapshot.test.sh`，最终复跑 331 passed、0 failed。
- 第一次 packages 尝试在参数前误加了 `--`，使 Vitest exclusion/worker 参数没有生效；该次不是合格门禁，也不作为最终证据。它得到 3 个并发/环境红灯，其中两项在正确串行复跑中转绿。
- advisory 修复后再次运行精确根脚本：`pnpm --workspace-concurrency=1 test:packages:run --exclude '**/tmux-viewer.macos.test.ts' --pool=forks --poolOptions.forks.maxForks=1`。结果为 846 files / 11,271 tests passed，6 skipped；唯一红灯仍是无关的 FLY-2118 真 tmux fixture：本机 tmux 拒绝含 TAB 的窗口名 `SCRATCH\\tTAB`（`invalid window name`）。FLY-2298 的 `node-dwell-control` 11 tests、StateStore legacy migration 2 tests 与规则合同 28 tests 均绿。
- 正确复跑没有收集 `packages/core/test/tmux-viewer.macos.test.ts`，没有打开 Terminal.app 窗口。teamlead 的既有 post-ship cleanup 用例仍尝试执行 `osascript`，但当前 runner 与 HiServices 连接失败并返回 syntax/connection error；测试按既有容错语义继续通过。这不是被排除的 GUI 专项文件，也没有形成窗口。
- 按 Lead 批准口径，本地带排除的结果是确认性证据；PR exact head 的未过滤 CI 14/14 仍是准确全仓门的权威证据，待 PR 后补录。
