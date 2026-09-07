# FLY-2395 docs-only 判定覆盖全部 target repo — 探索

Issue: FLY-2395 (https://linear.app/geoforge3d/issue/FLY-2395/2309b1-docs-only-判定覆盖全部-target-repo-今天只看主仓实测漏-833且已在放行-qa-证据门p0-影子跑前置)
日期: 2026-09-06
基于: 无(上游为 `product/doc/FLY-2309-auto-merge-rollout/build-issues.md` §B1 与同夹 research.md §2)

---

## 0. 一句话

今天的「纯文档」判定只看主仓那一个 PR;B1 要把它改成「这一单的全部 PR 都是纯文档才算纯文档」,
拿不到任何一个 PR 的分类就整单判 `unknown`(不算纯文档)。本探索回答 Lead 点名的两问,
并发现 Lead 选的方案 B 里有一处**没被 spec 看到的耦合**:`workflow_pr_manifest` / `workflow_declared_pr`
是 **closeout 授权台账**,写它会改 land 门与 finalization 的行为。因此提出 **B′**:声明形状照 B,
落点换成一张新的分类证据表。

## 1. 现状审计(全部实测于 2026-09-06,只读副本)

### 1.1 分类器的入口与消费者(代码)

| 环节 | 位置 | 实况 |
| --- | --- | --- |
| 分类器 | `packages/teamlead/src/bridge/ship-relevant-diff.ts` | `classifyShipRelevantDiff({repo, prNumber, prHeadSha, api})` 单 PR:拉 `/pulls/N` + `/files` + 两棵树,全落 6 个前缀且 `changed_files ≤ 50` ⇒ `ship_relevant=0`;任何拿不到 ⇒ `unknown`。`SHIP_RELEVANT_CLASSIFIER_VERSION = 1` |
| 快照表 | `ship_relevant_diff_snapshot` PK `(execution_id, pr_head_sha)`,列 `repo, pr_number, base_ref, base_oid, classifier_version, ship_relevant, file_count, sample_paths, computed_at` | 307 行,306 行 `xrliAnnie/flywheel`,1 行 `belle-workspace`。**nested repo 零行** |
| 唯一生产者 | `plugin.ts:4988 ensureShipRelevantDiff(session)` | 只吃 `session.pr_head_sha` + `session.pr_number` + `project.projectRepo`;由 `gate-poller.ts:897` 在 `approve_to_ship` 问题出现时每 tick 调一次 |
| 唯一消费者 | `review-hold.ts:156-176 reviewHoldReason` | main 角色 + `awaiting_review` + Codex 满足 + 无 QA 记录 ⇒ 读快照;`ship_relevant===0 → null`(不 hold);版本不符 → `qa_evidence_missing`;过期(60s) → `qa_evidence_unknown` |
| 服务层 | `ShipRelevantDiffService.ensure` | 按 `executionId:head` 合流;`deleteOtherShipRelevantDiffSnapshots(executionId, keepHead)` 每 tick **删掉同 execution 下其它 head 的行** —— 这条语义直接决定「nested 行能不能和主仓行共存」 |

### 1.2 DAG 节点怎么报 PR(代码)

- `flywheel-comm complete --route needs_review --pr N [--target-repo <rel>]`:**一次只能报一个 PR**(`complete.ts:144-189`);`--target-repo` 的含义是「这个 `--pr` 在 nested 仓」,不是「另外还有一个 nested PR」。
- Bridge `event-route.ts:796-880`:用 `resolveBoundRepositoryAuthority({authorityRoot, requestedRepoPath})` 从 worktree 真 git 状态解析 `identity`(nested 为小写 `owner/repo`,主仓为 `__main__`)/ `probeRepoSlug` / `headSha`,与 CLI 报的 head 逐字相等才铸 `prBinding`,随 `commitEnrolledCompletion` 一并落 `workflow_node_pr_binding`。
- 所以 schema 早就能放 nested(`target_repo_identity` 列),**生产 427 行全 `__main__`** 的真因是:runner 只能报一个 PR,而 land 只认主仓(`land-executor.ts:363` 非 `__main__` ⇒ `nested_land_unsupported`),runner 自然报主仓那个文档锚点 PR。
- nested 代码 PR 的痕迹只在 `codex_review_record.target_repo_identity`(由 `request-review --type code --target-repo <rel>` 写入,68 行非 `__main__`:raya 60、claude-plugins-official 4、flywheel 4)。**它只有 head sha,没有 PR 号。**

### 1.3 那 8 个 run 的长相(只读副本,`db-copy 2026-09-06T23:35:28Z`)

复现 SQL(照 spec)结果:`docs_only_runs=35, docs_only_with_nested=8, code_runs=257, code_with_nested=3`
(spec 2026-09-03 副本:33 / 8 / 212 / 3 —— 绝对数漂,比例与方向一致:nested 仍扎堆在 docs-only 类,8/35≈23% vs 3/257≈1%)。

8 个 run 逐个看(`run | issue | 绑定 | nested 评审 | 主仓快照`):

```
0edd3ffa FLY-2032 qa/1:PR976@__main__            raya×1   flywheel#976=0
1be070a2 FLY-2130 qa/1:PR979@__main__            raya×1   flywheel#979=0
3f9f9f1c FLY-2178 qa/2:PR1006@__main__           raya×17  flywheel#1006=0
54f0d683 FLY-2226 qa/1,qa/2:PR1019@__main__      plugins-official×2  flywheel#1019=0
5ae599c6 FLY-2029 qa/3,qa/4:PR960@__main__       raya×3   flywheel#960=0 (两个 head)
9788cc4d FLY-2097 qa/2:PR973@__main__            raya×1   flywheel#973=0
c0ba3d95 FLY-2249 qa/6:PR1035@__main__           raya×6   flywheel#1035=0
c8f001a6 FLY-2205 qa/1,qa/3:PR1009@__main__      raya×6   flywheel#1009=0
```

三点观察:
1. 绑定与快照**全部挂在 qa 节点**;implement 节点的 session 也带 `pr_number`(主仓),但没绑定行(绑定由 QA 节点铸)。
2. 快照角色分布:`ship_relevant=0` 的 38 行里 main 25 / qa 13;spec 说的「23 条挂 main」现在是 25 条。
   这些 main 行是否走到 `review-hold` 的 docs-only 分支、当时是否 `awaiting_review`、是否在 60s 窗内 —— **本探索仍未核**,plan 不引用它们做任何结论。
3. nested PR 的**号码**在库里不存在,只有 head。回溯验收不能靠「重新分类 nested PR」,只能靠「nested 证据存在但未声明 ⇒ unknown」这条负向护栏(见 §4)。

### 1.4 Lead 点名的两问 —— 答案

**① manifest / declared_pr 为什么从未被使用**

- 出处:`engineering/doc/FLY-1434-dag-ship-chain-fixes/plan.md` ⑥「manifest/seal 收口」:
  step-1 由 **Lead 在派 implement 时**调 `POST /api/runs/:runId/pr-manifest {expectedCount}`(master-token)开模;
  step-2 「声明全集一次提交(runner complete evidence `declaredPrs` **或** Lead 端点)」封口。
  plan §13.3 明写「expectedCount 来源:Lead 派单时从计划读取,登记错数 = 人为错误面」。
- 实况:三条路由在(`runs-route.ts:770/820/872`),**全仓零调用方**:`packages/flywheel-comm` 无对应子命令、`scripts/` 零引用、
  `~/.claude/plugins/cache/*` 零引用、Lead skill 零引用;`declaredPrs` 这个 evidence 字段**从未在 flywheel-comm 里实现**。
- 结论:**没接写入方**。不是 flag 关着,不是被取代,也不是废弃 —— 它的读侧(`claimWorkflowPrFinalization`、
  `listWorkflowPrConvergenceRows`、`markWorkflowDeclaredPrMergedTx`、land gate entry 校验)全都活着,
  只是「无 manifest 行 = single-PR 现状语义(零迁移)」让它一直沉默。**不触发 Lead 的「已废弃则停下」条件。**

**② 声明入口要绕开绑定层 —— 对,但绕到哪里去,spec 没看到下面这层**

`sealWorkflowPrManifestFromBindings` 从绑定层铸(`StateStore.ts:46975`),绑定层全 `__main__`,所以声明必须由 `complete` 直接写。
可 declared_pr 一旦有行,**closeout 链就换了一条路**:

| 读侧 | 位置 | 有 manifest 时的行为 |
| --- | --- | --- |
| finalization 领取 | `StateStore.ts:47261 claimWorkflowPrFinalization` | manifest 存在但未 seal ⇒ `manifest_not_sealed`(finalization 挂住);seal 后任一声明 PR 未 merged ⇒ `manifest_incomplete` ⇒ post-ship 报 `workflow_pr_manifest_partial:N`,run 不收口 |
| land gate 入口 | `StateStore.ts:47699-47716` | sealed manifest **必须 `expected_count === 1` 且恰等于 land 候选**,否则 `land_gate_entry_sealed_manifest_stale` ⇒ **land 拒绝** |
| 外部合并对账 | `external-merge-reconcile.ts:523` | 只扫 sealed 行,对每个声明 PR 用 `gh pr view --repo <probe_repo_slug>` 探 merge |

⇒ 把 nested PR 写进 `workflow_declared_pr` = 把「nested PR 也是本单收口条件」写进 land/finalization 授权链。
这撞两条红线:「影子跑期间一条规矩都不改」与「不动 merge 授权契约」。**方案 B 字面执行不可行。**

## 2. 问题重述(B1 真正要的是什么)

B1 要的是**分类的真值**:判定 docs-only 时看得见这一单全部 PR。它**不要求**改变谁负责合并 nested PR、run 何时收口。
所以「本单的 PR 集合」在这里是**分类证据**,不是**收口授权**。今天仓里恰好只有授权层有这个形状,才让 spec 想去借它。

## 3. 三条路(含 Lead 已排除的)

| | 方案 | 判定 |
| - | --- | --- |
| A | 改 `workflow_node_pr_binding` 主键,让节点绑多个 PR | ⛔ Lead 已排除(动授权层台账) |
| B(字面) | 节点声明全部 PR → `workflow_pr_manifest` + `workflow_declared_pr`,分类器读它 | ⛔ §1.4② —— 写它就是改 land/finalization 规矩;要走通得同时改 land seam(`expected_count===1`)—— 那是 merge 授权契约 |
| **B′(推荐)** | 声明形状照 B(节点在 `complete` 时声明**全部** PR,Bridge 用 `resolveBoundRepositoryAuthority` 冻结 identity/slug/head),**落点换成新表 `ship_relevant_declared_pr`**(分类证据,登记 `protectedCurrentOrReference`);分类器 = 主仓 session PR + 该表全部声明 + 负向护栏 | 机制与 B 一样是「声明 → 分类」;不碰 manifest / declared_pr / binding 主键;land、finalization 字节不变 |

B′ 与 B 的**唯一**差别是持久化目标。若将来 Lead 决定让 closeout 也认 nested PR(那是改规矩的那天,B5 的事),
`ship_relevant_declared_pr` 的行可以一对一铸进 `workflow_declared_pr`(列形状特意对齐:`repo_identity / probe_repo_slug / pr_number / frozen_head_sha`)。

## 4. B′ 的骨架

### 4.1 声明入口

`complete --route needs_review|pr_handoff --pr <main> [--declare-pr <rel-path>:<pr-number>]...`(可重复)。
CLI 校验路径安全(复用 `resolveEvidenceRepo`)、读该仓 `HEAD` 作 `headSha`,放进 `evidence.declaredPrs[]`。
Bridge `event-route` 对每条用 `resolveBoundRepositoryAuthority({authorityRoot: worktree, requestedRepoPath})` 解析:
identity 必须非 `__main__`(主仓走 `--pr`)、head 必须与 CLI 报的逐字相等、去重;任一不符 ⇒ 422 `declared_pr_rejected:<reason>`,
与今天 `workflow_pr_binding_rejected` 同形。通过后随 `commitEnrolledCompletion` 同事务写 `ship_relevant_declared_pr`。

### 4.2 分类

`ensureShipRelevantDiff(session)` 除主仓外,对 run 内全部声明行各 `ensure({executionId: session.execution_id, repo: probe_repo_slug, prNumber, prHeadSha: frozen_head_sha})`,
快照仍落 `ship_relevant_diff_snapshot`(键 `(execution_id, head)` 天然不撞:nested head ≠ 主仓 head)。
`deleteOtherShipRelevantDiffSnapshots` 改成保留集合(主仓 head + 全部声明 head)。

### 4.3 聚合(纯函数,同步)

新模块 `bridge/run-ship-relevance.ts`:`resolveRunShipRelevance(store, session) → {verdict: docs_only|ship_relevant|unknown, reason, prs[]}`。
规则按 fail-closed 顺序:主仓快照缺/版本不符/过期 ⇒ unknown;任一声明 PR 快照缺/不符/过期 ⇒ unknown;
负向护栏命中 ⇒ unknown;任一 `ship_relevant=1` ⇒ ship_relevant;`Σ file_count > 50` ⇒ ship_relevant;否则 docs_only。
`review-hold.ts` 的 docs-only 分支改为调它;hold 原因词汇不新增(unknown→`qa_evidence_unknown`,ship_relevant→`qa_evidence_missing`)。

### 4.4 负向护栏(防「忘了声明」)

- G1(零新 I/O,历史 8 个 run 全靠它翻):run 内任一 execution 的 `codex_review_record.target_repo_identity ≠ '__main__'` 且没有同 identity 的声明 ⇒ `unknown:nested_review_undeclared`。
- G2(completion 时一次 git 探测):worktree 绑定的 `repoBaselineSetJson` 里每个 nested 仓,`rev-parse HEAD` ≠ `baseline_head` 且没声明 ⇒ 记 `observed_head_moved` 行 ⇒ `unknown:nested_head_moved_undeclared`。**不拒绝 completion**(影子跑期间不给 runner 加新的硬失败),只让判定 fail-closed。
- 反向防呆(防一刀切):无声明、无 G1/G2 命中、主仓快照=0 ⇒ 必须仍是 docs_only。回溯 27/35 个 run 靠它证明判别力。

### 4.5 版本

`SHIP_RELEVANT_CLASSIFIER_VERSION: 1 → 2`。旧快照被 `review-hold` 判 `qa_evidence_missing`、被 `ensure` 删除重算;历史行不改写。

## 5. 与「主仓 PR 本身在 nested 仓」的既有 bug

`complete --pr N --target-repo rel`(主 PR 在 nested 仓)时,`ensureShipRelevantDiff` 用 `project.projectRepo` + `N` 去拉 —— 拉的是主仓的另一个 PR,
head 对不上 ⇒ `unknown`(今天 fail-closed 侥幸没放错,但分类对象就是错的)。B′ 顺手修:主 PR 的 repo 取该 session 节点绑定的 `probe_repo_slug`,无绑定才退回 `projectRepo`。

## 6. 不做什么(边界)

- 不动 `founder-only-authority`、land seam(`expected_count===1`)、`workflow_node_pr_binding` 主键、`workflow_pr_manifest` / `workflow_declared_pr`。
- 不改写历史快照行;不让 nested PR 进 closeout 条件;不在影子跑期间新增任何 runner 硬失败(G2 只记不拒)。
- 不回答「23/25 条 main 角色 docs-only 快照当时有没有走到免 QA 分支」—— 未核,plan 不引用。

## 7. 待 Lead 裁(已非阻塞 ask,id `56ff5e3f`)

B′ 与字面 B 的取舍。我按 B′ 写 research / plan;若 Lead 坚持写 `workflow_declared_pr`,plan 需追加「同时改 land seam」章节并越过本单边界,需 Lead 明示。
