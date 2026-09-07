# FLY-2395 docs-only 判定覆盖全部 target repo — 调研

Issue: FLY-2395 (https://linear.app/geoforge3d/issue/FLY-2395/2309b1-docs-only-判定覆盖全部-target-repo-今天只看主仓实测漏-833且已在放行-qa-证据门p0-影子跑前置)
日期: 2026-09-06
基于: exploration.md

---

## 0. 结论

B′ 可落地,改动面收在 6 个文件 + 1 张新表 + 1 个回溯脚本;land / finalization / manifest / binding 主键零字节变化。
下面每一节都是「plan 要引用的事实」,全部在本 worktree 代码与只读副本上核过。

## 1. 逐点核对(plan 依据)

### 1.1 completion 事务里能不能同事务写声明 —— 能

`StateStore.commitEnrolledCompletion(input)`(`StateStore.ts:48199`)在一个 `db.transaction` 内:
- `input.prBinding`(单 PR)在 `:48695-48770` 按 `engine_owned` 分三路:`recordWorkflowNodePrBindingTx` / `recordWorkflowGateEntryBindingTx` / `mirrorSessionPrEvidenceTx`。
- 新增 `input.declaredPrs?: Array<{prNumber, headSha, targetRepoIdentity, probeRepoSlug, targetRepoPath}>`,在 `prBinding` 三路**之外、`workflow_node_completion` INSERT 之前**统一调 `recordShipRelevantDeclaredPrsTx({runId, executionId, rows, now})`,与 `engine_owned` 无关(它是证据,不是授权)。
- 事务回滚 ⇒ 声明与 completion 一起消失,不会出现「声明了但 completion 被拒」的半写。

### 1.2 `event-route` 解析 nested 仓的 authority —— 已有,可复用

`resolveBoundRepositoryAuthority({authorityRoot, requestedRepoPath})`(`repository-authority.ts:38`)已做:路径安全(拒绝绝对/`~`/`..`/控制字符)、必须是精确 git 根、不得逃出 worktree、`origin` 归一为小写 `owner/repo`、`HEAD` 40 hex。
对每条 `--declare-pr` 各调一次;`identity === '__main__'`(即 rel 解析回 worktree 根)⇒ 422 `declared_pr_rejected:main_repo_must_use_pr`。

### 1.3 execution → run —— `getWorkflowRunIdForExecution(executionId)`(`StateStore.ts:47395`)

`workflow_execution_binding ∪ workflow_run_node`,唯一时返回 run_id,否则 `undefined`。聚合器无 run 时退化为「只看本 execution 的声明」(legacy main 会话)。

### 1.4 快照表能否并存主仓 + nested 行 —— 能,只需改 `deleteOther` 语义

PK `(execution_id, pr_head_sha)`;nested 冻结 head ≠ 主仓 head。
`deleteOtherShipRelevantDiffSnapshots(executionId, keepPrHeadSha)`(`:11475`)改签名为 `(executionId, keepPrHeadShas: string[])`,SQL 用 `NOT IN (?,…)`(参数化,≤ 1+50 个)。`ShipRelevantDiffService.ensure` 里那一处调用改为传保留集合;唯一其它调用者是测试 `StateStore.ship-relevant-diff.test.ts`。
`repo` 列比较一律 `lower()`:主仓行是 `xrliAnnie/flywheel`(projects.json 原样),nested 行是 `xrliannie/raya`(authority 归一小写)。

### 1.5 GitHub 访问 nested 仓 —— 走同一把 `gh` token

`ensureShipRelevantDiff` 的 `api` 是 `gh api <path>`,路径里带 `owner/repo`,`cwd` 只影响 `gh` 找 repo 上下文,不影响 REST 路径。
`request-review --target-repo` 今天已用同一 token 对 raya 做 Codex 评审 ⇒ 可达。若某 nested 仓不可达 ⇒ `api_error` ⇒ `unknown` ⇒ fail-closed,不需要额外配置。

### 1.6 retention registry —— 新表登记三处

`scripts/lib/fly-2006-retention-registry.mjs` 只按**表名**分类(无列级)。新表 `ship_relevant_declared_pr` 要:
1. 加进 `TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference`(与 `ship_relevant_diff_snapshot` 同组);
2. 加进 `scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json`(按字母序);
3. `packages/teamlead/src/__tests__/fly-2006-database-retention-sweep.test.ts:301-318` 的硬计数 `173 → 174`、`170 → 171`。
否则 `assertNoUnclassifiedSchema` 抛 `schema_unclassified`(建表即红),`assertClassifiedSchema` 抛 `schema_missing`。

### 1.7 review-hold 的角色门 —— 保留

`reviewHoldReason`:`isReviewableRole`(main/implement)→ `awaiting_review` → head/pr_number 校验 → Codex → QA 记录 → `if (!mainRole) return null` → docs-only 分支。
B1 只替换最后一支的读法(单快照 → 聚合器),角色门、Codex 门、QA 门、60s 时效窗全部原样。DAG 里 qa 角色会话仍在 `isReviewableRole` 处返回 null —— 这是 FLY-793 既有语义,不属本单。
⇒ spec 的「review-hold 回归」用 **main 角色**会话构造。

### 1.8 CLI 参数 —— `parseArgs` 支持 `multiple: true`

`index.ts:1236 runComplete` 用 `node:util parseArgs`;新增 `"declare-pr": { type: "string", multiple: true }`。格式 `<rel-path>:<pr-number>`(用 `:` 而非 `#`,避免 shell 注释)。CLI 侧:`resolveEvidenceRepo(relPath)` 校验 + `git -C <path> rev-parse HEAD` 取 head;拿不到 head ⇒ 退出 1(不允许发出没 head 的声明,Bridge 会拒)。

### 1.9 G2 探测的数据源 —— worktree 绑定里已有

`store.getWorktreeBinding(executionId)` 返回 `repoBaselineSetJson`(`{version:1, repositories:[{relative_path, remote_identity, baseline_head}]}`,`packages/config/src/repository-baseline.ts`)。
G2 只对 `relative_path !== '.'` 的条目跑 `git -C <root>/<rel> rev-parse HEAD`(≤ 15s 超时,不做 dirty 检查、不做 discovery),head ≠ baseline 且 `remote_identity` 尾段(`owner/repo`)无声明 ⇒ 记 `observed_head_moved` 行。
`remote_identity` 形状是 `github.com/owner/repo`,取最后两段小写与 authority 的 `owner/repo` 比;比不上(local: 仓)一律视为未声明(fail-closed)。

### 1.10 回溯脚本能复用同一份判定代码 —— 能

`scripts/fly1686-gate-entry-audit.mjs:17` 已示范从 `../packages/teamlead/dist/*.js` import;`fly-2006-retention-rehearsal.mjs:28` 用 `better-sqlite3` 只读打开副本。
回溯脚本 `scripts/fly-2395-ship-relevance-retro.mjs --db <copy>`:按 spec cohort SQL 取 run 集,对每个 run 用库里事实构造聚合器输入(主仓快照按 spec 取 `max(ship_relevant)` 那一行;声明集 = 库里该表的行,历史为空;G1 = `codex_review_record` 非 `__main__` identity 集),调 **同一个** `resolveRunShipRelevanceFromFacts`(纯函数,不依赖 store),打印 `全集 / docs_only / with_nested→非docs_only / 反向对照仍 docs_only`。

## 2. 只读副本上的回溯预演(手算,不是跑脚本)

副本 `db-copy 2026-09-06T23:35:28Z`,全集:有快照的 run **292** 个(35 docs-only + 257 code)。

| 组 | 数 | 新规则下 | 依据 |
| --- | --- | --- | --- |
| docs-only 且带 nested 评审 | 8 | **全部 → unknown(非 docs-only)** | G1:无声明 + nested identity 存在 |
| docs-only 不带 nested | 27 | **仍 docs_only** | 无声明、无 G1/G2、主仓快照=0 |
| code 且带 nested | 3 | ship_relevant(不变) | 主仓快照=1 优先 |
| code 不带 nested | 254 | ship_relevant(不变) | 同上 |

阳性 8/8,反向 27/27;spec 写的 22 是 2026-09-03 副本的数,方向一致。**这是把机制套回历史算出的反事实,不是跑出来的;脚本落地后以脚本输出为准。**

⚠️ 副本里 8 个 run 的 nested PR **号**不存在(§exploration 1.3),回溯不可能「重新分类 nested PR」;能做且够用的是 G1。plan 的验收按此写,不许把「重分类 nested PR」写成回溯做了的事。

## 3. 决定(带取舍)

| # | 决定 | 备选与为何不选 |
| - | --- | --- |
| D1 | 声明落新表 `ship_relevant_declared_pr`,不写 `workflow_declared_pr` | 写 declared_pr 会触发 `manifest_not_sealed` / `land_gate_entry_sealed_manifest_stale`(exploration §1.4②);列形状对齐,日后一对一可铸 |
| D2 | 声明按 **execution** 落行,聚合按 **run 全体 execution 取并集** | 只取最新 execution 会漏 implement 声明、QA 未重申的 PR;并集只会让 docs-only 变 unknown/ship_relevant(安全侧),不会反向 |
| D3 | 快照复用 `ship_relevant_diff_snapshot`,不建「run 级判决表」 | 判决 = 快照 + 声明 + 证据的纯派生;再存一份就是镜像词汇。B3/B4 要台账时从聚合器取值落自己的表 |
| D4 | G2 只记不拒 | 影子跑期间不给 runner 加硬失败;判定仍 fail-closed |
| D5 | 版本 1→2 | spec 硬要求;旧行走既有 `qa_evidence_missing` 路径自然失效 |
| D6 | hold 原因词不新增 | `unknown → qa_evidence_unknown`、`ship_relevant → qa_evidence_missing`,消费者(GatePoller `handleHeldReviewGate`、deferrable 判定)零改动 |
| D7 | 主 PR 的 repo 取节点绑定 `probe_repo_slug`,无绑定退回 `projectRepo` | 修 exploration §5 那个「主 PR 在 nested 仓却按主仓拉」的既有错对象 |

## 4. 风险

| 风险 | 处理 |
| --- | --- |
| runner 不声明 nested PR(prompt 没跟上) | G1 兜底(有 Codex 评审必被抓);G2 兜底(head 动了必被抓);Blueprint 提示词同 PR 改 |
| nested 仓 `gh` 不可达 | `unknown`,fail-closed;不新增配置 |
| 每 tick 对 nested PR 多打 GitHub | 走同一 `ShipRelevantDiffService` 的租约/退避(docs 侧 10s、code 侧 30s、失败 60s);声明数上限 50 与 manifest 同 |
| 版本翻 2 的瞬间所有在飞 `awaiting_review` 主会话变 `qa_evidence_missing` | 下一 tick `ensure` 重算(几秒);spec 期望行为 |
| 声明表被 retention 误删 | 归 `protectedCurrentOrReference`,测试硬计数守住 |

## 5. 不确定 / 未核

- 25 条 main 角色 docs-only 快照当时是否真走到免 QA 分支:**未核**,plan 不引用。
- `engine_owned` 运行里 QA 节点是否总在 implement 之后重申主 PR:观察到是(8/8),未证明是合同。D2 的并集正是为此。

## 6. 修订(2026-09-06,plan R2 之后)

Codex R1 推翻了本文三处,以 plan.md R2 为准:
- §1.4「快照复用旧表 + `deleteOther` 保留集合」→ 改为新表 `ship_relevant_pr_snapshot`(全元组键,含 `commit_shas`),旧表冻结不删。
- §1.9 / D4「G2 只记不拒」→ G2 整体移出本单(plan §9),原因:证明不了 PR 全集,且 completion 热路径撞 5s 客户端期限。
- §2 回溯预演的「8/8、27/27」只在 **historical adapter**(显式忽略 v1 版本与 60s 时效)下成立;生产 adapter 对历史行一律 `unknown:primary_snapshot_version_mismatch`,脚本必须同时打印两者以证明没有偷用放宽规则。
