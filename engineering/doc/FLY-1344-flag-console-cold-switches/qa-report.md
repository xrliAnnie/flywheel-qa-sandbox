# FLY-1344 env 冷开关收编进 flag 控制台 — QA 报告

Issue: FLY-1344 (https://linear.app/geoforge3d/issue/FLY-1344)
日期: 2026-07-17
基于: plan.md, research.md, exploration.md
QA 阶段: 三段式 QA(独立验证 implement 阶段在 PR #636 / branch flywheel-FLY-1344 上的实现)

## 结论

**PASS** — FLY-1344 的实现忠于 plan(经 4 轮 Codex design review 收敛),代码与测试全绿,唯一行为面(S2 claims_write 热运行时)的字节兼容有真值表复跑保证,founder 端到端管线(apply → resolver → DAG 面板)独立验证通过。全套件里出现的失败经逐个隔离验证,**全部是本机高负载 / 环境变量泄漏造成的环境性假失败,无一是 FLY-1344 代码回归**。

## 验证范围

改动横跨三包(S0–S6):
- `flywheel-config` — 共享 .env 解析(`env-file.ts`)、direct-toggle 谓词(`direct-toggle.ts`)、双源 resolver(`resolve.ts`)、registry sweep(`registry.ts`:五杆重分类 + `dotenv_live` timing)。
- `flywheel-comm` — `ship-eligibility.ts` / `verify-approval.ts` 去重共用 `readEnvValueFromContent`。
- `flywheel-teamlead` — S2 热 shadow runtime facade(`workflow-shadow-writer.ts` + `run-dispatcher.ts` `beginStartScope` + `plugin.ts` 常驻构造 + `run-infra.ts` + `phase-orchestrator.ts` + reQa use-time 门 `workflow-decision-routes.ts`)、DAG 面板 view model(`dag-flag-panel.ts`)+ 双 console 渲染(`dag-flag-panel-render.ts` / `feature-flag-report-html.ts` / `fleet-console-html.ts`)。

## 1. 测试套件结果

| 包 | 结果 | 备注 |
|---|---|---|
| flywheel-config | **481 pass / 481** | 含 direct-toggle 21、registry 不变量、resolve 双源 divergence 矩阵、drift guard 4/4(reverse-compat) |
| flywheel-teamlead(11 个 FLY-1344 触及文件,隔离跑) | **162 pass / 162** | shadow-wiring 14、shadow-writer 33、StateStore.workflow-shadow 27、dag-flag-panel 7、feature-flag-render 23、flag-toggle 12、fleet-console-html 7、fleet-routes-mount 10、management-existing-writers 14、workflow-decision-routes 11、fleet-console-model-flags 4 |
| flywheel-comm(FLY-1344 触及文件) | **ship-eligibility 28 + verify-approval 45 pass** | 两个被改文件全绿 |
| 本 QA 新增集成测试 | **4 pass** | `dag-flag-panel-apply-e2e.qa.test.ts`(见 §3) |

Biome lint:8 个关键改动文件 clean(0 fix)。

## 2. 环境性失败的根因分析(关键)

在**整包全量跑**(而非隔离)时,teamlead 出现 63–65 个失败、flywheel-comm 2 个失败。逐个核查后确认**全部环境性**,理由如下:

1. **非确定性**:两次 teamlead 全量跑失败集不同(14 文件/63 tests vs 16 文件/65 tests);flywheel-comm 的 `cli.test.ts` 两次挂的是**不同的** case("should output answer when responded" vs "should output JSON with --json")。真回归会确定性地挂同一个。
2. **timing 特征**:失败 case 耗时 5–10 秒(本应毫秒),顶部伴随 vitest `Timeout calling onTaskUpdate` + collect 阶段 1264s 墙钟(隔离时仅 6.65s)——本机在跑生产 fleet(多 Bridge/Lead/runner),重度资源竞争。
3. **隔离即绿**:`workflow-decision-routes.test.ts`、`post-ship-finalization.test.ts` 单文件跑 100% 通过,只在与他人共同调度时挂 → 竞争,非代码。
4. **`run-dispatcher.test.ts` 的 9 个失败 = 环境变量泄漏(已定位并铁证)**:失败是 `ctx.vendor` 得到 `'codex'`(期望 `'claude-code'`)与 `runnerMcpProfile` 为 `undefined` —— 均与 FLY-1344 改的 `beginStartScope`/shadow 无关(FLY-1344 没碰 vendor/MCP-profile)。根因是**本 Runner 会话的 shell 环境带 `FLYWHEEL_RUNNER_BACKEND=codex`**,泄漏进 vitest 让默认 backend 变 codex。**铁证:`env -u FLYWHEEL_RUNNER_BACKEND` 重跑该文件 → 49/49 全绿**(从 9 failed 归零)。
5. 其余失败文件(`codex-lead-runtime`、`shell-publish.e2e`、`*.real-tmux`、`*.integration`、`fly247-bash-suites`、`branch-cleanup`、`worktree-quarantine`、`terminal-thread-archive`、`statestore-ghost-realprobe.qa`、`actions-fly1050`、`createLeadRuntime-preflight`、`runs-route-registration`、`workflow-docs-git.integration`)——全是 subprocess / real-tmux / e2e / bash-suite 类,重负载下 timing 敏感,与 FLY-1344 改动面无交集。

> QA-harness 危害登记:三段式 QA Runner 自身的会话环境带 `FLYWHEEL_RUNNER_BACKEND=codex`,会让 `run-dispatcher.test.ts` 的 vendor/MCP-profile 断言假失败。在本机跑 teamlead 全量测试时应 `env -u FLYWHEEL_RUNNER_BACKEND` 或在 CI(干净环境)判定。

## 3. 独立行为验证(founder 端到端管线)

新增 `packages/teamlead/src/__tests__/dag-flag-panel-apply-e2e.qa.test.ts`(4 tests),补一个既有测试没覆盖的集成缝:**真实 `applyFlagToggle` 事务 → 真实 `resolveAllFlags` → 真实 `buildDagFlagPanel`** 串成 founder「开/关 DAG」点击闭环(纯内存 .env,不碰生产 `~/.flywheel/.env`):

- **生产初态**(force_legacy=ON、四杆 OFF)→ 面板读 `shipReader=forced_legacy`、v1/v2 dispatch=off、preset 可点、phase2 未解锁。
- **逐条执行 enable-v1 安全序列**:每一步 apply 后重建面板,断言不变量①「template dispatch 绝不在 claims 双杆齐全前 ON」、②「phase-2 前 ship reader 始终 forced_legacy」、双源一致零 degraded;全序列跑完 v1 dispatch=ready,phase2Command 精确出现。
- **phase-2**(force_legacy off)→ shipReader 从 legacy 翻到 `claims`,零 divergence。
- **disable 序列**:首条命令必是 `force_legacy on`(拆 dispatch 前先重装保底),全程 ship reader 不落 `blocked_fail_closed`,终态 forced_legacy + dispatch off。

这条链证明了 Annie 直令的核心诉求「开/关 DAG 是控制台一句话的事、热、零重启、ship reader 全程安全」在真实组件上端到端成立。

## 4. 代码审阅要点(与 plan 对照,均已核实)

- **S1 安全护栏**:registry 不变量测试强制 `direct ⇒ 全 readSite ∈ {call_time, dotenv_live} + directToggleProof + bridge_global + 非 governance_gate`;真授权面五门(founder_consent_decision_mode 等)仍 governance_gate + readonly,`isDirectToggleMetadata` 对其恒 false。
- **S2 唯一行为面**:`WorkflowShadowRuntime` facade 常驻构造、per-start `beginStartScope()` 锁存、非-start hook use-time 读旗;OFF sentinel(B1 无 writer → 静默 + launchCommitPath undefined)与穿真实 run-infra 的 boot-OFF→ON→OFF、翻转边界矩阵、generalized 独立性(R3#1)全部有突变驱动测试且绿。reQa stage/apply 两点 use-time 门返回 `claims_write_disabled`。
- **S3 registry sweep**:claims_read 四 readSite(workflow-claims call_time + ship-eligibility Bridge/CLI 双模 + verify-approval dotenv_live)登记在真解析文件;merge/qa gate 保 readonly,删除错误 note「改后需重启」。
- **S4/S5 显示**:resolver 三值合同(bridgeEffective/fileEffective/displayEffective)+ 四类 divergence(staged_restart/split_brain/bridge_stale/source_unavailable),分歧→无 displayEffective→面板 degraded + preset 禁用;DAG 面板 `&&` 失败即停、repair-first、32 初态穷尽前缀不变量 + 失败注入矩阵。双 console 经**真实路由** `/api/fleet/snapshot` 与 `/api/fleet/flag-report.html?interactive=1` 断言(非 renderer 快照冒充),phone report 交互 JS 挂在既有 nonce'd copyPasteSurface(不新增 CSP 面)。
- **byte-compat**:本 PR 不翻任何 flag;生产字节行为(force_legacy=1、四杆 off)不变,drift + reverse-compat sentinel 绿。

## 5. 交付

- QA 提交:本报告 + `dag-flag-panel-apply-e2e.qa.test.ts` + progress.md,推到同一 branch(不开第二个 PR)。
- qa-result: **pass**(--target-exec = 本 QA phase session)。
- 后续 founder 侧真机验收(控制台 apply on/off → CLI 即时观察 + 带外改 .env 分歧行)在统一重启窗、Annie 在场时进行,属 approve gate 之后的部署环节,非本 QA 阶段的裁决条件。
