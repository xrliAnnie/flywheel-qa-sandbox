# FLY-1224 三段式 per-phase vendor — QA 报告

Issue: FLY-1224
日期: 2026-07-13
基于: plan.md

## 0. 结论

**QA 裁决:PASS**(对 FLY-1224 变更本身)。代码正确、测试全绿、突变测试三处均按设计变红、字节兼容哨兵成立、编译后 dist 真实行为逐条验证。

**⚠️ 一个 ship 阻塞项(pre-existing,非 FLY-1224 引入):** PR #576 的 `Build & Test` CI 在 **Lint 步骤**红,根因是 main 上既有的 biome 债务(9 个文件,全部在 FLY-1224 diff 之外)。它会挡住 `:cool:` ship gate(FLY-2 CI-green 硬闸)。**需 Lead 决策如何解阻塞后才能 ship**(见 §5)。

本 QA 阶段的产出边界:审已提交的三段式实现,不重新实现。真机派单三段式验收 = plan §7 明确的**另立冒烟单**,不在本 PR 的 QA 范围内。

## 1. 验证顺序(按 plan §5)

| 步骤 | 结果 |
|------|------|
| `pnpm build`(拓扑序) | ✅ 全包 Done |
| `pnpm typecheck` | ✅ 全包 Done |
| `pnpm test`(全量) | ✅ FLY-1224 相关全绿;5 个失败经查全为环境性/测试污染(§3) |
| `pnpm lint` | FLY-1224 文件零错;CI-red 为 pre-existing 债务(§5) |
| `bash scripts/test-restart-services.sh` | ✅ 73/73(含 FLY-1224 idle-wait 矩阵 T12) |
| restart-guard hook 测试 | ✅ python 136/136 + install 11/11 |
| 真实 dist 行为(QA 加测) | ✅ 10/10(§4) |

## 2. 变更清单核对(逐条对齐 plan §3)

| 模块 | plan | 实现核对 |
|------|------|----------|
| C1 `three-stage-phases.ts` | DEFAULT_PHASE_DISPATCH + resolvePhaseDispatch + kill-switch | ✅ design=(claude, heavy=Fable)、implement=(codex, gpt-5.6-sol, xhigh)、qa=(claude, medium=Opus);`FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT=0` → implement 回落 (claude, heavy) |
| C2 显示诚实 | modelDisplayName GPT 家族 + issue-display pending 行走 dispatch 表 | ✅ fly892-phase-tag 12 测 + model-tiers 9 测全绿 |
| C6 resolver 1b | `dispatchVendor ? VENDOR_TO_EXECUTOR[..] : "claude-tmux"`;effort `dispatchEffort ??` | ✅ 逐字对齐;无 vendor = FLY-728 现状字节不变 |
| C7 codex effort | `buildDaemonEffortArgs` 白名单 + TOML 引号;贯穿 adapter→goal-runtime→spawn | ✅ argv `-c model_reasoning_effort="xhigh"`;非法值 warn+忽略;absent → [] |
| C8 probe-before-wake | `isWakeTargetProvenDead` 分级(dead_pin/absent+probeGhostTmux) | ✅ 两个 wake 位点共用;`alive`/`indeterminate` fail-closed 维持 wake |
| C10 交叉审对称 | Blueprint code-review lane 指引全三态 + claude-review-runner `--effort` + crossFamilyReviewSatisfied 双侧 | ✅ Blueprint 10 + verify-approval 42 + StateStore.codex-review 27 + review-family 13 + coordinator 45 全绿 |
| C9 restart-services | idle-wait default-off + `--wait-idle`/env 恢复 + 文案/hook 同步 | ✅ hermetic 73 测 + hook 文案测试全绿 |
| feature-flags registry | (plan 未显式列,但合理)kill-switch env 注册 | ✅ 与 QA_RESPAWN/FLY-939 同类项;非 scope creep |

## 3. 全量测试里 5 个失败的定性(全部与 FLY-1224 无关)

