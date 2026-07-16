# FLY-1307 PR-7 — QA 验证报告

Issue: FLY-1307 (https://linear.app/geoforge3d/issue/FLY-1307)
日期: 2026-07-16
基于: plan.md (v1.35, Codex APPROVED 5 轮) · PR #617

## 0. 结论

**PASS**（针对 PR-7 = 本分支已提交的切片；见 §5 范围声明）。

PR-7「注册表收口 + orchestrator 按 snapshot 解释」实现与 plan §2 逐条吻合，Codex code
review 已过、CI「Build & Test」绿。独立复跑全量测试后**零真实回归**：唯一在本机出现的
22 个失败**全部**溯源为环境/构建态假失败，且逐个在干净条件下转绿（证据见 §3）。

## 1. 范围（关键）

本分支 (flywheel-FLY-1307, PR #617) **只含 PR-7**，标题即
「FLY-1307 PR-7: interpret engine-owned workflow snapshots」，progress.md 光标
`implement 3/8`、nextStep=「Complete PR-7 ... then land it」。

plan 的三片切法（§1）明确把 **PR-7 / PR-7.5 (docs materializer) / PR-8 (派发启用)**
拆成三个独立 PR，各自 Codex review + 全量测试 + merge。**D 关单 = 三片全落**
（plan §0.2 gate 纪律 a）。因此：

> **合入 PR #617 只完成 slice 1/3，不关闭 FLY-1307。** PR-7.5 与 PR-8 仍需后续独立
> dispatch。这是 plan 预定的增量切片，不是 QA 缺陷；但 Lead/Annie 需知悉「D 未闭」。

## 2. 代码核对（对照 plan §2）

| plan 条目 | 实现 | 核对结论 |
|---|---|---|
| §2.1 注册表收口（registry 成 badge/capabilities 唯一真相，three-stage-phases 派生，import 方向反转）| `node-type-registry.ts` 持字面量 + `three-stage-phases.ts` 从 registry 派生 | ✓ drift sentinel `node-type-registry.test.ts` **突变验证**（改 registry 断言 three-stage 跟着变）+ forbidden-import 正则；非空过 |
| §2.1 dispatch 真相不动（DEFAULT_PHASE_DISPATCH/resolvePhaseDispatch 留在 three-stage-phases）| 未迁移，FLY-1224 kill-switch 语义原样 | ✓ |
| §2.4 v1 typed snapshot 版本化 union（v1/v2 共用严格 parser，未知拒）| `parseWorkflowRunSnapshot` 认 schema_version 1/2，其余 fail-closed；v1 不要求 effort、拒 generalized 字段；digest 往返校验 | ✓ |
| §2.2-0 engine_owned 显式标记（与 claims_read_enrolled 解耦，幂等 ADD COLUMN DEFAULT 0）| `workflow_run.engine_owned INTEGER NOT NULL DEFAULT 0`，belt 全入口 early-return | ✓ byte-compat 迁移 |
| §2.2-1 统一 transition 事务原语 `commitWorkflowTransitionTx`（CAS + 单事务 + 重放收敛）| 确定性 transitionUid CAS、`db.transaction`、幂等 replay/conflict、exactly-one edge XOR loop、bounded-loop 超限→held+escalate | ✓ 与 plan 逐字一致 |
| §2.2-2 通用 decision canonicalization seam（服务端派生 family/predicate、绝不信 caller）| `resolveEngineDecisionCanonical`：qa=PR head authority+done producer；review=MaterializedHeadAuthority port；forged head→409；engine_owned 决策**不再调 onQaResult**；legacy QA 路径字节兼容 | ✓ |
| §2.2-2 MaterializedHeadAuthority port（PR-7 只定义接口，unavailable⇒fail-closed）| `materialized-head-authority.ts` 默认 `unavailableMaterializedHeadAuthority` throw | ✓ 单向依赖 PR-7→7.5 成立 |
| §2.2-7 ship_claims USE-time 门（exact-predicate→authority 封闭映射）| `resolveEngineWorkflowShipClaims` 逐 claim exact-predicate + subjectDigest USE-time 解析，ambiguous/unsupported/missing→fail-closed；`computeAuthoritativeShipDecision` additive 扩展既有 seam，default-off 字节兼容；`computeEngineWorkflowShipPrecondition` = completed-recovery 状态无关路径（不跑 status-bound verifyApproval）| ✓ |
| §2.2-8 TURN run 归属（target_run_id + projector run event；legacy null 字节不变）| StateStore turn_grant 派生+校验 target_run_id | ✓ |
| §2.2-5 后继派发保留三段式等价 context（shared-branch/lead/doc_tier/design_backend/startPoint）| `workflow-engine-dispatcher.ts` consume 时逐字段透传 | ✓ |
| 派发三元组走 snapshot 钉住 dispatch{vendor,model,effort}（不旁路 FLY-1224 resolver）| `node.dispatch` 直取，vendor→executor 走既有映射 | ✓ |

## 3. 测试验证

### 3.1 通过（干净环境，独立复跑）
- `flywheel-config`：**439/439** ✓
- `flywheel-edge-worker`：**1141/1141**（5 skipped）✓
- `flywheel-comm`（隔离 HOME）：**887/887** ✓
- PR-7 定向 teamlead 测试（snapshot/engine-dispatcher/decision-routes/transition/
  projector/claims/templates/generalized-execution/ship-gate/external-merge/
  phase-orchestrator/turn-seam）：**220/220** ✓
- `pnpm --filter flywheel-teamlead... build`（tsc）：干净通过（= PR-7 typecheck 过）✓
- biome lint（18 个改动源文件）：无问题 ✓

### 3.2 22 个 broad-suite 失败 — 全部环境/构建态假失败（零真实回归）

broad 首跑用**继承的会话 env**（我是 Codex runner，`FLYWHEEL_RUNNER_BACKEND=codex`
被导出）+ 高并发负载（collect 484s）。逐文件溯源 + 干净复跑：

| 文件 | 失败数 | 根因 | 干净结果 |
|---|---|---|---|
| run-dispatcher.test.ts | 9 | 会话 env `FLYWHEEL_RUNNER_BACKEND=codex` 翻默认 vendor | scrub env → **49✓** |
| post-ship-finalization.test.ts | 7 | 高负载 flake | 隔离复跑 **22✓** |
| createLeadRuntime-preflight.test.ts | 3 | **worktree 陈旧构建态** → `flywheel-agent-team-transport` dist 不一致 → vi.mock 失效 → 真 preflight 泄漏（5s、真 MailboxLeadRuntime resolve） | 干净 rebuild → **4✓** |
| tmux-lookup.real-tmux.test.ts | 2 | real-tmux 高负载 | scrub → ✓ |
| terminal-thread-archive.test.ts | 1 | scheduler 计时 flake | scrub → ✓ |
| worktree-quarantine.test.ts | 1 | real-git 高负载 | scrub → ✓ |

**阳性对照**：以上文件均**不**在 PR-7 语义路径上（run-dispatcher.ts 仅被 PR-7 碰 10 行，
已证 env 而非代码；createLeadRuntime/preflight **不在** PR-7 diff，plugin.ts 改动仅 wire
新 dispatcher，未碰 preflight）；且 PR #617 CI「Build & Test」在**干净 Linux** 上全绿——
同一 PR-7 代码在干净构建下这些测试**全过**。另在**本机 main checkout**（scrub env）复跑
createLeadRuntime-preflight → 4✓（对照证明：main 过、脏 worktree 挂、rebuild 后 worktree 也过 = 构建态而非代码）。

### 3.3 第二次全量复跑（scrub env + fresh build）— 负载放大验证

为消除 §3.2 的 env 变量，用 `env -u FLYWHEEL_RUNNER_BACKEND -u FLYWHEEL_AGENT_BACKEND` +
干净 build 再跑一次全量。此时**本机负载极高**（90 vitest 进程、collect 1269s），失败数
反而升到 25（含新增 actions.terminate ×2、actions-fly1050 ×1、runs-route-registration ×1、
post-ship ×12、preflight ×2、real-tmux ×4 等）。**「负载越高失败越多、逐个隔离全过」正是
负载型 flake 的指纹，非代码**：

- PR-7 **改动过**的文件 `actions.ts`（仅 `handleRetry` generalized 路径加 submissionCredential）
  与 `runs-route.ts`（仅 generalized start 路径）——其失败测试 `actions.terminate`（测
  `handleTerminate`）/ `runs-route-registration`（测路由注册）**都不在 PR-7 触碰的函数上**；
  三文件隔离复跑（scrub env）**19/19 全过** ✓。
- 结论不变：**PR-7 触碰的每个文件（run-dispatcher / actions / runs-route）隔离全过；
  零真实回归。** 全量套件的权威对照 = PR #617 CI「Build & Test」干净 Linux 全绿。
- 备注：本机处于重载期，不宜再跑全并发套件（只会制造更多 flake）；隔离复跑 + CI 绿即定论。

## 4. 与 plan gate 的符合性
- E1 红测/1281 OFF sentinel/byte-compat：随 teamlead 全量套件覆盖，default-off 路径实测
  「generalized seed skipped (flag off)」正常短路。
- 生产零行为变化：`engine_owned DEFAULT 0` + claims 读/写 flag 均 default-off；PR-7 不翻任何 flag。

## 5. 范围声明（重申，供 Lead/Annie）
- 本次 QA-PASS 仅覆盖 **PR-7**。
- **FLY-1307 (D) 未闭**：尚缺 PR-7.5（docs materializer）+ PR-8（模板派发启用 + 全 sentinel
  + 真机 E2E + enable 材料）。合入 #617 后需继续后两片。
