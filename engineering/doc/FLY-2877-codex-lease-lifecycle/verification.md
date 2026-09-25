# FLY-2877 Codex lease 生命周期 — 实现验证记录
Issue: FLY-2877 (https://linear.app/geoforge3d/issue/FLY-2877/病根codex-lease-codextmuxadapter-在-runner-的-codex-进程仍活着时就释放了-flywheel)
日期: 2026-09-25
基于: plan.md

## 1. 本地定向验证（实现节点，本机，不是 full CI）

| 项 | 命令 | 结果 |
|---|---|---|
| lint | `pnpm lint` | exit 0；0 error / 26 warning。本 diff 文件里只有 `plugin.ts` 两条 `useConst`，`origin/main` 上同一文件同样两条（既有，非本单引入） |
| 构建 | `pnpm --filter "flywheel-teamlead..." build` | exit 0（含 claude-runner、edge-worker） |
| 依赖方类型检查 | `pnpm --filter "...flywheel-claude-runner" typecheck` | exit 0：claude-runner / edge-worker / voice-bridge / teamlead / voice-codex 全 Done（voice-codex 首次因 voice-bridge 未构建报 TS2307，构建依赖后复跑通过） |
| claude-runner `vitest related` | `vitest related src/codex-process-snapshot.ts src/codex-home.ts src/CodexTmuxAdapter.ts src/index.ts --run --exclude "**/tmux-viewer.macos.test.ts"` | 11 文件 / 633 条全过 |
| claude-runner 其余保留 | `test/kill-path-inventory.test.ts` | 5/5 |
| teamlead `vitest related` | `vitest related src/bridge/codex-runner-orphan-reaper.ts src/bridge/codex-session-reown.ts --run` | 105 文件 / 1277 条全过 |
| teamlead 定向 | orphan-reaper、session-reown、vitest-codex-home-isolation、run-infra-window-authority | 4 文件 / 98 条 |
| teamlead 结构/消费者 | codex-recovery-context、isolation-boundary.real-process、StateStore.land-carryover、fly2268-mechanism-guards、runs-route-registration、bridge-child-process-census；land-executor | 6 文件 / 44 条；1 文件 / 53 条 |
| edge-worker | Blueprint.fly1356-skill-framework、Blueprint.fly2359-memory-seed | 2 文件 / 66 条 |
| config（读 plugin.ts 的结构测试） | drift-scan、feature-flags-drift、feature-flags-registry、feature-flags-store-policy | 4 文件 / 117 条 |
| scripts（按全路径命中） | codex-guard.test.sh、runtime-role-auto-qa-retirement.test.sh、codex-home-reconcile-cadence.test.sh、fly1674-residue.test.sh；qa-codex-lead-parity / ship-judgment-timer / qa-fly-2456-observe / qa-fly-2456-scan（node --test） | 全部 exit 0（49 / PASS / PASS / 85；9 / 2 / 61 / 46） |
| T7（FLY-2523 不放宽） | `git diff --stat origin/main -- packages/teamlead/src/codex-quota/` | 空 |

没有本地全量包测试；full suite 证据只认 QA 冻结头上的 exact-head CI（`CI OK`）。

## 2. 变异验证

* 收尾对在途 reassert 的 join：临时删掉 `if (leaseReassertInFlight) await leaseReassertInFlight;` 后，「joins an in-flight reassert before retiring…」用例变红（`expected 'probe' to be 'restored'`）；恢复后转绿。第一版用例靠竞态取胜（删掉 join 仍然绿），已改为按事件顺序断言。
* probe 透传：adapter 与 codex-home 测试文件把默认 probe mock 成「无持有者」。882（keyed 正常收尾）用例关闭有界等待、只注入 live probe，若 adapter 没把 probe 传给 `retireCodexExecutionHome`，默认 probe 会放行删除，用例必红（实现前 RED 即此形态）。

## 3. 消费者发现（`git grep -lF` 全路径 / 文件名 / 父目录）

保留并已运行：上表所列全部文件。

排除及理由：
* `product/doc/**`、`engineering/doc/**`、`review.json`、`packages/teamlead/ci-test-costs.json`、`kill-path-inventory.json` / `child-process-census.json`（由对应守卫测试读取，守卫已运行）——数据或文档，无可执行断言。
* `packages/voice-codex/src/__tests__/codex-home.test.ts`——导入的是 voice-codex 自己的 `../codex-home.js`，不是 claude-runner 的模块。
* `scripts/lib/qa-fly-2456-*.mjs`——只引用审计 source 字串 `bridge.codex-session-reown` 与路径文案，本单均未改；其测试（observe / scan）仍已运行。
* 文件名 `index`、`plugin`、`Blueprint` 与父目录的命中（1313 / 484 / 167 及数十至数百条）——同名的其他模块或整包目录，不是本次改动的直接依赖；本次对这三个枢纽文件的改动是局部的（根导出增量、维护 tick 一段、未交接回滚一处日志），其直接依赖测试已按 `vitest related` 与全路径命中覆盖。
* `vitest.setup` 文件名命中的 4 个测试文件——只在注释里提到 teamlead 的 `vitest.setup.ts`（drift-scan 读的是 voice-bridge 的 setup）。

## 4. 与 plan 的偏差（均为更保守方向）

* T0 的「同一 pid+lstart 在 args 快照出现两行」：plan 写 → unattributed；FLY-2869 源码与其 fixtures 实际是整份快照 `process_authority_invalid`。按「逐条复制，不自拟」照搬 2869（probe 结果同为 unknown）。
* T0 的真 `ps` 用例只在 darwin 跑（`-E` 是 macOS 语义；CI 是 Linux）。本机已跑通。
* 持有者匹配对 `CODEX_HOME` 与 home 做词法规范化（`path.resolve`）后比较：尾斜杠不会让活进程「看不见」。
* 清扫额外跳过「本 Bridge 进程内正被 adapter 持有」的 exec（`codexExecutionOwners.isExecutionOwned`），与 orphan reaper 用同一判据。
* 启动 janitor 保留「无 lease 的 home 擦凭据」原语义（通过加锁复核的 `scrubIdleCodexAgentHomeCredential`）；janitor 改为逐条调用 `scrubCodexAgentHomeLeaseEntry` 后，token 不合法的 lease 条目从「照删」变为 `entry_invalid` 保留。
* 为钉新收尾顺序，除 plan 点名的「request-bound phase shutdown…」外，还更新了两条既有顺序断言：「ordinary Codex …」（改名）与 FLY-1239「teardown cancels reopen…」（`drained < killWindow` → `killWindow < drained`；该用例的本意「cancel 先于 stop」保留）。

## 5. 代码审查

* R1（Codex companion，xhigh，thread `01a0d7f4-9d5b-7181-8503-eefbe49f6316`）：CHANGES REQUESTED，1 条 HIGH —— founder TUI 的创建尝试若超过 teardown join（2 s）仍未结算，FLY-1239 允许它在 `execute()` 返回后才建窗；收尾却会据一次空探测删掉 lease，而自愈已停，晚到的 `codex resume` 会活在无 lease 的 home。
  * 修法（fail closed，无新机制）：join 超时即置 `lateTuiWindowPossible`，两条收尾分支都跳过有界等待，以 `retireOnce({ keepLease: "late_tui_window" })` 收尾 —— keyed home 的 lease（连同凭据）保留并记日志 `keyed_home_lease_retained … reason=late_tui_window`；`retireOnce` 的 memo 使 `runWithOwnership` 的补刀 retire 成为空操作。晚到的窗口仍由既有 late cleanup 杀掉；lease 之后由维护 tick 的清扫（>10 min、无持有者）收走。
  * 回归：ordinary / controlled 两条分支各一条「attempt 超过 join → lease 仍在、探测未被调用、late cleanup 后仍在」，外加「attempt 在 join 内结算 → 照常释放」对照；实现前前两条 RED。
  * 复跑：claude-runner `vitest related` 11 文件 / 636 条全过。
* R2（同线程 resume）：CHANGES REQUESTED，1 条 HIGH —— `keepLease` 只挡住收尾；维护清扫按 lease mtime（admission 时刻）判 10 分钟，长任务在 owner 释放后，清扫可能抢在晚到窗口启动前删掉 lease。
  * 修法（复用既有进程内 fence，不靠时序）：清扫本就跳过 `codexExecutionOwners.isExecutionOwned`，而 adapter 用的是同一个注册表（plugin → run-infra → adapter deps）。`executeOwned` 把「晚到 attempt 结算 + late cleanup 完成」的 promise 交给 `runWithOwnership`，后者在它结算后才释放 ownership。于是「窗口仍可能出现」期间该 exec 一直是 owned，清扫（以及 reown / orphan reaper / terminal harvest 等所有看 ownership 的扫描）都跳过它；结算后窗口已被 late cleanup 杀掉，清扫的持有者探测才有意义。
  * 回归：两条 late 用例加断言「execute 返回后仍 owned、late cleanup 后才释放」；新增「旧 lease：收尾返回 → 模拟清扫（与维护 tick 同一判定：owned 则跳过，否则 janitor 原语）→ skipped → 窗口创建并被清理 → ownership 释放 → 再清扫才 released」；对照用例断言 attempt 按时结算时 ownership 立即释放。实现前 3 条 RED。
  * 复跑：claude-runner `vitest related` 11 文件 / 637 条全过。
  * 边界：fence 在进程内。若 Bridge 恰在晚到 attempt 未结算时重启，内存里的 ownership 随之消失；该 attempt 的 helper 子进程也随 Bridge 被 abort/终止，残余窗口期与既有「重启时进程起落」同类，未另加机制。无注册表的构造（`executionOwners` 未注入，仅测试/旧调用）没有此 fence，生产 run-infra 总是注入。

## 6. 现场证据（只读）

* 本会话开始前，生产 `~/.flywheel/codex-homes/agents/flywheel/implement/.flywheel-leases/` 已为空，目录 mtime `2026-09-25 00:47:13`；02:1x 只读快照显示 b6c738ca 的 daemon + TUI（2 个）与 37624e3d 的 1 个 codex 进程仍带该 home 的 `CODEX_HOME` 在跑，全机 19 个 codex 进程、0 个 unattributed。即缺陷在本单修复前再次发生；删除者未钉死（本会话首条测试 02:09 才运行）。
* 本单所有本地测试期间，三个生产 lease 目录 mtime 未变（00:47:13 / 23:27:11 / 21:21:52）。