| 文件 | 失败数 | 根因 | 证据 |
|------|--------|------|------|
| `codex-daemon-runtime.test.ts`(claude-runner) | 4 | 环境性:runner 的 `TMPDIR` 在 `~/.flywheel/runner-state/<长 exec-id>/` 下,Unix socket 路径超 SUN_LEN(103) | `TMPDIR=/tmp` 复跑 → 37/37 全过 |
| `createLeadRuntime-preflight.test.ts`(teamlead) | 2 | 全量套件测试污染 | 隔离跑 → 4/4 全过 |
| `lead-rules-bundle.test.ts`(teamlead) | 2 | 环境性:真跑 `codex-lead.sh` 撞本机 errored 的 codex remote-control + `~/.codex-infra-bot` config | FLY-1224 未碰 codex-lead.sh / lead-rules-base |
| `stuck-candidate.test.ts`(teamlead) | 1 | 环境泄漏:runner 环境设了 `FLYWHEEL_STUCK_ERRORSIG=1`,污染「env unset default」断言 | `env -u FLYWHEEL_STUCK_ERRORSIG` 复跑 → 36/36 全过 |

**逻辑铁证:** 这 3 个文件的**测试与被测源码都不在 FLY-1224 diff 内**(git diff 核对)—— 若测试与代码都没变,失败不可能由 FLY-1224 引入。

## 4. 突变测试(硬约束「防绿色的谎」— QA 亲自执行,验后还原,工作树复归干净)

| 突变 | 摘掉的透传 | 期望变红 | 实测 |
|------|-----------|----------|------|
| **α** | resolver 1b 的 `dispatchVendor` 透传(改回无条件 `claude-tmux`) | per-phase T1 变红,哨兵(no-vendor)保持绿 | ✅ 「codex dispatch triple → codex-tmux」红;「dispatchModel WITHOUT vendor → FLY-728」绿 |
| **β** | `isWakeTargetProvenDead` 永返 false(等于摘掉 C8 probe) | 「探死→spawn」用例红,「alive/indeterminate→wake」用例绿 | ✅ 4 个 dead→spawn 红(T6/T8 各 2);T6b/T7 兼容路径绿 |
| **γ** | `crossFamilyReviewSatisfied` 家族比对(改成永远放行) | 「同厂商盖章记录必须拒」用例红 | ✅ 2 个 reviewer-inversion 拒绝用例红;字节兼容 legacy 用例绿 |

三处突变全部按设计精确变红,且只让「该红的红」、兼容路径不误伤 —— 测试具备真实 mutation-resistance,不是绿色的谎。

## 5. Ship 阻塞项:PR CI Lint 红(pre-existing,非 FLY-1224)

