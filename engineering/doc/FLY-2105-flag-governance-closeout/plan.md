# FLY-2105 Flag 治理关门 — 实施计划
Issue: FLY-2105 (https://linear.app/geoforge3d/issue/FLY-2105/flagd关门-ci-守卫改判据env-configyaml-出现任何-flag-值即红legacy-unmanaged-baseline)
日期: 2026-08-30
基于: research.md

## 0. 锁定范围与前置裁决

本计划只收敛现有机制，不新增 flag、依赖、通知路径或 fallback ledger。代码实现必须在本文件
通过 design review 后开始，并对每个行为变化执行 RED → GREEN。

Lead 已通过 question `382ec580-55c8-409b-a35b-72d2c3df6e5f` 锁定判据：22 条
`persistentEnvAllowed: true` runtime seam 默认逐条写死现值并删除读点；只有同时满足“引擎仍读、
删除会改变必须保留的行为、存在真实切换需求”的产品 flag 才迁 registry/store；真豁免严格限于
具名 QA 隔离、dry-run、一次性迁移并带退役条件。不确定项按删除处理。§3.2 是据此形成的 22 行
处置表；实现不得扩大或另造类别。

## 1. Slice A — closed-world registry/store ledger

### 1.1 RED

先改 `feature-flags-store-policy.test.ts` 与 `fly1981-final-ledgers.test.ts`：

1. 断言 `LEGACY_UNMANAGED_BASELINE` frozen 且 `length === 0`；向 synthetic policy 输入加入
   unmanaged spec 必须失败，证明空账不能增长。
2. 断言 `STORE_MANAGED_FLAGS.size === FEATURE_FLAGS.length`，并对 registry/set 做双向无差集；
   current tree 应因 17 vs 10 失败。
3. 断言 `PROJECT_STORE_MANAGED_FLAGS` 精确等于 registry 中 `scope === "project"` 的名字；它只
   是 storage-routing subset，不是另一份 authoring allowlist。
4. codec 合同直接遍历 `FEATURE_FLAGS`；缺 codec、bool polarity/default 反向、enum member 不
   round-trip、value 接受非法 raw 分别有 mutation fixture 并失败。
5. global/project management negative tests：project spec 不得走 global write/read API，global
   spec 不得接受 project scope。

记录预期失败文本，随后才改生产代码。

### 1.2 GREEN

`packages/config/src/feature-flags/store-policy.ts`：

- `LEGACY_UNMANAGED_BASELINE = Object.freeze([] as const)`；删除
  `LEGACY_UNMANAGED_NAMES` 与 authoring policy 的 legacy 成功分支。
- `STORE_MANAGED_FLAGS` 由 `FEATURE_FLAGS.map(spec.name)` 导出（registry 唯一名册）。
- `PROJECT_STORE_MANAGED_FLAGS` 由 `FEATURE_FLAGS.filter(scope === "project")` 导出；若现有
  public API consumers 需要稳定 export，保留 export 名，不保留手写名字数组。
- `validateFlagAuthoringPolicy()` 对每个 registry spec 强制：在 all-set、有 codec、有至少一个
  delegated call-time named wrapper；再按 `scope` 走 global/project shape 合同。
- `getStoreEligibility()` 对 global route 除 membership 外显式要求
  `scope === "bridge_global"`，不能因 all-set 让 project spec 穿过。

scope-sensitive consumers 最小同步：

- `StateStore.ensureFlagValueRows()` 的身份断言接受 all-set，但 bootstrap seed 循环只处理
  bridge-global specs；project rows继续写时创建/clear 删除。
- `StateStore.applyFlagValueChange()` / global route 增 scope guard；scoped apply继续只接受
  project subset。
- `flag-store-runtime.readFlagValue()` 只接受 bridge-global spec；`readScopedBoolean()` 继续接受
  project subset；enrichment 保持 project-first 分流。

不创建 `GLOBAL_STORE_MANAGED_FLAGS` 新账；需要 global list 时从 registry scope 即时过滤。
`FlagCategory` 同步删除当前已无实例的 `governance_gate` 分支：治理门不再是可注册 product flag，
只能作为具名 transient seam 或固定 invariant。这样 type 不继续承诺一条与 closed-world store
合同矛盾的 authoring 路径。

### 1.3 `STORE_MANAGED_FLAGS` 全消费者 sweep

| 消费者 | all-set 后处置 |
| --- | --- |
| `StateStore.ts` | seed/global apply 按 `scope === "bridge_global"` 收窄；project row validation 不变。 |
| `flag-store-runtime.ts` | global raw read 按 scope 收窄；project-first enrichment 顺序不变。 |
| `flag-routes.ts` | 现有 project/global 分支先按 registry scope 路由；global canonical 再断言 scope。 |
| `flag-toggle.ts` | direct env fallback 仅允许 bridge-global；所有 registry flag仍被 store route拒绝。 |
| `management-existing-writers.ts` | target capability 按 registry scope 判定；project `global` target不因 all-set 提前走 global 只读文案。 |
| `flywheel-comm/src/commands/feature-flags.ts` | managed 展示按 all-set，global row读取按 scope 收窄。 |
| `feature-flags/truth.ts` | persistent env 校验只枚举有 `envVar` 的 bridge-global specs，不能以 set size 当 env 条数。 |
| `scripts/lib/qa-generalized.mjs` | derived managed-name set只用于“禁止旧 writer”判定，all-set 正是目标；加 project fixture验证。 |

每项至少有一个现有或新增回归测试；不能只靠 TypeScript 编译证明行为未漂移。

## 2. Slice B — raw env 与 config.yaml 关门

### 2.1 RED: 判官 fixtures

扩 `feature-flags-drift.test.ts` / test helper：

1. 现有 synthetic production source
   `process.env.FLYWHEEL_FUTURE_DYNAMIC_FLAG === "1"` 测试已 green，保留为判官回归，不伪称新
   RED。env 侧真正 RED 是新增断言 `isSkillModeCompatibilityRead` 不存在且 sole synthetic-env read
   也必须报 `store-managed flag has raw production read`。
2. 用 `git ls-files -z` 收集 basename 为 `config.yaml` 的 tracked files；不 filesystem-walk，因此
   `.git/`、本机 `worktrees/`、`node_modules/`、`dist/` 永不进入候选。
3. 每个 tracked YAML 走生产 `ConfigLoader` 同一 retired-key validator；synthetic
   `doc_flow.enabled`、`checkpoints.brainstorm.enabled`、
   `xiaohongshu_learning.collections[0].auto_create` 分别先 RED，并断言生产错误文本。
4. non-flag neighbors（`doc_flow.default_department`、checkpoint timeout、proofshot authoring fields）
   必须 green，防粗暴 grep 误报。
5. 对真实 tracked collector 断言当前 tidal-echo onboarding sample 报 retired flag，形成 branch-level
   RED。

### 2.2 GREEN: 最小判官与残留删除

- test 侧以 `git ls-files -z` 枚举 tracked `config.yaml`，逐个调用 `ConfigLoader`；parse error与 retired
  key都复用生产 fail-loud 文本。不得新增第三份 retired-path/matcher ledger，也不扫描历史
  JSON/Markdown。
- 删除 `doc/engineer/onboarding/tidal-echo/config.yaml` 的两个 checkpoint `enabled` 与
  `doc_flow.enabled`，保留 timeout/default_department。
- 删除 `auditFlagAccounts()` 的 raw-read compatibility 特判；若
  `skill_framework_mode` synthetic-env adapter因此红，只在
  `skill-framework-mode.ts` 内把 total resolver 的输入降为 raw control value，并让 Blueprint/store
  调用同一个 resolver，不新增 helper 层级。已有行为矩阵必须逐字通过。

### 2.3 真实 branch mutation drill

GREEN 后做两次可恢复突变，不提交坏状态：

1. 用 `apply_patch` 在 production TS 加 `process.env.FLYWHEEL_X === "1"`，跑目标测试保存失败
   输出，再用反向 patch 删除并复跑 green。
2. 用 `apply_patch` 在 `.flywheel/config.yaml` 加 `doc_flow.enabled: true`，保存失败输出，反向
   patch 删除并复跑 green。

最终 `git diff` 核坏行已不存在；证据写入本文件夹的 `red-green-evidence.md`。不使用
`git checkout` 覆盖用户改动。

## 3. Slice C — exemptions 只留真豁免

### 3.1 RED

在 `feature-flags-store-policy.test.ts` 加结构与 exact-census 测试：

- 允许 seam 仅 `qa_isolation | dry_run | one_time_migration`；
- `persistentEnvAllowed` 必须全 false；
- 每条非空 `reason/owner/issue/retireWhen`；reason 与 retireWhen 不得是空泛共享占位；
- 每条仍有 production read，且不与 registry/non-flag/retired ledger 重叠；
- `LEGACY_FLAG_EXEMPTION_BASELINE.length === 0`（历史 ceiling 归零）；新增 synthetic exemption
  不能让 raw product flag 变合法。

当前树预期因 persistent rows、无 retireWhen 与 legacy ceiling 非空失败。

### 3.2 GREEN：Lead 锁定的 22 行处置表

以下 22 名在生产 `.env` 的仅 presence 检查中全部 absent；没有读取或记录任何 value/secret。
“现值”另注明 invocation-time 注入与代码默认。`B` 表示按 Lead 默认裁决固化/删除，`C` 表示题面
允许的具名 transient seam。本批没有满足三条件的 `A`（registry/store 迁移）项。

| 名字 | 现值 / 消费者 | 处置 | 依据与保留行为 |
| --- | --- | --- | --- |
| `FLYWHEEL_CMUX_ORPHAN_REAPER` | 默认 1；`flywheel-cmux-sync.sh` orphan cleanup | B：删两处 off guard，始终启用 | 安全回收是固定 invariant，不需要运行时开关。 |
| `FLYWHEEL_CMUX_REOPEN_SWEEP` | 默认 1；cmux reopen sweep | B：删 gate helper/日志插值，始终 sweep | 退回旧算法会重开已恢复窗口，不是需保留模式。 |
| `FLYWHEEL_CMUX_RESTORED_ADOPTION` | 默认 1；restored workspace adoption | B：删 enum parser，始终 adoption | `0`/非法 fallback 都是历史 rollout seam。 |
| `FLYWHEEL_CMUX_STOCK_ADOPTION` | 默认 1；stock workspace adoption | B：删 off branch，始终 adoption | 当前默认行为即唯一受支持行为。 |
| `FLYWHEEL_CODEX_HEALTH_GUARD` | 默认 1；Bridge global Codex probe | B：删 disable short-circuit，始终 probe | 健康保护不能由持久 env 关闭。 |
| `FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT` | production absent；仅 hermetic converger suites 设 1 | C：保留为 `qa_isolation`、禁止 persistent env | temp-root 测试无法使用真实 global root；converger 接受显式 injected repo root 后退役。 |
| `FLYWHEEL_DAEMON_SKIP_PS_SELF_PROBE` | production absent；仅 daemon census suites 设 1 | C：保留为 `qa_isolation`、禁止 persistent env | hermetic process-list fixture需要绕过 host PID 1；census 接受 injected process lister 后退役。 |
| `FLYWHEEL_DISABLE_MAILBOX_SENTINEL` | production absent；TmuxAdapter 在 `commdb` rollback pane内注入 1 | C：保留为 `one_time_migration`、禁止 persistent env | Runner hook看不到 Bridge backend selector；commdb rollback删除且 stale mailbox sentinel完成清理后退役。 |
| `FLYWHEEL_FOUNDER_APPROVAL_ACK` | 默认 1；deferred approval reaction | B：删 off condition，消费后始终 ack | ack 是完成协议，不是产品模式。 |
| `FLYWHEEL_LEAD_CTX_RESUME_GATE` | 默认 1；Lead resume classifier | B：删 disabled path，始终做 context gate | 防超窗恢复是固定安全判断。 |
| `FLYWHEEL_MERGED_GATE_GUARD` | 默认 1；merged-gate verifier | B：删 disabled state，始终 guard | 合并状态校验不可通过 env 绕过。 |
| `FLYWHEEL_TURN_BELT_MERGED_RECLAIM` | 默认 1；external merge reconciler | B：删 early return，始终 reclaim | turn 归还是 merge 后固定收敛动作。 |
| `FLYWHEEL_ELEVEN_AUTOSTART` | 生产 unset；staged E2E synthetic invocation | C：保留为 `qa_isolation`、禁止 persistent env | 只供无人点击 slash command 的 staged rig；有 authenticated harness invoke 后退役。 |
| `FLYWHEEL_GEMINI_AGENT` | 默认 0；Gemini agent CLI/daemon config | B：固化 OFF；entry points无条件拒绝并标记 retired | 删除 `=1` 能力而不是把 default-off 偷换成 enable；后续重启用必须另开产品决策。 |
| `FLYWHEEL_GEMINI_AUTOSTART` | 生产 unset；staged E2E synthetic invocation | C：保留为 `qa_isolation`、禁止 persistent env | 同 Eleven；staged rig 可走 authenticated command invoke 时退役。 |
| `FLYWHEEL_HEADPHONE_INCLUDE_ROUNDTABLE` | env unset，fallback `headphone.yaml includeRoundtable` | B：删 env overlay，只读已有 typed config | 保留配置能力，删除重复 flag authoring 路径。 |
| `FLYWHEEL_HUDDLE_EARCON` | 默认 unset；voice-bridge optional clip path | B：删 env overlay，默认不注入 clip | 当前生产现值不变；mouth 的显式 programmatic option 不受影响。 |
| `FLYWHEEL_HUDDLE_FILLER` | 默认 unset；voice-bridge optional clip path | B：删 env overlay，默认不注入 clip | 同上，不把 value-shaped env 继续伪装成 flag 豁免。 |
| `FLYWHEEL_RUNNER_SLIM_MCP` | 默认 1；runner MCP profile | B：删 global kill-switch，始终走 slim policy | `full-mcp`/role/label 的结构化路径继续承担真实按任务选择。 |
| `FLYWHEEL_TUI_WINDOW_ALERT` | production `.env` absent，InfraBot launcher设 1；TUI alert factory | B：删除 env gate，按 canonical `leadId === "codex-infra-bot-lead"` 固化 | 保留现有 InfraBot-only策略；Mufasa/普通 Lead不能再 opt-in，并以 launcher canonical-id 测试锁定。 |
| `FLYWHEEL_VOICE_APPROVAL` | 默认 1；Bridge route + headphone client | B：删 kill-switch，始终启用且 `bridgeTokenEnv` 无条件必填 | 明确删除 Annie ② 记录的 emergency-off/403能力与 token requirement relaxation；auth/token继续 fail-close。 |
| `FLYWHEEL_VOICE_EDGE_TTS` | 默认 `edge-tts`；resident voice CLI | B：删 alias，直接用既有默认命令 | 标准 voice-core 仍有非 flag 的 typed command/args config；不保留重复 alias。 |

实现规则：

- `FlagExemption` 增 `seam` 与 `retireWhen`，删除 historical founder-widening/legacy ceiling 机制；
  true exemptions 是逐条有界账，不是产品 flag authoring 旁路。
- 上表 17 个 B 项删除 production read 与对应 obsolete tests/docs；不加 tombstone，因为这些名字不再
  是可诊断的 store product flag。
- 五个 C 项与现存真豁免逐条显式写 `reason/retireWhen`；允许小型常量复用 owner/issue，但不共享
  模糊理由或退役条件。
- `LEGACY_FLAG_EXEMPTION_BASELINE` 为空；测试另以 exact 29-name post-closeout census锁住
  `FLAG_EXEMPTIONS`，新增 row 必须先改 explicit ceiling，因此 synthetic exemption 不能让 raw
  product flag 变合法。`voice_qa_presence_override` 的 founder reclassification保留为具名
  `qa_isolation` row并补 retirement condition，不再依赖 legacy widening机制。

## 4. Slice D — runbook 与静态不变量

更新 `doc/engineer/implementation/flag-authoring-runbook.md` 为唯一短路径：

```text
registry entry + store codec + scope declaration + named store wrapper + route test
```

删除“先加 envVar / configKey / legacy baseline / 两份 managed membership / config fallback”的过时
authoring说明，但保留生产 `.env` 移除与部署顺序的七步操作合同、`已合并 / 已 staged ≠ 已部署`、
`no-old-binary-restart` 与“豁免不是新通道”。现有 pinned 旧路径短语改为本单验收要求的唯一短路；
对应 CI test 与文档同一 RED/GREEN batch 更新。明确：

- scope 只选 `'*'` global row 或 project row；所有 registry flag 都已 store-managed；
- flag 值不得写 `.env` / config.yaml，raw process-env/config read会被 CI 拒绝；
- exemption 只用于有退役条件的非产品 transient seam，不可让 product flag authoring 变绿；
- management write 只走 stage/apply + reason，不直接改 SQLite。

CI 读取 runbook 并断言上述词组/禁止项，防文档再次回到旧路径。

## 5. Slice E — targeted/full verification

### 5.1 Targeted

```bash
pnpm --filter flywheel-config exec vitest run \
  src/__tests__/feature-flags-store-policy.test.ts \
  src/__tests__/feature-flags-drift.test.ts \
  src/__tests__/fly1981-final-ledgers.test.ts \
  src/__tests__/feature-flags-registry.test.ts

pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/StateStore.flag-value-store.test.ts \
  src/__tests__/StateStore.flag-value-scope.test.ts \
  src/__tests__/flag-routes.test.ts \
  src/bridge/__tests__/flag-store-runtime.test.ts

pnpm --filter flywheel-config exec vitest run \
  src/__tests__/flag-truth.test.ts \
  src/__tests__/runner-mcp-profile.test.ts \
  src/__tests__/skill-framework-mode.test.ts

pnpm --filter flywheel-claude-runner exec vitest run test/TmuxAdapter.test.ts
pnpm --filter flywheel-gemini-agent exec vitest run src/__tests__/config.test.ts
pnpm --filter flywheel-voice-headphone exec vitest run src/__tests__/config.test.ts
pnpm --filter flywheel-voice-bridge exec vitest run src/__tests__/config.test.ts

bash scripts/test-cmux-sync.sh
bash scripts/__tests__/converge-flywheel-bin.test.sh
bash scripts/__tests__/converge-fly1389.test.sh
bash scripts/__tests__/packaged-seams.test.sh
bash scripts/__tests__/flywheel-fleet.test.sh
bash scripts/__tests__/flywheel-daemon-install-verify.test.sh
bash scripts/hooks/test-inbox-check.sh
```

若 skill resolver改动，再跑 config/edge-worker 的完整 skill-framework suite。

### 5.2 Full repo hard gates

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

另逐个运行本单新增的 `scripts/__tests__/*.test.sh`。上列既有 shell suites 即使不在 package test
聚合里也必须显式跑，不能用 full package gate替代。

## 6. Slice F — 真退役扫描与 notification 证据

代码与全仓门绿后，检查 Lead inbox 与 live readiness，然后：

1. 只读确认 live Bridge health、FLY-2104 route存在、scanner enabled、call-time notification
   identity齐全；不打印 token。
2. 对 loopback Bridge 发 auth-required `POST /api/flag-scan/run` body `{}`（不是 dryRun）。
3. 200 只有在 response 表示真实 pending/published run 时接受；`disabled`、`not_due`、409
   `lost_race` 都不能算。
4. 读取 durable run/effect evidence，取得 run id、candidate count、root message id / report URL。
5. 回读 `#flywheel-notification` 的 exact run marker：零候选必须有真实“0 候选”消息；非零则
   如实列出，不把验收改写成必须为零。
6. 把不含 secret 的 response/evidence/notification permalink 写入
   `scan-evidence.md` 并通过 `ask --report` 汇报 Lead。

如 live 前置缺失，向 Lead 报具体缺口并继续其它工作；不 restart Bridge、不改生产 access/env、
不使用隔离 mock 代替验收。

## 7. 提交、review 与 PR

1. docs/design approval commit。
2. 每个 TDD slice 小提交；每批后 `flywheel-comm progress`。
3. `stage set code_review`，开新 `review_code` gate并 `request-review`；CHANGES逐条修后开新 gate。
4. push并开非 draft PR；检查 exact head CI，禁止 self-merge。
5. literal last commit 新增 `engineering/doc/milestones/FLY-2105.md`，此前先读 milestones README；
   不碰 `CLAUDE.md`。
6. `ask --report "DONE: ..."` 后执行
   `complete --route needs_review --pr <NUMBER>`，由 DAG orchestrator推进 QA。

## 8. 预计文件清单

| 文件 | 变化 |
| --- | --- |
| `packages/config/src/feature-flags/store-policy.ts` | all-set、空 baseline、scope-aware policy |
| `packages/config/src/feature-flags/exemptions.ts` | Lead 锁定的真豁免 schema/exact 29 rows |
| `packages/config/src/ConfigLoader.ts` | 复用/必要时导出生产 retired-key judge，不建第三份 ledger |
| `packages/config/src/__tests__/drift-scan/index.ts` | raw compatibility特判删除 |
| `packages/config/src/__tests__/feature-flags-*.test.ts` | RED/GREEN不变量与 mutation fixtures |
| `packages/config/src/__tests__/fly1981-final-ledgers.test.ts` | 历史账与 live zero-baseline分离 |
| `packages/config/src/feature-flags/truth.ts`、`flag-truth.test.ts` | all-set env subset与 deleted seam truth verdict |
| `packages/teamlead/src/StateStore.ts` | all-set 后按 scope seed/write |
| `packages/teamlead/src/bridge/flag-store-runtime.ts` | all-set 后按 scope read |
| `packages/teamlead/src/bridge/flag-routes.ts`、`flag-toggle.ts` | all-set 后 global/project route guard |
| `packages/teamlead/src/bridge/management-existing-writers.ts` | project/global capability不被 all-set混淆 |
| `packages/flywheel-comm/src/commands/feature-flags.ts`、`scripts/lib/qa-generalized.mjs` | all-set consumer按 scope复核 |
| `packages/teamlead/src/**flag*.test.ts`、management writer tests | global/project negative guards |
| `packages/config/src/skill-framework-mode.ts` / Blueprint | 仅删除 raw compatibility 特判所需 |
| `doc/engineer/onboarding/tidal-echo/config.yaml` | 删除三条退役 flag 值 |
| `scripts/flywheel-cmux-sync.sh`、`scripts/test-cmux-sync.sh` | 四个 default-on gate固化与回归 |
| `scripts/converge-flywheel-bin.sh`、`scripts/flywheel-daemon.sh`、对应 shell suites | 两个 invocation-only QA seam结构化 |
| `packages/claude-runner/src/TmuxAdapter.ts`、`scripts/hooks/inbox-check.sh`、tests | mailbox migration seam保留且禁止 persistent |
| `packages/gemini-agent/**`、voice advanced integration/tests | default-off agent固化 retired |
| `packages/config/src/runner-mcp-profile.ts`、teamlead dispatcher tests | slim MCP default-on固化 |
| `packages/teamlead/src/bridge/{codex-global-health,merged-gate-guard,external-merge-reconcile,voice-routes}.ts` | safety/default-on gates固化 |
| `packages/teamlead/src/bridge/approval-signal/deferred-approval.ts`、tests | founder ack 固化开启 |
| `packages/teamlead/scripts/lib/lead-session-resume-gate.sh`、tests | context resume gate 固化开启 |
| `packages/teamlead/src/lead-backends/codex/tui-window-alert.ts`、runtime/tests | canonical InfraBot identity策略 |
| `packages/teamlead/scripts/run-codex-infra-bot-tui.sh` | 删除已固化的 alert env注入 |
| `packages/voice-bridge/src/{eleven,assistant}/wiring.ts`、staged E2E | 两个 autostart QA seam保留且结构化 |
| `packages/voice-headphone/src/config.ts`、`packages/voice-bridge/src/{config,cli}.ts`、tests | env overlays与 voice kill-switch退役 |
| `doc/engineer/implementation/flag-authoring-runbook.md` | 唯一 store authoring 路径 |
| `engineering/doc/FLY-2105-flag-governance-closeout/*` | 过程、RED/GREEN、真扫描证据 |
| `engineering/doc/milestones/FLY-2105.md` | PR literal last commit |

实现若证明 skill resolver无须改或某测试文件无变化，按 Ponytail 删除该预期改动；不为对齐清单
制造空改动。
