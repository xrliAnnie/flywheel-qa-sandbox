# FLY-1251 ship-gate 契约落地 — QA 报告（PR-1 止血版）

Issue: FLY-1251 (https://linear.app/geoforge3d/issue/FLY-1251)
日期: 2026-07-14
基于: plan.md / research.md / exploration.md（同文件夹）

> 三段式 pipeline 的 QA 段。独立复验 implement 段在本分支已提交的 PR-1（止血）实现，
> **不重新实现**。verdict = **PASS**。

## 1. 结论

**FAIL（kickback 回 implement）。** 我的独立测试（真 StateStore E1 重放 + 老库迁移，10/10 绿）
证实止血主路径正确；但作为 QA 段必过的 **FLY-827 Codex 代码审查硬门**（head `12ebbac8`）
返回 **CHANGES REQUESTED**，在 founder-approval **授权边界**上查出真实缺口。授权边界的
fail-closed 一致性对本单（founder-approval 绑定根治）是核心诉求,不能带已知 fail-open 窗口上船。
按三段式纪律,QA **不改 implement 代码** → kickback 给 implement 段修,修后我复验 + 重跑 Codex。

交付范围与 plan §0 一致:本段验的是 **PR-1**。PR-2（卡生命周期 + R9）与 §5 契约级设计不在
已提交代码内,本报告不为其背书。

## 1b. Codex R1 findings（我的 colleague 评估——非橡皮章）

审查 = https://github.com/xrliAnnie/flywheel/pull/594#pullrequestreview-4700220465

| # | 位置 | Codex 严重度 | 我核实后的判断 |
|---|---|---|---|
| 1 | `auto-qa-held.ts:145-150` | HIGH | **真·plan §3.2 顺序偏离**。谓词把「passed record → 放行」和「codex 未过 → codex_pending(可 defer)」放在 `pr_number == null → qa_evidence_unknown` **之前**。plan §3.2 明确 pr_number 检查**优先**(fail-closed)。后果:pr_number 缺失时(半失败身份)得到**可 defer** 的 codex_pending,或被 passed record 直接放行——授权边界应先 fail-closed。mitigations(deferred-replay 复检 + record 需 pr_number)缩小活体可达性,但顺序偏离本身是 auth 边界的一致性缺陷。**保留,implement 修:把 mainRole 的 pr_number==null 检查上移到 codex/record 之前**。 |
| 2 | `ship-relevant-diff.ts:296` | HIGH | 分类末尾无 metadata 终检——force-push 期 metadata(head/base/changed_files)与 files/trees 可能取自不同提交状态。count-check + head-pin tree 取 + session rebind 提供部分护栏,属**纵深防御**;偏 MEDIUM,但 plan §3.1「head.sha != 请求 head → 放弃」意在全程 head 一致,末尾补一次 head 复核合理。**保留(纵深),implement 补末检**。 |
| 3 | `ship-relevant-diff.ts:381` | HIGH | **真·有界 fail-open**。`metadataAfter` 节流(30s,commit `9013d0b3` 引入)使 base/head 复核不再是 plan §3.1 所述「每次」;retarget 后旧 docs-only 豁免在 ≤30s 窗口内仍放行 founder。窗口窄但落在本单核心 auth 边界上。**保留,implement 修:retarget/base 复核不受 metadata 节流影响(或缩到远小于卡交互节奏)**。 |
| 4 | `qa-fly-1251-ship-gate.test.ts:166` | LOW | 我的测试注释暗示测了「qa_required=0 不被消费」,但谓词结构上根本不读 qa_required(不在 QaHeldSession、无引用)。注释已修正为准确表述(测试价值 = 无任何 qa_required 豁免路径存在时仍 hold)。这是 QA 段自有测试,已在本段改。 |

## 2. 我做了什么（独立验证，非重跑 implement 的自证）

implement 段的谓词单测走**手写 fake store**。我另建了打**真 StateStore** 的独立测试
`packages/teamlead/src/__tests__/qa-fly-1251-ship-gate.test.ts`（10 例，全绿），专攻两个
fake 测不到、但真机部署会踩的洞：

### 2.1 老库升级路径（每次真部署都走，此前零覆盖）

`auto_qa_record.enrollment_source` 是新增 **NOT NULL** 列。生产每个 Bridge DB 都已有
`auto_qa_record` 表 → `CREATE TABLE IF NOT EXISTS` 在那里是 no-op，**只有 ALTER 迁移**
才会加列。所有既有单测从干净 schema 起，**从不**触发真部署的这次升级。

我用 git 历史里的 pre-FLY-1251 表结构 seed 一个老库，再用 `StateStore.create` 打开，验证：
- 迁移**跑了**且把既有行 backfill 成 `enrollment_source='auto'`（不撞 NOT NULL）；
- 升级后的库能 `claimAutoQaRecord`（若 ALTER 缺失，生产每次 claim 都会抛）；
- 迁移**幂等**（重开已升级库不报错）。

> 结论：迁移在 `StateStore.migrate()`（构造时调 `migrateAutoQaRecordQaIssueColumns`）里
> 正确串联——CREATE（新库）与 ALTER（老库）双路径都成立。

### 2.2 E1 事故重放（打真 StateStore 的真行 shape）

用真 `upsertSession` + `setReviewBinding`（写 pr_head_sha 的真入口）+
`recordCodexReviewApproved` + `putShipRelevantDiffSnapshot` 复刻事故行 shape：
- code PR + 零 QA record → `qa_evidence_missing`，`founderApprovalHoldGuard` = true（卡不发）；
- snapshot 未算出 → 一样 hold（fail-closed）；
- **唯一放行** = server 判定 `ship_relevant=0`（docs-only）；
- 真 QA record 从 running→passed → 解 hold（全链）；
- **锚错卡不掉**：docs-only 豁免绑到别的 head / 别的 PR 号 / 旧 classifier_version → 都**不能**放行本 head。

## 3. 复验 implement 已有覆盖（读代码 + 跑测试）

- **谓词** `reviewHoldReason`（`auto-qa-held.ts`）：main-only；pr_number 缺→unknown；
  head 缺/非法→unknown（旧 fail-open 已闭）；store 读 throw→main 返 unknown（非 main rethrow，
  字节兼容纪律）；`qa_required` 不再被发卡面消费。
- **分类器** `ship-relevant-diff.ts`：读了实现 + 16 个单测。对抗逃逸全部正确判 `ship_relevant=1`：
  code→docs rename（双侧 allowlist）、removed-side symlink(120000)/gitlink(160000)/exec(100755)、
  mode 变（100644↔100755）、malformed rename、tree truncated/不可得、计数不符、>50 文件、head 漂移放弃、
  base_oid 变更删行重算。docs-only 放行需两段（路径 allowlist + 两侧 Git-tree 权威 mode=100644/type=blob）全过。
- **manual-QA** `manual-qa-routes.ts` + `AutoQaCoordinator.manualSpawnQa`：server-owned spawn；
  API schema 严格两字段、**拒 executor 参数**；stage→token→apply 两步；死 runner(stuck/failed)
  CAS 复活、活 runner/passed 拒 re-drive；claim 竞态幂等。
- **旁路删除**：`FLYWHEEL_ATTRIBUTION_HOLD_ALIGN` flag 从 registry + plugin.ts 移除；
  `founderApprovalHoldGuard`/`founderHoldReasonFor` 不再读该 env（`=0` 无法再绕 live hold）。
- **deferred replay**：新两原因入 NON_DEFERRABLE，replay 出口拒 defer + 转 readiness pointer 文案。

## 4. 测试证据

- **FLY-1251 相关文件：206 断言全绿，0 失败**（auto-qa-held / review-held / ship-relevant-diff /
  manual-qa-routes / auto-qa-coordinator / StateStore 迁移 / gate-poller ship-readiness /
  deferred-approval / founder-ship-approval + 本段新增 qa-fly-1251 10 例）。
- **新增独立测试**：`qa-fly-1251-ship-gate.test.ts` 10/10 绿，biome lint 干净。
- **全 teamlead 套件**：7036 中 65 失败——**全部**在与 FLY-1251 无关的文件，属**环境性假失败**：
  - `codex-lead-runtime`（22）：错误原文 `FLYWHEEL_CODEX_LEAD_WORKSPACE ... must not overlap ~/.flywheel`
    ——本 runner 的 `TMPDIR` 落在 `~/.flywheel` 下触发安全 guard（已知 false-failure，见 memory
    `reference_qa_codex_lead_runtime_tmpdir_overlap.md`）。
  - `close-runner`/`post-merge`/`post-ship-finalization`/`tmux-lookup.real-tmux`/`createLeadRuntime-preflight`/
    `worktree-quarantine`/`actions.terminate` 等：`STACK_TRACE_ERROR` 子进程/tmux 超时——load 15-26/18 核高负载。
    **隔离 + 干净 TMPDIR 复跑**：close-runner + post-merge 全过（18/19 假失败恢复）。
  - `stuck-candidate`（FLY-1048 heuristic，本分支**未触碰**该文件与 stuck-detector 源）：确定性
    pre-existing，与 FLY-1251 代码无关。
  > FLY-1251 改动只碰 `git diff --name-only main...HEAD` 里的 config/StateStore/auto-qa-held/
  > deferred-approval/founder-ship-approval/auto-qa-coordinator/gate-poller/manual-qa-routes/plugin/
  > ship-relevant-diff——**无一** stuck/tmux/close-runner 源。65 失败**非** FLY-1251 回归。
- CI（PR #594，head `9013d0b3`）：Build & Test SUCCESS；PR MERGEABLE。

## 5. 边界与不背书项（诚实）

- 本段只验 **PR-1**。PR-2 卡状态机 / R9 / §4.3 授权前置 / §5 契约级（run 级 barrier、ship_subject、
  freeze_epoch、merge 闸终态）**不在已提交代码**，不背书；它们依赖 FLY-1244 seam + 子单。
- 未做真机 Discord E2E（本段代码改动为 Bridge 内谓词 + StateStore + server 路由，
  无 founder 面渲染变化需真机看；行为由上述真 StateStore 测试 + 全套件锚定）。
- 环境性套件失败（TMPDIR-in-~/.flywheel + 高 load）是 runner 宿主环境所致，非代码缺陷；
  CI（干净环境）Build & Test 为绿。

## 6. Verdict

**FAIL — kickback 回 implement 段。** 止血主路径与老库迁移经我独立真机测试证实正确
（10/10 + 206 相关断言绿）;但 FLY-827 Codex 硬门在 head `12ebbac8` 返回 CHANGES REQUESTED,
在 founder-approval 授权边界上查出 3 项真实缺口(HIGH-1 谓词顺序偏离 plan §3.2、HIGH-3 base
复核 30s 节流导致 retarget 后有界 fail-open、HIGH-2 分类末尾无 head 终检)+ 1 项我已在本段修的
测试注释(LOW-1)。§1b 是我逐条核实后的判断,非橡皮章。

implement 段修 §1b 的 HIGH-1/2/3(implement 代码)后,QA 复验 + 重跑 Codex code review 至 APPROVED,
再走 founder approve gate。**在 Codex APPROVED 之前不写 code-review.json、不开 approve gate。**