- PR #576 `Build & Test` → **Lint 步骤** `biome check` 失败(Found errors)。
- CI 标记的**全部 9 个文件都在 FLY-1224 diff 之外**:`product/doc/FLY-1038-.../serve.mjs`(模板字面量,由 `852447f16` FLY-1038 #572 引入,已在 origin/main)、`engineering/doc/FLY-1070-.../qa-e2e-harness.mjs`、`scripts/qa-fly-1188-e2e.mjs`、`packages/agent-team-transport/.../AgentTeamTransportFactory.ts`(import 排序)、`packages/flywheel-comm/.../db.gate.test.ts`、`packages/teamlead/.../{DirectEventSink,heartbeat-quiet-suppression,runner-idle-watchdog-quiet,fleet-data}.test.ts`(biome-ignore/any)。
- **对 FLY-1224 触及的 36 个代码文件单独跑 biome:零错。** FLY-1224 引入零 lint 债务。
- **影响:** `:cool:` ship gate 需 CI 全绿(FLY-2)。CI 红 → PR 无法 merge。这是 main 的既有债务,FLY-1224 无法在不越 scope 的前提下修(会把 9 个不相关文件的改动塞进本 PR)。
- **需 Lead 决策**:① 先在 main 落一个 lint hotfix 解阻塞;或 ② 授权在本 PR 顺带修这 9 个文件(scope 扩张);或 ③ 其它。**QA 不擅自决定 scope 扩张,已上报 Lead。**

## 6. 真实 dist 行为验证(QA 加测,`scratchpad/fly1224-realbehavior.mjs`)

针对**编译后 dist**(Bridge 真跑的代码)端到端验证 config 表 → resolver → executor backend + effort argv + kill-switch,10/10 全过:
- design → `{claude, claude-fable-5}` → `claude-tmux`
- **implement → `{codex, gpt-5.6-sol, xhigh}` → `codex-tmux` + argv `-c model_reasoning_effort="xhigh"`**
- qa → `{claude, claude-opus-4-8}` → `claude-tmux`
- no-vendor 哨兵 → FLY-728 `claude-tmux`(字节兼容)
- kill-switch=0 → implement 回落 `{claude, claude-fable-5}`

注:仓库 MODEL_TIERS 约定 `heavy.id=claude-fable-5`(Fable)、`medium.id=claude-opus-4-8`(Opus)—— design=heavy=Fable、qa=medium=Opus 精确符合 Annie 直令「design 用 Fable、QA 用 Opus」。

## 7. 529-B 真机验证(Tadashi 直令 d162c25a,路径 B — Annie 点名要看真 Codex 跑 implement)

Annie 在 ship gate 要求真机看到 implement 段真在 Codex 上跑。Tadashi 拍板路径 B:module-driven 驱 #576 dist 的 `CodexDaemonGoalRuntime`(= CodexTmuxAdapter 用的同一 runtime)起**一个真 codex implement 窗口**,完全隔离(/tmp 短路径、隔离 CODEX_HOME/repo/socket、不碰生产 CommDB)。harness:`scratchpad/fly1224-codex-window-harness.mjs`。证据目录:`e2e-evidence/`。

| # | 证据 | ground-truth |
|---|------|--------------|
| B1 | **FLY-1224 effort override 到达真 daemon** | live `ps` 抓到真进程 argv:`codex app-server --remote-control --listen unix://... -c model_reasoning_effort="xhigh"`(`daemon-argv-live-ps.txt`) |
| B2 | **模型 = gpt-5.6-sol** | codex TUI 抬头「model: gpt-5.6-sol xhigh」+ 隔离 codex home config |
| B3 | **真 codex 真写码** | 写出 `smoke-fly1224.md`(design=Fable/implement=Codex gpt-5.6-sol/qa=Opus),`outcome.json`: status=complete、succeeded=true、18767 tokens、1 turn |
| B4 | **founder TUI 窗口可看** | 真 tmux pane 里 `codex resume --remote` 渲染 codex TUI 并存活(`codex-tui-screenshot.txt` — Annie 观看画面) |

**结论**:1224 的代码端到端让 implement 真跑在 Codex(gpt-5.6-sol + xhigh)上、真写文件、TUI 真可看 —— 已用真 codex 证实。**不需要新代码**。

### Observation(记录,非 FLY-1224 缺陷):自动 harness 首发窗口秒退 `stdin is not a terminal`
- `ensureRunnerTuiWindow` 自动建窗口(detached tmux session,从非交互父进程 fork)时,首发 `codex resume --remote` 秒退,报 `Error: stdin is not a terminal` —— 该二进制要交互式 TTY。
- 这是 **FLY-1188/398 的 TUI opener 的边界条件,非 FLY-1224 代码**(FLY-1224 未碰 `codex-runner-tui-window.ts`)。在**正常 tmux pane**(有真 pty)里 `codex resume --remote` 完全正常渲染+存活(B4 已证)。
- **1225 生产整机跑不会踩**:cmux 提供真 pty,窗口正常渲染(Mufasa 生产 codex Lead 窗口即活证)。留档供 FLY-1188/398 维护线参考。

## 8. 未覆盖(明确边界)

- **完整沙箱 Bridge 端到端流水线**(派单→design→implement→qa→ship 全链 + in-cmux live-watch)= **FLY-1225 冒烟单**(Backlog,⛔ 依赖 FLY-1224 落地后派;双重身份含 thread 状态前缀 bug 修复)。**非代码缺口** —— 是上线后的整机彩排。
- token-usage 观测盲区(codex 用量不进日报)= plan §9 已接受的限制。
