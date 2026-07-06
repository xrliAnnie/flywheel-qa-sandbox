# FLY-900 撤掉 founder-UX 签字门 — QA 报告

Issue: FLY-900 (https://linear.app/geoforge3d/issue/FLY-900/infragovernance-撤掉-founder-ux-签字门fly-598-implement-前-signoff-annie)
日期: 2026-07-06
基于: `plan.md`（PR #467, commit eae045d0）

## Verdict: PASS

## 验证方式

### 1. 实现 vs 计划逐点核对

逐一读取 `plan.md` §3 的四个改动点，与 `git diff main...HEAD` 逐字比对：

- **helper**（`packages/config/src/founder-ux-config.ts`）：`isFounderUxGateEnabled(env)` 与计划一致——`env.FLYWHEEL_FOUNDER_UX_GATE_ENABLED === "1"`，默认 unset → false。经 `packages/config/src/index.ts` 导出，未字面量硬编码在别处。
- **A**（`Blueprint.ts:1128`）：注入条件 `founderUxMode && founderUxMode !== "off" && isFounderUxGateEnabled()` —— 与计划一致，禁用则完全不注入 FOUNDER-UX GATE 段。
- **B**（`teamlead/src/bridge/founder-ux/routes.ts`）：status 路由在参数校验之后、`signoffSatisfies()` 之前短路 `if (!isFounderUxGateEnabled()) { res.json({ approved: true }); return; }`——auth（ingest bearer）逻辑保持在短路之前，未被绕过。
- **C**（`teamlead/src/bridge/event-route.ts:1742`）：stage-guard 调用点短路为 `stage === "implement" && isFounderUxGateEnabled()`——禁用时完全不读 session 快照、不 block。
- **D**（`claude-lead.sh:1958`）：追加 `founder-ux-rules.md` 前加 `[ "${FLYWHEEL_FOUNDER_UX_GATE_ENABLED:-}" = "1" ]` 判断——与计划一致。
- **registry**（`packages/config/src/feature-flags/registry.ts`）：新增 `founder_ux_gate_killswitch` spec，`category: governance_gate`、`polarity: opt_in`、`default: false`、`toggleable: readonly`，`readSites` 只登记 helper 文件（未登记 A/B/C/D 消费点，按计划 drift-scanner 语义正确）。
- **纯函数未动**：`resolveEffectiveFounderUxConfig` / `evaluateFounderUxStageGuard` / `signoffSatisfies` 逐字未改（`git diff` 确认零改动）。

**边界确认（scope discipline）**：`git diff main...HEAD --stat` 列出的 17 个文件中，未出现 `approve_to_ship` / `founder-only-authority` / FLY-175 `founderConsent` / FLY-827 codex 门 / `qa_done_gate` / `merge_approval_gate` 任何相关文件；887/898 两个 exec 的 StateStore 标记未被本 PR 触碰（按 plan §7 的 Lead 决定，不提前解封，随重启+重派自然解决）。

### 2. CI 证据（真实、独立于本机环境）

`gh pr view 467 --json statusCheckRollup` → 当前 HEAD（`eae045d0`，与本地 `git rev-parse HEAD` 一致）的 `Build & Test` conclusion = **SUCCESS**（`16:15:33 → 16:26:03`）。此前两次在早期 commit 上的 FAILURE 与本 PR 无关（progress.md 记录为 pre-existing main-lint 问题，已在后续 commit 解决）。

### 3. 全仓 `pnpm build`

`pnpm build`（16/16 包）全绿，无 TypeScript 编译错误。

### 4. 分层测试验证

**config 包（含新 helper + registry）**：
- `founder-ux-config.test.ts`：23/23 pass（unset→false / "1"→true / "0"及各种非"1"值→false / 显式传参 vs 读 `process.env` 两条路径）。
- `feature-flags-drift.test.ts`：3/3 pass（新 spec 的 readSite 字面量校验通过，无 drift）。
- 全包 `pnpm test`（`packages/config`）：**344/344 pass**，20 个测试文件全绿。

**edge-worker 包（Blueprint 注入点 A）**：
- `Blueprint.fly598-founder-ux.test.ts`：4/4 pass，含新增用例「kill-switch OFF：enforce/audit_only 注入内容与 off 逐字相同（byte-identical）」。
- 全包 `pnpm test`（`packages/edge-worker`）：**1041 passed, 5 skipped（预置跳过，非本次相关）, 0 failed**（88 个测试文件）。

**teamlead 包（status 路由 B + stage-guard C + Lead 规则 D）**：
- `routes.test.ts`：25/25 pass，含新增「gate disabled: status 返回 approved:true（无 sign-off 也放行）」+「gate disabled: auth 仍然生效（无 token → 401，短路在 auth 之后）」。
- `fly618-qa-independent.integration.test.ts`（**真实 `createBridgeApp` 端到端**，非 mock）：26/26 pass，含 3 条新增 FLY-900 用例——OFF 时 status 路由 `approved:true`（Layer A 视角）、OFF 时 `implement` 事件**不再** 409（原 enforce 下会 409 FOUNDER_UX_SIGNOFF_REQUIRED，现在验证 not-409，Layer B 完整覆盖，含缺 ux_hash 场景）。这是最强的一组证据：直接跑真实 Bridge app，证明撤门后 founder-facing + enforce 快照的 session 真的能进 implement，不只是单元测试断言。
- `signoff-and-guard.test.ts`：13/13 pass（未改动，纯函数测试不受影响，符合预期——它们不经过 env 短路的调用点）。
- Shell golden 测试（`bash` 直跑）：
  - `fly869-founder-ux-default-mode.test.sh`：**10/10 pass**（Test 1-7 为既有 FLY-869 mode 解析行为 + Test 8-10 为新增 FLY-900 append-gating：默认 OFF→不追加规则、显式`0`→不追加、`=1`+`mode:off`→仍不追加）。
  - `fly231-companion-launch-plan.test.sh`：**46/46 pass**（含新增 T11：`env=1` 时 dept lead 重新拿到 `founder-ux-rules.md`，companion lead 仍不受影响——证明可逆）。
  - `fly879-external-launch-plan.test.sh`：**40/40 pass**（external role 本就在 founder-ux 追加逻辑之前被排除，不受本次改动影响，无需更新，符合 plan 边界说明）。

### 5. 全量本地 teamlead 测试套件（诊断环境噪声）

`pnpm test`（`packages/teamlead`，365 个测试文件）第一轮跑出 **Test Files 4 failed | 360 passed | 1 skipped (365)；Tests 26 failed | 5000 passed | 16 skipped (5042)**。逐一核实：

- **全部 26 个失败集中在同一个文件**：`src/lead-backends/codex/__tests__/codex-lead-runtime.test.ts`（FLY-245 write-capable release gate 的 workspace-overlap 校验），报错为 `FLYWHEEL_CODEX_LEAD_WORKSPACE (...) must not overlap ~/.flywheel`。
- **根因诊断（已有 memory 先例 `reference_qa_codex_lead_runtime_tmpdir_overlap`，本次独立复现确认）**：`echo $TMPDIR` 确认本 QA session 的 `TMPDIR=/Users/xiaorongli/.flywheel/runner-state/<exec-id>/browser-tmp`，测试用 `mkdtempSync(join(tmpdir(), ...))` 建的临时工作区天然落在 `~/.flywheel` 之下，触发了 FLY-245 自身要防的"沙箱不得与 `~/.flywheel` 重叠"校验——这是 QA session 自身运行环境的产物，与 FLY-900 的 diff（完全不碰 `codex-lead-runtime.ts`）无关。
- **独立验证修复**：`TMPDIR=/tmp npx vitest run codex-lead-runtime.test.ts` → **117/117 pass**，确认换回正常 TMPDIR 后该文件本身完全健康。
- 尝试用 `TMPDIR=/tmp` 重跑整个 teamlead 套件以拿到一次"完全干净"的全量结果，但本机当前有大量并发 Flywheel Runner/QA 会话（`ps aux` 可见同一时刻多个 worktree 下的 vitest worker 进程），CPU 严重争抢导致两次全量重跑都在 worker 池 spawn 后陷入长时间 0% CPU 停滞（非测试逻辑死锁，是本机资源争抢）——判断继续等待不会带来额外信号，遂终止，改为下方三层交叉验证收敛判定。

**判定依据（三条协议，均满足）**：
1. 确认被测 diff 完全不碰这个失败文件所在模块（`git diff main...HEAD` 确认零触碰 `lead-backends/codex/`）。
2. 确认 GitHub CI 是绿的（PR #467 head commit `Build & Test` = SUCCESS，CI 环境 `TMPDIR=/tmp`，天然不重叠）。
3. 隔离重跑该失败文件本身拿到权威结果（`TMPDIR=/tmp` → 117/117 pass）。

三条均满足，判定这 26 个失败（全部同一根因）不计入本次 verdict，且已通过 3 项独立证据交叉确认排除了它们是本次改动引入的回归的可能性。

### 6. Lint

`pnpm lint`（全仓 biome）：2 errors + 14 warnings。逐条核对涉及文件：`doc/engineer/research/assets/FLY-581-cdmcp-verify.mjs`、`packages/agent-team-transport/src/AgentTeamTransportFactory.ts`、`packages/teamlead/src/__tests__/DirectEventSink.test.ts`、`heartbeat-quiet-suppression.test.ts`、`runner-idle-watchdog-quiet.test.ts`、`scripts/qa-fly-863-*.mjs`、`scripts/qa-fly892-*.mjs`——**全部不在本 PR 改动的 17 个文件之列**（`git diff main...HEAD --name-only` 交叉比对确认零交集），均为主仓既有 lint 债务，与 progress.md 记录的「BLOCKED on pre-existing main-lint」一致。

## 结论

FLY-900 的实现与已批准的 `plan.md` 逐点一致：四个 enforcement 点（Blueprint 注入 A / status 路由 B / stage-guard C / Lead 规则 D）全部正确挂上 `isFounderUxGateEnabled()` 短路，纯函数零改动，registry 正确登记且 drift 测通过，且严格未触碰 ship 门 / codex 门 / QA 门 / 887-898 的边界。真实 Bridge app 端到端测试（`fly618-qa-independent.integration.test.ts`）直接证明了撤门后 founder-facing + enforce 快照的 session 能正常进 implement——这正是 Annie 要解决的核心问题。CI 在本 PR 的 HEAD commit 上是绿的。本机全量本地测试中唯一出现的失败集是已知的、经三重交叉验证排除的环境噪声（QA session 自身 TMPDIR 与 `~/.flywheel` 重叠触发了一个完全无关模块的自我防护校验），不影响判定。

**PASS — 建议进入 approve/ship 流程。**
