# FLY-2314 Terminal 能力守卫 — 实施计划
Issue: FLY-2314 (https://linear.app/geoforge3d/issue/FLY-2314/判据卫生-macos-terminal-测试的-skip-守卫只查-which-osascript不查-terminalapp-能否解析)
日期: 2026-09-03
基于: research.md

## 目标

把 `packages/core/test/tmux-viewer.macos.test.ts` 的真实 GUI suite 守卫从“`osascript` 二进制存在”改为“当前 process context 能完成 Terminal 字典读取与 Apple-event 往返”，同时保留可驱动环境中的真实覆盖，并用确定性测试杀死退回 `which osascript` 的变异。

## 锁定改动

仅修改：

- `packages/core/test/tmux-viewer.macos.test.ts`
- FLY-2314 doc-flow 文档
- 最后一个独立 commit 中的 `engineering/doc/milestones/FLY-2314.md`

不修改：

- 两条既有真实 GUI 测试的主体与断言
- `packages/core/src/tmux-viewer.ts` 或其他生产代码
- runner PATH、`osascript` 安装/发现机制、CI 平台配置

## TDD 实施顺序

### Slice 1：不可解析 Terminal 时 fail-closed

1. 先拍旧文件基线，记录失败/skip 的具体用例名；环境结果只描述当前 process context，不外推到主机。
2. 在同一测试文件、真实 GUI `describe.skipIf` **之外**加入 always-run 的守卫回归 `describe`。先只加 B 用例，它传入 macOS 平台与一个边界 fake：
   - 若收到 `which osascript`，返回 `/usr/bin/osascript`；
   - 若收到精确的 `osascript -e 'tell application "Terminal" to count windows'`，抛出含 `Can't get application Terminal` 的错误；
   - 其他调用也抛错。
3. 用 `--reporter=verbose` 运行定向 Vitest。RED 的有效判据不是 rc 非零，而是失败集合明确包含新增 B 用例，且 diff 为 `expected false / received true`；既有 GUI 失败不能代替这个签名。
4. 最小实现：
   - 将 helper 改名为 `terminalAppAvailable`，保留窄 dependency injection；
   - 接受默认 `platform = process.platform` 与默认同步执行器 `execFileSync`；
   - 非 Darwin 短路；Darwin 运行只读 probe `osascript -e 'tell application "Terminal" to count windows'`，15 秒 timeout；任意异常返回 `false`；
   - collection 时只计算一次 capability。
5. 重跑定向测试。GREEN 的有效判据是 verbose 输出中新增 B 用例明确 `passed`；不能只看文件 rc=0，因为 GUI suite 合法 skip 时 Vitest 也返回 0。

### Slice 2：可解析侧与非 macOS 侧

1. 在 always-run `describe` 中加阳性回归：精确 probe 成功时返回 `true`，fake 对 `which` 或其他命令抛错。
2. 加非 Darwin 回归：返回 `false` 且执行器零调用。至此三条 guard tests 都必须在 verbose 输出中明确 `passed`，自身 skipped 计数为 0。
3. 再走一个 RED→GREEN 小循环加入 `terminalAppSkipReason`：
   - 非 macOS reason 与“macOS、当前 process context 无法驱动 Terminal.app”reason 不同；
   - capability 为 true 时 reason 为 `null`；
   - suite 的 `describe.skipIf` 和显式 skipped fallback 复用同一个 reason，禁止 macOS 退回裸 `skipped`。
4. 在实施 lane 先记录真实 probe 的当次 rc/output，再运行定向文件，断言 `terminalAppAvailable` 与 probe 同值，GUI suite 的 run/skip 与该值一致；不预设这次一定是哪一侧。
5. 为验收 A 打开 non-blocking Lead question gate，请 `flywheel-eng-lead` 协调一个当次 probe 为 true 的 GUI-capable process，在 **exact implementation head** 运行同一定向命令。硬证据必须包含两条既有 GUI 用例名均为 passed、不是 skipped。没有这份证据不得声称 A 完成或结束节点。
6. milestone 记录 exact head 上 A/B 两侧各自的执行上下文、probe 结果、用例级 run/skip 结果，避免真实 GUI 覆盖以后静默 dormant。

## 变异验证

在拿到 TURN 的当前工作树中做可逆的就地变异，避免新 git worktree 缺少被忽略的 `node_modules` 而产生模块解析假红：

1. 记录目标文件 SHA-256，并保存正向 patch。
2. 用 `apply_patch` 将新 probe 精确退回旧实现 `which osascript`；断言旧调用存在、新调用不存在，证明变异确已落地。
3. 运行定向测试；失败集合必须包含 B 用例名，且该用例的 diff 恰为 `expected false / received true`。模块解析、既有 GUI 用例或其他红不构成变异证据。
4. 用 `apply_patch` 逆转变异；确认目标文件 SHA-256 与第 1 步逐字节一致，重跑定向测试并确认三条 always-run guard tests 明确 passed。

## 验证矩阵

| 场景 | 输入 | 预期 |
| --- | --- | --- |
| A1 unit | Darwin；Terminal `count windows` probe 成功 | guard `true` |
| A2 real | GUI-capable process；exact head 真实 probe 成功 | 两条既有 GUI 测试均明确 passed，非 skipped；Lead gate 回传用例级证据 |
| B unit | Darwin；`which` 成功、Terminal probe 抛错 | guard `false` |
| B real | implement process 的当次真实 probe | guard 与 probe 同值；若 false，GUI 两条 skip 且 reason 点名当前 process context |
| C unit | 非 Darwin | guard `false`，零子进程 |
| Mutation | probe 退回 `which osascript` | B unit 红 |

## 完成步骤

1. 对照 diff 确认既有两条 GUI 断言未改，提交实现小 commit，并更新 progress ledger。
2. 运行精确 full-repo gates：
   - `pnpm lint`
   - `pnpm -r build`
   - `pnpm test:packages:run`
   - 本次若新增任何 `scripts/__tests__/*.test.sh`，逐一执行（计划不新增）。
3. 进入 `code_review`，按节点协议通过 `codex:rescue` 执行 review；随后用 `review_code` gate + `request-review --type code` 注册正式交叉评审，轮询 verdict。任何 blocking finding 修复后重新跑相关验证并开启新 review round。
4. push 已评审分支并创建 PR；随后新增 `engineering/doc/milestones/FLY-2314.md` 为独立 literal last commit，再 push 该最后 commit。
5. 立即在不可逆动作前复查 inbox；通过唯一报告渠道发送 DONE；运行 `complete --route needs_review --pr <NUMBER>`，不 dispatch QA、不 merge、不 deploy。

## 完成判据

- A 侧有 GUI-capable process 在 exact implementation head 上真实运行两条既有 GUI 用例的 passed 证据；B 与非 macOS 有 always-run guard tests，实施 lane 若当次 probe 为 false 还须有真实 skip + 明确 reason 证据。
- 旧 `which osascript` 变异确实被 B 测试杀死，且有落地/预期红/还原三段证据。
- 三条 guard tests 位于 skip suite 外且在 verbose 输出中明确 passed；任何 `Test Files skipped` 的 rc=0 都不能代替。
- 两条真实 GUI 测试断言未被修改。
- 全仓 gates 与正式代码评审通过。
- PR 已开，milestone 为最后 commit，节点以 `needs_review` 路由交还 DAG。
