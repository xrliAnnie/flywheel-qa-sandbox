# FLY-1251 ship-gate 契约落地（R1 execution 域全量 / R2 止血版 / R9 全量 / R8 余量；R4/R7 及 run 级 barrier 契约级）— 实施计划

Issue: FLY-1251 (https://linear.app/geoforge3d/issue/FLY-1251/build-fly-1211-ship-gate-契约落地-founder-approval-绑定根治r1-r9主通道-a)
日期: 2026-07-14
基于: research.md

> 三段式 pipeline：本文档由 design 段产出，**implement 段在同一分支照此执行**，QA 段独立复验。
> 上游权威 = `product/doc/FLY-1211-founder-approval-binding/prd.md` v6（Codex APPROVED，主通道 A 已拍板）。
> brainstorm gate 三点拍板（Tadashi 2026-07-14）：①implement 段交 Slice1+Slice2，Slice3 契约级设计、实施拆子单；②merge 闸收紧排 FLY-1244 落地后（过渡期由 founder-gated + Lead 人肉 verify-approval 链兜底，不裸奔）；③**代码 PR 零 policy 豁免**——qa.auto:false / skip_labels / no-qa label / 全局 kill-switch 只关「自动 spawn QA」这个运维动作，**不构成 ship 豁免**；唯一合法豁免 = server 算 diff 的 docs-only（绝不认 label）。
> Codex design review R1（7 HIGH / 1 MED）全采纳：诚实重标交付边界（R1#1）、卡 attempt 化 + crash 窗口 reconcile（R1#2）、active 卡 = USE-time 授权前置 + text 指卡（R1#3）、pr_number/head 缺失 fail-closed（R1#4）、manual QA 改 server-owned spawn（R1#5）、docs-only 分类器全契约化（R1#6）、stale 观测无硬窗 + durable cursor（R1#7）、symbol 级集成矩阵（R1#8）。
> Codex R2（4 HIGH / 2 MED）全采纳：每个非终态定义收敛转移 + 完整 nonce 扫描才许 orphan-retire（R2#1）、**FLY-1244 授权 seam 升级为 PR-2 硬前置 + 六路授权矩阵 + deferred approval replay 拒绝**（R2#2）、观测解除条件收紧为验证删除、grey-edit 只降频不解除（R2#3）、二段 entry 验证 + base_oid 校验（R2#4）、谓词级单一 fail-closed 异常边界（R2#5）、coordinator 公开 `manualSpawnQa` admission + stuck 有界 re-drive（R2#6）。
> Codex R4-R11 全采纳（每轮 grep 验证落盘）：normative §4.2 POST 分类与步骤序真正落地 + 观测/edit 资格分离 + rejected-reaction quarantine 协议（R4）、唯一激活原语 + quarantine 可执行 DDL/crash 序 + USE-time 通道健康（R5）、episode 可重臂 + durable lane health（R6）、ensureReactionBlocked 收敛 + lane 键按授权 lane + 封闭结果表（R7）、boot 作用域信任 + 启动 authority-reconciliation barrier + config drift（R8）、boot reconciler 终态封闭 + 404 state-sensitive + 同 boot poison（R9）、unresolved 有界终态 + invalidate/repost 分离（R10）、isolated_for_boot 第四 disposition + 发卡前置 step 0 + 层次归位（R11）。**Round 12 APPROVED**（1 LOW wording 已折入）。
> Codex R3（4 HIGH / 1 MED）全采纳：ambiguous POST 结果保持 posting 进 nonce reconcile + channel_down 不动未决 posting 行 + posting+ID 进观测集（R3#1）、二段验证换 **Git Trees API 权威 mode**（contents API 不权威：无 mode、submodule 可报 file、symlink 可返回目标内容）+ base/head 双侧 + removed 也验（R3#2）、**1244 commit A（`35a04f510`）已落但无 seam——前置精确化为「1244 seam 后续 commit」，交付清单四项、落地后钉 hash，未落前 PR-2 授权部分 = blocked**（R3#3）、active-held 卡点击的静默短路改 typed 回应（R3#4）、全文一致性扫（R3#5）。

---

## 0. 交付物与红线（诚实边界，R1#1）

**两个 PR，顺序交付**（止血先行先生效）：

- **PR-1（止血）**：`qa_evidence_missing` / `qa_evidence_unknown` 发卡 hold + docs-only server 判定 + manual-QA **server-owned spawn** + 删 `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` 旁路。
- **PR-2（卡生命周期 + R9）**：`founder_ship_card` 耐久卡状态机（attempt 化）+ USE-time 卡授权前置 + stale 点击回应（无硬窗）+ 通道中断契约 + 文字批准指卡。

**交付边界（一字说死，不过度声称）**：
- **R1 = execution 域全量**：at-most-one-live 卡、状态机、stale 回应、binding-active 不变量，键在 execution（+ attempt）。**run/generation/gate-epoch 级的 R1/R2 全量**（跨 retry execution 的唯一卡、run 级 obligation 汇聚 barrier、frozen subject）依赖 workflow_run 身份物化与 claims 读切换 = **FLY-1244 + 子单域，本单只交 §5 契约级设计与 §4.5 接缝**。本单**不**声称 PRD §6 全部硬计数器闭合——闭合的是 execution 域内的四条（§6 硬计数器表）。
- **R2 = 止血版**：execution-local 的「code PR 无 QA 证据 → 卡不发」evidence gate。它机械封死 2026-07-14 事故形状（最小验收），但**不是** PRD R2 的 run 级 readiness barrier——那个的判据（同 generation 全 required obligation + 无 active hold + subject 冻结）在 §5.4 写成契约留给子单。

**红线**：
- **最小验收（issue 原文）**：flag 批事故形状（code PR、no-three-stage、`qa_required=0`、零 record）在 PR-1 后机械不可能开出 approve 卡——验收 E1。
- 有意行为改变的精确边界：(a) main 单段 code-PR run 无 QA 证据（或 PR/head 身份不明）→ founder 面全 hold；(b) `HOLD_ALIGN=0` 旁路删除（生产未设 → 零变化）；(c) PR-2 后 founder text 批准语义按 PRD R9（有活卡 → 指卡不直写；无活卡 → 明说原因）。**其余旧路径字节兼容**：三段式相位、implement/design/qa 角色 hold、`onQaResult` 五重验证链逐字不动、merge 闸（不碰 `ship-eligibility.ts`）。
- fail-closed 方向恒为不可逆一侧：docs-only 判不出/分页不完整/PR 身份不明 → 当 code PR；DB/API 读异常 → catch → hold + Lead 可见错误（**绝不 throw 出谓词、绝不 fail-open**）；CAS 竞态 0 行 → 不发卡。
- 绝不消费 runner 自报：docs-only 只认 Bridge 对 (repo, PR, head) 的 GitHub API 计算；QA 证据生产者由 **server spawn** 建立，绝不接受 caller 指定的 executor id。
- FLY-1244 四个禁改文件零触碰（`ship-eligibility.ts` / `write-gate-response.ts` / `actions.ts` / `qa-result.ts`）；共享文件按 §8 symbol 级集成矩阵；越界先回 Lead。
- merge 即入库，生效等 Bridge 重启（攒批）；Runner 绝不自 merge / 自 :cool:。
- **吃自己的狗粮**：本单两个 PR 的 ship 必须过本单闸语义（至少人肉版）——code PR ⇒ 有独立 QA 证据才请 founder 批。

## 1. 总验收

1. §6 验收矩阵 E1-E14 全绿；行为改变边界外字节兼容有测试锚（E12）。
2. **execution 域硬安全计数器恒 0**（测试断言 + 生产可查 SQL 落 doc）：①同 execution live 卡 >1；②active-无-binding-匹配 卡；③stale ✅ 写入的 approval；④已 retire 卡上的未回应 ✅（无时间窗——观测义务见 §4.4）。
3. 一次真机 E2E（§7）证据先于 gate 呈报。
4. 全仓 lint + 全测试绿；Codex code review APPROVED。

## 2. 架构决策定稿

| # | 决策 | 落地 |
|---|---|---|
| 1 | hold 谓词是唯一杠杆点 | 四个 founder 面（GatePoller relay `gate-poller.ts:706` / event-route always-deliver / HeartbeatService / DirectEventSink）共同消费 `reviewHoldReason`——新原因加在这一个函数里，四面同步收口 |
| 2 | 新 hold 原因 = **main-only** | 三段式 approve gate 由 qa role 持有（`isReviewableRole` 对 qa 返 null）；implement 行为不变——最小爆炸半径 |
| 3 | 运维开关与 ship 豁免语义分离（拍板 ③） | auto-qa-policy 及 `qa_required` 写入路径**原样保留**（仍控自动 spawn + merge 闸过渡期）；发卡面不再消费 `qa_required=0` 为豁免 |
| 4 | docs-only = 异步计算 + 持久 snapshot，谓词只读 | 谓词是同步纯读；判定由 Bridge 异步算落表；行缺失/键不匹配 = hold（fail-closed），补算后自动放行 |
| 5 | QA 证据 = 复用 `auto_qa_record` 全链；**生产者由 server spawn 建立**（R1#5） | manual 路 = server-owned QA dispatch（复用 coordinator spawn 机制），绝不 enroll caller 指定的 executor；`onQaResult` 五重链**零改动** |
| 6 | 卡状态机 = 新表 + attempt 化 + 部分唯一索引 | at-most-one-live per execution 由 DB schema 强制；重试 = 新 attempt 行（R1#2）；转移一律 CAS |
| 7 | Discord 消息动作 best-effort，安全由 DB 态保证 | retire 时 edit 置灰优先于 delete（保审计）；**edit 成功只切换观测频率层——观测义务解除的唯一条件 = 消息验证不存在（404 → message_gone）**（§4.4，R2#3） |
| 8 | **active 卡 = USE-time 授权前置**（R1#3/R3#3） | 每条 founder 批准入口在写入前核「存在 active 卡 ∧ 点击/绑定目标 == 该卡 message_id ∧ 无未清除 rejected-reaction tombstone（§4.3b）」；收口点 = `writeFounderApproval`——**§4.3 blocked 于「1244 seam 后续 commit」钉 hash**（commit A `35a04f510` 已落但无 seam，§4 头四项清单） |
| 9 | 新 hold 原因**非 deferrable**（R1#3） | `qa_evidence_missing` / `qa_evidence_unknown` 加入 FLY-1099 deferred-approval 分类的 **NEVER-deferrable** 侧：pre-readiness 的 founder 批准绝不 park-后-自动生效（主通道 A：授权动作 = 点 post-readiness 的活卡）；拒时回明确文案 |

## 3. PR-1（止血）

### 3.1 docs-only 判定服务（R1#6 全契约化）

**新文件** `packages/teamlead/src/bridge/ship-relevant-diff.ts`；**StateStore 加性迁移块**：

```sql
CREATE TABLE IF NOT EXISTS ship_relevant_diff_snapshot (
  execution_id TEXT NOT NULL,
  pr_head_sha TEXT NOT NULL,
  repo TEXT NOT NULL,                    -- "owner/name"，server 侧解析
  pr_number INTEGER NOT NULL,
  base_ref TEXT NOT NULL,
  base_oid TEXT NOT NULL,                -- PR base.sha（异步失效检测键，R2#4/R3#5）
  classifier_version INTEGER NOT NULL,   -- 常量 SHIP_RELEVANT_CLASSIFIER_VERSION (=1)
  ship_relevant INTEGER NOT NULL CHECK (ship_relevant IN (0,1)),
  file_count INTEGER NOT NULL,
  sample_paths TEXT,                     -- 前 N 条非豁免路径（诊断，非权威）
  computed_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, pr_head_sha)
);
```

- **repo 身份**：从 Bridge 的项目/仓配置（RepositoryConfig / 项目 canonical root 的 origin remote）server 侧解析，**绝不靠进程 cwd**；解析不出 → 不落 snapshot（= hold）。
- **API 契约（可执行）**：REST `GET /repos/{owner}/{repo}/pulls/{n}` 取 `head.sha`、`base.ref`、`base.sha`、`changed_files`；`head.sha != 请求 head` → 放弃本轮。再 `GET /repos/{owner}/{repo}/pulls/{n}/files?per_page=100&page=k` **循环到空页**，累计条数 **必须 == `changed_files`**（完整性检测）；不等/任何页失败/`changed_files > 50`（**豁免候选上限**——docs-only PR 天然小；超限直接判 `ship_relevant=1`，不做第二段验证）→ 前者不落 snapshot、后者落 1。经现有 gh 调用模式（`gh api`）执行。
- **分类第一段（路径，保守）**：对每个 file 条目：
  - `status ∈ {added, modified, removed}` → 判 `filename`；`status == renamed` → **`filename` 与 `previous_filename` 都必须**在 allowlist（封「代码 rename 进 docs 目录」逃逸）；
  - 其它 status / 缺字段 → 一律 ship-relevant；
  - **DOCS_ALLOWLIST（受信静态常量，变更走 review）**：目录前缀 `doc/`、`docs/`、`engineering/doc/`、`product/doc/`、`content/doc/`、`marketing/doc/`。**刻意排除**：根目录 `*.md`（CLAUDE.md / README / agents/*.md 是行为文件）、`.flywheel/`、`.claude/`、`.github/`。语义遵 PRD R4：默认一切 ship-relevant，豁免仅此 allowlist。
- **分类第二段（entry 类型 / mode = Git Trees API 权威，R2#4 + R3#2——contents API 不权威：无 mode、submodule 可报 `type:"file"`、symlink 可返回目标内容）**：仅当第一段全部路径豁免才进入。对**两侧**取权威 tree entry：
  - 待验路径集：added/modified/renamed-new 在 **head**；removed/modified/renamed-old(`previous_filename`) 在 **base.sha**（modified 双侧、removed 也验——封「删掉 docs 路径下的 gitlink/symlink」与「symlink→file / mode-only 变化」逃逸）；
  - 取法：`GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` 且 **`truncated == false` 必须成立**（truncated=true → 不落 snapshot），或对每个路径做逐级 targeted tree walk（≤50 文件成本可控，implement 期择一，语义同）；
  - 判定：每个待验 entry 必须 `type=='blob' ∧ mode=='100644'`；`100755`(可执行)/`120000`(symlink)/`160000`(gitlink)/`040000`/缺失 → **`ship_relevant=1`**（确定非纯文档）；tree 数据不可得/不完整 → **不落 snapshot**（fail-closed 重试）。
  - 全部通过 → `ship_relevant=0`；file 数为 0 → 不落 snapshot（异常）。
- **读侧校验**（谓词消费时，同步可得项）：行存在 且 `repo`/`pr_number` 与 session 一致 且 `classifier_version == 当前常量`——任一不符 → 视为缺失（hold）。
- **base 失效检测（异步侧，R2#4）**：表列含 `base_ref TEXT NOT NULL`、`base_oid TEXT NOT NULL`；GatePoller 的异步触发路径每次对既有 snapshot 行核当前 PR 的 `base.ref`/`base.sha`——不匹配（PR retarget / base 前进 → files 三点 diff 已变）→ **删除该行**（谓词随即回到 hold）并触发重算。谓词自身保持同步纯读、零网络。
- **触发点**（幂等，行已存在且校验过即跳过）：①`AutoQaCoordinator.onMainAwaitingReview`；②GatePoller tick 对 awaiting_review main session 缺有效 snapshot → 异步触发；③rebind 成功后对新 head 触发。in-flight 去重 + 每 (exec,head) 60s 退避。

### 3.2 hold 谓词扩展（核心止血；R1#4 fail-closed 补洞）

改 `packages/teamlead/src/bridge/auto-qa-held.ts`：

- `ReviewHoldReason` 加两枚举：`"qa_evidence_missing"`（证据缺失）与 `"qa_evidence_unknown"`（PR/head 身份或判定不可得）。**两者都非 deferrable**（§2-9；FLY-1099 分类表归 merge_block 一侧）。
- `reviewHoldReason` 逻辑（在现有 merge_block → role/status → head 检查 → codex → qa_not_green 之后追加；仅 `session_role==='main' ∧ status==='awaiting_review'`）：

```
1. pr_number == null → hold 'qa_evidence_unknown'
   （一个开着 approve_to_ship gate 的 main session 无 PR 身份 = 半失败，绝不当 no-code；
    no_code/pr_handoff 路由的 session 根本不开 approve gate，不经此谓词发卡）
2. pr_head_sha 缺失/非 40-hex → hold 'qa_evidence_unknown'
   （现状该分支在 codex gate off / codex_skip 时返回 null = fail-open —— 本行为改变把它闭掉）
3. evidence = getAutoQaRecord(execution_id, pr_head_sha)?.status === 'passed'
   （record 存在但未 passed → 现有 qa_not_green 分支已先返回，不重复处理）
4. 无 record：
   snapshot 缺失/校验不符        → hold 'qa_evidence_missing'（fail-closed，补算后自动放行）
   snapshot.ship_relevant = 1    → hold 'qa_evidence_missing'
   snapshot.ship_relevant = 0    → 不 hold（唯一合法豁免：docs-only）
```

- **单一 fail-closed 异常边界（R2#5 + R3#5 按角色）**：`reviewHoldReason` 的**全部 store 读**（`isCodexGateSatisfied` 的 codex record 读、`getAutoQaRecord`、`getShipRelevantDiffSnapshot`）包进一个函数级 try——任何读 throw：**`session_role==='main'` → 返回 `'qa_evidence_unknown'`**（fail-closed hold，有意的行为改变）+ 去重的 out-of-band 诊断（Lead 可见）；**非 main（implement 等）→ rethrow 保持现状**（main-only scope 纪律，E12 字节锚不破）。逐个 store 方法各写一格 throw 测试（E4）。reason 优先序不变（try 内逻辑顺序即优先序）。

- **`qa_required` 不再被发卡面消费**（拍板 ③）：上述逻辑对 `qa_required=0` 一样生效。`qa_required` 列与 auto-qa-policy 写入路径原样保留（merge 闸过渡期仍读，§5.3）。
- store 接口：`QaHeldSession` 类型加 `pr_number`；`AutoQaHeldStore` 加 `getShipRelevantDiffSnapshot`。四个消费面逐一核 session 行含 `pr_number` 列（缺则补 SELECT），谓词内部扩展、调用面签名不变。
- **Lead 可见性**：GatePoller 对 held approve gate 加一次性（per execution+head+reason，durable marker）Lead 通知：hold 原因 + 补证据路（manual-spawn API / 等 snapshot 重算）。复用 lead-alert 基建，绝不进 founder 面。

### 3.3 manual-QA = server-owned spawn，经 coordinator 公开 admission（R1#5 + R2#6）

**Bridge API** `POST /api/qa/manual-spawn`（loopback + same-origin + confirmToken——这是 CSRF 防护非身份边界；该动作的安全性来自其语义：**它只能「让一个 server 起的真 QA 去跑」，不能铸造任何 PASS**。冒用者最多触发一次真验证 = 无收益）：

- body：`{ executionId, prHeadSha }`（都必填；`prHeadSha` 必须 == parent 当前 head，不等 → 400）。**不接受任何 executor/qaExecutionId 参数**——证据生产者身份由 server 建立。
- **新公开 coordinator 方法 `AutoQaCoordinator.manualSpawnQa(parentExecutionId, prHeadSha)`（R2#6——不直调私有 spawn）**，路由只做参数形状校验后委托。方法内：
  1. 重读 parent（`session_role='main'`、`status='awaiting_review'`、`pr_number != null`、head 相等——全 fail-closed）；
  2. **复用 `onMainAwaitingReview` 的既有 admission 门**（issue 级「一个活 QA」竞态守卫 / foreign-parent ownership 检查 / claim 原子性）——抽为两路共享的私有 admission 步骤，不复制逻辑；
  3. 原子 claim `auto_qa_record(status='running', enrollment_source='manual')` → spawn QA runner（role='qa'）→ 同步回填 `qa_execution_id`；claim 输给并发 auto-spawn → **幂等返回既有 record 状态**（不是错误）；
  4. `session_event` 审计行。
- 新列 `enrollment_source TEXT NOT NULL DEFAULT 'auto' CHECK (enrollment_source IN ('auto','manual'))` 只作审计标记。
- **同 head stuck/failed 的有界 re-drive（R2#6——否则 409 forever，逃生口名不副实）**：既有 record `status ∈ {stuck, failed}`（终态且非 passed）**且其 `qa_execution_id` 的 session 已确认死**（session 缺失或终态）→ 允许 manual-spawn 对**同一行**做 CAS 复活：`UPDATE … SET status='running', qa_execution_id=NULL, enrollment_source='manual' WHERE parent_execution_id=? AND target_pr_head_sha=? AND status IN ('stuck','failed')`（0 行 = 竞态放弃）→ 重新 spawn 回填。**绝不**对 `running`/`awaiting_retest`（活 runner）或 `passed`（已有证据）re-drive——这三态 409 幂等返回。
- **verdict 链零改动**：spawn 出来的就是标准 QA session（role='qa'、record 绑定 server 写）→ `onQaResult` 五重验证逐字复用，PASS/FAIL 生命周期（close/park/retest）天然适用。**不放宽 `onQaResult` 第 1 步**。
- 并发测试（§3.5-⑦ 扩展）：auto-vs-manual 同时 claim / 同 issue 两个 parent execution / claim 后 crash（重启后幂等收敛）/ stuck 恢复正负（活 runner 拒、死 runner 复活）。

### 3.4 删 `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` 旁路（R8 余量）

`founderApprovalHoldGuard`（`auto-qa-held.ts:134-141`）删 env 短路 → 纯 `isReviewHeld`。全仓引用（测试/env 注册）清理；生产未设已核 → 零变化。响亮版紧急动作不在本单（未来 = founder 授权显式动作，接 1244 writeFounderApproval 域）。

### 3.5 PR-1 步骤序（TDD）

RED：①**事故重放 E1**（main、awaiting_review、pr_number 有、`qa_required=0`、零 record、snapshot.ship_relevant=1、**codex gate 已满足**（否则先返回 codex_pending——arrange skip 或 approved record）→ `'qa_evidence_missing'`；同 fixture 在旧谓词返回 null 的 RED 证明）②pr_number null → `'qa_evidence_unknown'` ③head 缺失 + codex gate off / codex_skip 两组 → `'qa_evidence_unknown'`（旧行为 null 的 RED 证明）④**逐 store 方法 throw 各一格**（codex record 读 / getAutoQaRecord / getShipRelevantDiffSnapshot）→ `'qa_evidence_unknown'` + 去重诊断 ⑤docs-only 豁免正测（含第二段 Git-tree 验证全过）⑥分类器矩阵：code→docs rename / docs→docs rename / removed-side symlink·gitlink / **100644↔100755 mode 变** / symlink→file / **tree 不可得或 truncated** / 缺 previous_filename / >100 文件分页 / 计数不符 / >50 文件直接 ship_relevant=1 / head 漂移放弃 / repo 不匹配 / **base_oid 变更删行重算** / classifier_version 变更重算 ⑦manual-spawn：校验矩阵 + 409 幂等 + **API schema 拒 executor 参数** + auto-vs-manual 并发 claim + 同 issue 两 parent + claim 后 crash + **stuck/failed 死 runner 复活正测、活 runner/passed 拒 re-drive 负测** ⑧spawn 出的 QA PASS→record passed→hold 解除（全链）⑨HOLD_ALIGN 删除后 guard===isReviewHeld ⑩byte-compat 锚：qa_required=1 现有链 / implement·design·qa 角色 / 三段式相位。
GREEN：表迁移 + `ship-relevant-diff.ts` + 谓词扩展 + manual-spawn 路由 + coordinator 触发点。
REFACTOR：FLY-1099 分类表（新原因入 NEVER-deferrable 侧）+ Lead 通知文案。

## 4. PR-2（卡生命周期 + R9）

> **硬前置（R2#2 + R3#3 精确化）**：授权收口的唯一写入原语 `writeFounderApproval` 住在 `write-gate-response.ts` = 本单禁改文件。**FLY-1244 commit A 已落（`35a04f510`，其分支上）但它没有本单需要的 seam**：无 authority hook、无 route-source 形参、`holdReasonFor` 类型只认 `codex_pending|qa_not_green|merge_block`、disposition 只 reject `merge_block` 其余全 defer——直接注入会 (a) TS 类型不匹配 (b) 把两个 NEVER-deferrable 新原因误归 deferrable。**⇒ PR-2 授权部分（§4.3）的 merge 前提 = 一个尚不存在的「1244 seam 后续 commit」**，其交付清单（向 1244 提出，经 Tadashi 对齐——两单同 Lead）：
> ① 六路 route-source enum 贯穿全部 caller（reaction/text/voice/deferred/actions/founder-consent）传入共享 writer；② 可注入 pre-write authority hook（deps 形参 `cardAuthority?: (input: {executionId, source, targetMessageId?}) => {ok:true} | {ok:false, reason:string}`），缺省注入时 1244 行为零变化；③ hold-reason 形参类型放宽到 `ReviewHoldReason` 全集（含本单两个新原因）；④ disposition 映射消费 NEVER-deferrable 分类器（`qa_evidence_missing|unknown` → reject 非 defer）。
> **落地后把该 commit hash 钉进本 plan 再开工 §4.3**；在那之前 **§4.3 = blocked**（不是「前置已满足」）。PR-1 与 PR-2 的非授权机械（§4.1/§4.2/§4.4/§4.5）不依赖 seam，照常实现与测试。跨分支 compile/integration fixture 一格：六路全部到达 hook + 两个新原因 reject 非 defer。若 1244 拒绝该 seam → **停，回 Lead 重划文件边界**，不自行改禁改文件。

### 4.1 `founder_ship_card` 表（attempt 化，R1#2）

```sql
CREATE TABLE IF NOT EXISTS founder_ship_card (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  pr_head_sha TEXT NOT NULL,
  attempt INTEGER NOT NULL,              -- 同 (question, head) 的第 N 次物理发卡
  post_nonce TEXT NOT NULL UNIQUE,       -- 卡 footer 嵌入；crash 后从 thread 找回消息
  thread_id TEXT NOT NULL,
  message_id TEXT,                       -- Discord 发出后回填
  state TEXT NOT NULL DEFAULT 'posting'
    CHECK (state IN ('posting','active','retiring','retired')),
  created_at TEXT NOT NULL, activated_at TEXT, retired_at TEXT,
  retire_reason TEXT,                    -- head_drift|superseded|channel_down|gate_answered|post_failed|binding_missing|reconcile_orphan|message_gone|channel_config_drift|boot_reconcile_unresolved
  grey_edit_done INTEGER NOT NULL DEFAULT 0,   -- 置灰 edit 已确认成功（只切扫描频率层，不解除观测义务，§4.4）
  message_gone INTEGER NOT NULL DEFAULT 0,     -- 消息验证不存在（404）= 观测义务解除的唯一条件（§4.4）
  last_reaction_scan_at TEXT,            -- durable 扫描游标（§4.4 双频公平轮转）
  channel_key TEXT NOT NULL,             -- 创建时 server 冻结的授权 lane（§4.5，R7#2/R8#3）
  UNIQUE (question_id, pr_head_sha, attempt)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ship_card_live
  ON founder_ship_card(execution_id) WHERE state IN ('posting','active');
```

- 重试 = **新 attempt 行**（retired 保持终态，不复活——R1#2 的「retired 终态 vs 重发冲突」由 attempt 维度解决）。
- at-most-one-live per execution = 部分唯一索引（posting 计入占位，封并发 double-post）。
- 状态转移只经 CAS 方法 `transitionShipCard(id, from, to, fields)`（0 行 → false → 调用侧 fail-closed）；无第二条 UPDATE 路径。

### 4.2 发卡流程改造（`gate-poller.ts` `maybeEmitFounderThreadFallback` approve_to_ship 分支）

顺序（括号 = 该步失败/崩溃的处置）：

0. **发卡前置（R11#2——否则 durably-unhealthy lane 会陷入 post→激活失败→retire→再 post 的每 tick 刷卡循环）**：INSERT/POST 之前先查同一组谓词——server-resolved lane config 比对（drift → 不发）∧ boot-local poison 未命中 ∧ durable health 谓词成立（unknown lane → 带退避 probe，本 tick 不发；unhealthy/poisoned → 不建 attempt 不发消息）。step 5 的 just-in-time 复核保留（封 preflight 与激活之间的竞态窗）。测试：boot_reconcile_unresolved 后反复 tick 零新行/零 POST；verified 同 lane 恢复持久化后恰一张正常 attempt。
1. `INSERT posting 行`（attempt = 该 (qid,head) 现有 max+1；live 索引冲突 → 已有 live 卡 → 不发）。
2. post Discord，卡文案 footer 带 `post_nonce`。**POST 结果分类（R3#1/R4#1——Discord 可能已收下消息而客户端丢了响应）**：
   - **definitive 失败**（发送前配置/客户端错、明确 4xx 拒绝）→ CAS posting→retired(post_failed)，下 tick 新 attempt；
   - **ambiguous 结果**（timeout / 连接断 / 5xx / 响应成功但 body 解析不出 message id）→ **保持 `posting+NULL`**，进 §4.2b 完整 nonce 扫描路径（found → 回填继续；完整扫描确认 absent → 才 retire）。
3. 持久化 `message_id`（crash 窗口 2→3：§4.2b）。
4. **binding 落定**：写 (questionId, prHeadSha) 的 gate-message binding 指向本卡 message_id。binding store 现状 per (qid,head) write-once——**attempt 重发时旧 binding 指旧消息** → 扩展 binding store：per (qid, head) 允许 supersede-write（新行替换语义或 (qid,head,attempt) 键），**读侧权威改为「从 active 卡行取 message_id」**（§4.3），binding 行降级为兼容镜像。binding 写失败 → CAS posting→retiring(binding_missing) → 走 retiring 收敛（消息存在，保持可观测），下 tick 新 attempt。
5. **激活前置复核（just-in-time）**：通道健康（§4.5 谓词）∧ gate 仍 pending ∧ head 未变——任一不成立 → 不激活（走对应 retire 原因）。
6. CAS posting→active（activated_at）。**不变量：state='active' ⇒ message_id 非空 ∧ binding 指向它 ∧ 激活时通道健康**（E5）。
7. **notify marker（R1#2——在 CAS active 成功之后才写）**：per (qid, head, attempt) durable marker（语义 = 「该 attempt 已完成激活」，不再压制重试；现状 per-question marker 在 post 前写、失败也留的行为废除）。旧 per-qid marker 保留只读兼容（存量 gate 不重发）。crash 于 6→7 之间 → 重启 reconcile 见 active 行补 marker（幂等）。

**4.2b 每个非终态的收敛转移（R2#1——重启 reconcile + 周期 tick 都跑，全部幂等）**：
- **`posting` 且 message_id == NULL**（crash 于 POST 前后）：按 `post_nonce` 扫 thread——**必须是完整扫描**：按消息时间分页回溯到 `created_at` 之前为止；**途中任何 fetch 失败/分页不完整 → 本轮放弃、行保持 posting、下 tick 重试**（连续失败 ≥3 → 升级通道不健康 §4.5），**绝不在不完整扫描上 orphan-retire**。完整扫描找到 → 回填 message_id 进入下一态；完整扫描确认缺失 → CAS posting→retired(reconcile_orphan)（POST 确实没成功，无可点面）。posting 滞留期间 live 索引挡新卡 = **有意的 fail-closed**（旧卡存在性未定时绝不叠卡）。
- **`posting` 且 message_id != NULL**（crash 于 ID 后-binding 前 / binding 后-active 前）：重读 binding——缺/不指向本 message_id → 补写（supersede）；写成功 → 经**唯一激活原语 `tryActivatePostingCard`**（R5#1，见下）；补写持续失败 → CAS posting→retiring(binding_missing)（消息存在 → 走 retiring 收敛，保持可观测）。
- **`tryActivatePostingCard`（唯一 posting→active 转移原语，live-send 与全部 reconcile 路径共用——R5#1，不存在第二条更弱的激活路）**：在 binding 确认后、CAS 前**原地重读全部 §4.2 第 5 步前置**（通道健康 ∧ gate 仍 pending ∧ head 未变）→ 全过才 CAS posting→active；任一失败 → 按对应原因 retire（channel_down / gate_answered / head_drift）——身份未定（message_id NULL）的行不经此原语（它们只走 nonce 扫描）。restart 测试：posting+ID 与 posting+ID+binding 各 × 每个前置失败一格 + 并发 channel-down 竞态。
- **`retiring`**（crash 于 edit/终 CAS 前）：每 tick 重试 edit 置灰 → 无论 edit 成败最终 CAS retiring→retired（edit 成功另记 `grey_edit_done=1`）。**retiring 与 retired 一样进 §4.4 观测集**——不存在「不被扫的中间态」。
- **`active` 对账**：gate 已 retire/回答而卡仍 active → 走 §4.2c retire 链。
- E7 测试 = 从**每个持久化子状态**重启：posting 无 ID（找到/确认缺失/扫描不完整三支）、posting+ID、posting+ID+binding、retiring、active-孤儿。

**4.2c retire 接线**（先 retire 老、再 post 新——PRD R1）：
- `retireShipGate` 三个调用面（`event-route.ts:1167` / `:1289` / gate-poller backstop `:1990`）：同步 CAS live 卡 → retiring(head_drift|superseded) → best-effort Discord edit 置灰（「此卡已过期」+ 新卡跳转若已知）→ **edit 成功 → `grey_edit_done=1`** → CAS retiring→retired。
- rebind 路径（`ensureRebindAnchor`）：发 rebind 卡前先 retire 旧 live 卡，新卡走 §4.2 全流程（修掉现状「rebind 多发一张、旧卡永存」）。
- gate 被回答 → retire(gate_answered)（edit 为「已批 ✅」/「已回应」）。

### 4.3 active 卡 = USE-time 授权前置 + 六路授权矩阵（R1#3 + R2#2）

- **`assertActiveCardAuthority(input: {executionId, source, targetMessageId?}) → {ok:true} | {ok:false, reason}`**（纯读），经 §4 seam 契约注入 `writeFounderApproval` = **每条 approval 写入的统一前置**（commit A `35a04f510` 已把 actions/founder-consent 改道经共享 writer → hook 装在 writer 内 = 六路全覆盖，无「过渡期非-card-aware 旁路」；hook 本身待 seam 后续 commit）。检查项 = 存在 active 卡 ∧ **卡 `message_gone=0`（R9#2——同 lane 别的 200 不能救活一张消息已删的卡）** ∧（reaction）目标 == 卡 message_id ∧ 无 blocked quarantine（§4.3b）∧ 无 boot-local poison（R9#3）∧ **当前 durable 通道健康谓词成立**（R5#3——channel-down 的异步 sweep retire 与 USE-time 检查之间有窗口：health flip 后、sweep tick 前，actions/founder-consent 不得凭「卡还 active」过闸；不健康 → typed 非授权结果）。任何入口在检查不过时**绝不写 approval**，返回 typed、founder 可见的 reason。测试：激活后 health flip、sweep 未跑 → 全部写入路由拒（E13）。
- **六路矩阵（source-discriminated，逐路 mutation 测试）**：

| source | 通过条件 | 不通过时的行为 |
|---|---|---|
| `reaction` | 存在 active 卡 ∧ `targetMessageId === 卡.message_id`（精确点名） | 不写；交 §4.4 stale 回应 |
| `text` | **永不直写（PRD R9 / 主通道 A）** | 有 active 卡 → 回「请点这张卡的 ✅：<jump link>」；无 → 回「批准暂不可用：<原因>」 |
| `voice` | 同 text | 同 text |
| `deferred replay` | **approval 类 replay 一律拒**（park-then-auto-apply = 主通道 A 禁路；replay 无 message target） | 拒 + 通知 founder「条件已满足，请点活卡」（转通知不转授权） |
| `actions`（dashboard/API） | 携带独立核验的 founder authority（1244 consent/attribution 链）∧ 存在 active 卡 | typed 拒因（该路无 message target——active 卡存在性即其卡检查） |
| `founder-consent`（enforce 路由） | 同 actions | 同 actions |

- 新 hold 原因非 deferrable（§2-9）保证不再**新增** parked approval；**存量** parked approval 在升级后 replay 时被上表 `deferred replay` 行拒 + 转通知——两侧闭合。既有 codex_pending/qa_not_green 的 defer **入口**语义不动（scope 纪律），但其 replay 出口已被收口——诚实说明：这实质上把 deferred-approval 机制降级为 deferred-notification，是 PRD R1/主通道 A 的直接推论，实施期在 PR 描述里醒目标注。
- reaction 路径实现：`tryFounderReactionApproval` 的授权目标从「binding 选出的 message」升级为「active 卡的 message_id」（binding 降级为镜像/对账）；非 active 目标 → 不写 + §4.4 回应。
- **active-held 卡的点击（R3#4——PRD late-hold 对抗例）**：现状 reaction handler 的 `isHeld` 前置是**静默短路**（audit + return null，hook 根本不跑，founder 零回应）。改：held 短路替换为 **typed blocked-response 路径**——不写 approval + founder thread 回一条 hold 原因（「QA 未绿 / 审查未过 / 证据缺失…」）+ 幂等 marker（per message-id + reason）。**语义定稿：late hold 下卡保持 active-but-blocked**（不 retire——hold 自清除后同一张卡继续有效，免重发）；active 卡的 reaction 每 tick 照常被 poll，held 时走回应不走授权。E13 增五格：active 卡 × {codex_pending, qa_not_green, qa_evidence_missing, qa_evidence_unknown, store 读异常} 点击 → 零写入 + 可见回应。
- **R9/authority 闭合声明纪律（R2#2）**：在 seam commit + 六路测试全部落地并绿之前，不在任何文档/PR 描述声称「R9 全量」或「execution 域 authority 闭合」。

### 4.3b rejected-reaction 消费协议（R4#3——被拒的 ✅ 绝不许滞留后自动生效）

Discord reaction 是**持久状态**：posting 期 / active-held 期被回「未生效/被扣住」的 ✅ 仍留在消息上——若不处理，卡转 active / hold 自清除后，普通 reaction poll 会把**同一个旧 ✅** 当成批准写入 = 换了存储介质的 park-then-auto-apply，直接违反主通道 A 与刚发出的「未被接受」回应。

- **durable schema（R5#2——可执行）**：

```sql
CREATE TABLE IF NOT EXISTS ship_card_reaction_quarantine (
  card_attempt_id INTEGER NOT NULL REFERENCES founder_ship_card(id),
  founder_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  episode_version INTEGER NOT NULL DEFAULT 1,   -- R6#1: 同卡可多次 blocked episode,可重臂
  state TEXT NOT NULL DEFAULT 'blocked' CHECK (state IN ('blocked','absent_seen','cleared')),
  blocked_reason TEXT NOT NULL,          -- 本 episode 建立时的 hold/state 原因
  blocked_at TEXT NOT NULL, absent_seen_at TEXT, cleared_at TEXT,
  PRIMARY KEY (card_attempt_id, founder_id, emoji)   -- 一行,episode 经 version 递进
);
```

  状态机**单调 per episode、行可重臂（R6#1）**：episode 内 `blocked → absent_seen → cleared`（CAS `WHERE state=:from AND episode_version=:v`）。**授权要求 = present 观测清除了当前 episode（cleared 且 version 匹配当次观测）∧ writer 现有 live hold recheck 过**。
  **`ensureReactionBlocked`（唯一的 blocked 观测入口，收敛式——R7#1：0 行竞态绝不「放弃当成功」）**：循环（有界，如 5 次）——read 行 → 不存在 → INSERT(blocked, v=1)；已 blocked → 成功返回；`absent_seen|cleared` → CAS 重臂 `→ blocked, v+1, 重置时间戳`；CAS 0 行（并发赢家改了行）→ **re-read 重试**（赢家可能是 clear——必须重臂到 blocked 才算完）。**只有观察到当前行 = blocked 才允许继续**（移除/回应）；重试耗尽 / store 错误 / 不可分类 → **非授权侧收场：retire/block 本卡 + Lead 告警，绝不当成功继续**。absent/clear 侧 CAS 同样 re-read 纪律（0 行 → re-read 判断赢家，绝不臆断）。竞态测试：clear-vs-re-arm、两个并发 re-armer、cleared-未写入-新 hold（全部收敛到 blocked 或非授权收场）。
- **crash 顺序（normative，R5#2 + R7#1）**：blocked 观测的处理序 = ①**`ensureReactionBlocked` 收敛到「当前行 = blocked」并 commit**（不是裸 INSERT-or-no-op——既有 absent_seen/cleared 行必须重臂成功才算 durable quarantine）→ ②best-effort 移除 reaction + 读回验证（absent 验证成功 → CAS blocked→absent_seen）→ ③founder 可见回应 + 回应 marker。crash 于任一步之间：quarantine 已在 → 授权被挡（安全侧）；回应 marker 缺 → 下 tick 补回应（幂等）。**绝不先回应后落 quarantine**。
- **授权前置消费**：active 卡的正常授权路径（§4.3 reaction 行）在写 approval 前必须核：该 (card_attempt, founder, emoji) **无 state='blocked' 的 quarantine**。清除路径按优先级：
  1. **移除 + 验证**（②）：读回 absent → CAS blocked→absent_seen；此后扫描观测到 present（= 新点击）→ CAS absent_seen→cleared，授权可走；
  2. 移除不可行/失败 → 行保持 blocked，扫描继续找 **absent→present 边**（某轮读到 absent → CAS blocked→absent_seen；后续读到 present → cleared）；
  3. 边无法证明（持续读故障 / blocked 滞留超阈值）→ **retire 本 attempt + 新 attempt 发新卡**（新消息零 reaction = 干净重置），绝不在存疑 reaction 上授权。
- 对抗测试（E13 扩展 + restart 每边界一格：quarantine 插入前/后、移除成功-读回前、absent_seen 后-cleared 前、retire+repost 前）：posting 点击 → 激活后原 ✅ 在场 → **零写入**；held 点击 → hold 清除后原 ✅ 在场 → **零写入**；release 后验证过的重新点击（absent_seen→present，version 匹配）→ 写入；**移除失败 + 边不可证 → retire 旧 attempt + 发干净新卡 + 零写入**（R5#4）；**hold 期移除后 founder 重加（re-arm 到 blocked v+1，hold 清除后旧 ✅ 仍零写入）**；**同一卡两轮 late-hold 循环**；**cleared 后 crash-未写入-新 hold 出现 → 重臂**（R6#1）。

### 4.4 stale 点击回应（R9，无硬窗，R1#7 + R2#3）

- **观测义务与解除条件（R2#3——grey edit 不解除：置灰后的消息仍可加/切 ✅）**：一张 retiring/retired 卡只要其 Discord 消息仍存在，就仍是可点面 → **观测义务解除的唯一条件 = 消息被验证不存在**（reaction/消息读回 404 = 已删；列 `message_gone INTEGER DEFAULT 0`）。`grey_edit_done=1` **只切换扫描频率层，不解除义务**。
- **双频扫描（durable cursor 公平轮转，两层各自不饿死；观测资格与 edit 资格分离——R4#2）**：每 tick 取「高频层 = `(state IN ('retiring','retired') ∨ (state='posting' ∧ message_id IS NOT NULL)) ∧ grey_edit_done=0 ∧ message_gone=0` 最旧游标 N 条（N=20）——**posting+ID 也是可点面**（R3#1）：其上的 ✅ 得到「稍候，卡尚未生效」回应 + **写 §4.3b rejected-reaction tombstone**、绝不授权」+「低频层 = `state IN ('retiring','retired') ∧ grey_edit_done=1 ∧ message_gone=0` 最旧游标 M 条（M=10）」→ `evaluateReactionSource` → 新 ✅ 且无回应 marker → 回 thread「这张批准卡已过期（原因）」+ active 卡跳转或「当前没有待批的卡（原因）」→ durable marker（per message-id + emoji 事件计数上限）→ 更新 `last_reaction_scan_at`。**置灰 edit 只对 `retiring|retired` 执行**（posting 行绝不被 edit——防扫描与 §4.2b 激活竞态把一张已置灰的消息 CAS 成 active，R4#2；成功 → grey_edit_done=1 转低频层）。重启安全（游标在行上）；两层轮转公平（E10 断言含低频层）。
- **reaction 读失败建模（≠ 无 reaction）**：一律按 §4.5b 封闭结果表处置（404 → `message_gone=1` 义务解除；401/403/5xx/malformed/网络 → 计入 lane health；429 → 退避不计）；卡保留在扫描集。
- **绝不因 stale ✅ 写 approval**（§4.3 前置已封；扫描路径本身无 approval 写路径）。
- **成本上界**：每 tick ≤ N+M 次 reaction 读；长期存量由 grey-edit 高转化（正常路径 retire 即 edit 成功）+ message_gone 收敛控制；若产品未来选择「retire 即 delete 消息」可把义务收敛到零——那是 PRD 层 UX 决策，本单按 edit-保留-审计实现并把 delete 列为可选运维动作（不默认）。

### 4.5 通道中断契约（R9）

- 通道健康 = reaction 摄取可用：`FLYWHEEL_FOUNDER_AUTO_APPROVE!=0 ∧ FLYWHEEL_FOUNDER_REPLY_DELIVER!=0 ∧ canonical founder id 可解析 ∧ 项目不在 denylist`（从 `founder-reaction-approval-handler` 现有 gating 抽共享谓词——这四项 live-env/config 同步可读，无需持久化）**∧ durable 故障 latch 非 unhealthy**（R6#2）。
- **durable 故障 latch（R6#2——in-memory episode 过不了 Bridge 重启，而 active 卡过得了）**：

```sql
CREATE TABLE IF NOT EXISTS approval_channel_health (
  channel_key TEXT PRIMARY KEY,          -- R7#2: 精确授权 lane = project + Lead 身份 + Discord 频道/thread id +
                                         --       非机密 bot 身份（bot application/user id）；绝不含/哈希 token。
                                         --       GatePoller 同项目多 Lead 各自独立 lane——B lane 的成功绝不许复位 A lane。
  state TEXT NOT NULL DEFAULT 'healthy' CHECK (state IN ('healthy','unhealthy')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_probe_boot_id TEXT,               -- R8#1: 健康信任按 boot 作用域（谓词要求 == 当前 boot id）
  reason TEXT, updated_at TEXT NOT NULL
);
```

  `founder_ship_card` 相应加 **`channel_key TEXT NOT NULL`（创建时 server 冻结）**——activation / authority / observation / recovery 全部用**卡上冻结的 key**，config 漂移（Lead 换频道/换 bot）后各方仍指同一 lane，不会各自派生出不同键（R7#2）。
  **突变契约（R7#3——读、写、缺行三面全 fail-closed）**：失败计数**原子**累加（按 §4.5b 结果表），成功读清零；`consecutive_failures >= 3` → CAS latch `unhealthy`；**恢复的唯一路径 = 同 lane 一次成功的 reaction 读/probe 且成功持久化** → CAS unhealthy→healthy + 清零 + 记当前 boot id。**store 读失败 / 任何突变（累加、latch、恢复 CAS）失败或 0 行 → re-read 收敛，收敛不了 → 该 lane 按 unhealthy 处理（非授权）**。**行缺失 = unknown = 非授权** + 立即 probe。
  **boot 作用域信任（R8#1——「进程内当 unhealthy」过不了重启，旧 healthy 行不能被下个进程直接信任）**：健康谓词 = `state='healthy' ∧ last_probe_boot_id == 当前 Bridge boot id`——**每个进程启动时所有 lane 都是 unknown**，直到本 boot 的 same-lane probe 成功并持久化；上个进程写失败留下的过期 healthy 行因此天然失效。
  **启动 authority-reconciliation barrier（R8#1 + R9#1——具名 boot reconciler，per-card 终态封闭）**：Bridge boot 时、**在 `gatePoller.start()` 与 writer hook enable 之前 await reconciler drain**（producer 排他：barrier 开之前结构上不可能产生新卡——不是「扫描时的快照」而是「生产被暂停到对账完」）。每张持久 live 卡（posting+ID / active）有**四种封闭 disposition**（前三种 = reconciled 终态，第四种 = isolation）：
  (a) 一次 **200** reaction 读，其 health 结果与（若 ✅ present）所需 quarantine **都已 durable 持久化**；
  (b) **404 / channel_config_drift**，且该卡已 **durable retire**（404 走 R9#2 的 state-sensitive 处置）；
  (c) 其它原因的 durable terminal retire。
  **任何其它结果（401/403/429/5xx/malformed/网络）= unresolved：卡保持未对账、authority 保持 closed、有界重试**（按 §4.5b 计入 lane health）。**有界安全终态（R10#1——一条永远读不动的卡绝不许全局饿死 Bridge）**：重试到阈值（或该 lane 已 durably latch unhealthy 时立即）→ **纯 DB durable retire(reason=boot_reconcile_unresolved)**——不需要 Discord edit（消息留在 §4.4 观测集，通道恢复后照常被扫/回应）；retire 本身失败 → **第四种 disposition `isolated_for_boot`（R11#1）**：该卡 + 其 lane 进 boot-local poison，此 disposition **对全局 drain 算 closed**（不阻塞 startBridge 与其它 lane）但**永远非授权**（writer hook / activation / reaction / sweep 都查 poison）；下次重启新 boot id 强制对它再对账。四种 disposition（reconciled-200 / retired-404·drift / retired-其它 / isolated_for_boot）**封闭**——不存在第五种含糊态。**isolated_for_boot 的解除策略（显式）**：同 boot 内**可以**解除，但唯一路径 = 对该 card/lane 重跑完整对账（200 读 + durable health + 所需 quarantine 全部持久化成功）；否则保持 poison 到下次 boot 再对账。全部 live 卡到达四态之一才放行 approval 路由——**坏 lane 经有界终态或 isolation 收敛，不会阻塞好 lane 与 startBridge 生命周期**。启动测试：每类失败结果各一格 + 对账期间 card-creation 尝试被排他 + **多 lane：永久坏 lane 不授权但也不阻塞健康 lane 与 Bridge 启动**。
  **同 boot poison set（R9#3——boot-id 治跨进程，poison 治同进程内「durable 行还说 healthy 但突变没收敛」的窗口）**：boot-local（内存）poison 集合，键 = lane（health 增计/latch/恢复突变不收敛时）或 card attempt（quarantine 建立/兜底 retire 失败时）。**在返回任何「未持久化成功的非授权结果」之前必须先置 poison**；`tryActivatePostingCard` / `assertActiveCardAuthority` / reaction 路径 / sweep 全部先查 poison（命中 = 非授权）。清除唯一路径 = 同 lane/card 经 verified 读 + durable 写完成对账。测试：current-boot healthy 行 + 增计失败 + 第二次 actions 调用（拒）；quarantine 失败 / retire 失败后再次 reaction poll（拒）；**retire CAS/store 永久失败 → isolated_for_boot：健康 lane 与 startBridge 照常、坏 lane 全路由拒、无卡激活、重启再入对账**（R11#1）。
  **config drift（R8#2 + R10#2）**：每次 probe/读前比较**当前 server-resolved lane tuple** 与卡上冻结的 `channel_key`——不匹配 → typed `channel_config_drift` 非授权结果 → retire 旧卡；**repost 同 404 规则分离**（runtime 下 tick 发新 attempt；boot 上下文只 retire，drain 后由 pending-gate 扫描补发）；**health 结果只许写「实际发起该次请求的 credential/频道」精确描述的 key**（绝不把新 bot 的成功记到旧 key 上）；bot 身份解析失败 = unknown/unhealthy。
  三个消费点用**同一个**谓词：`tryActivatePostingCard`（§4.2b）、`assertActiveCardAuthority`（§4.3）、channel-down sweep（本节）。测试：重启于阈值下/上 + verified 恢复 + **同项目两 Lead（B 成功不复位 A）** + **重配 → channel_config_drift retire+repost（不是「key 不漂」而已）** + 缺行/突变失败/CAS 冲突 + **mutation-failure→crash→restart（health 与 quarantine 各一）：reconciliation 完成前零写入、恢复后必须 verified fresh click**。

**4.5b reaction 读结果 → (卡态效果, health 效果) 封闭结果表（R7#3——§4.4 与 §4.5 的口径以本表为准）**：

| 结果 | 卡态效果 | health（lane）效果 |
|---|---|---|
| 200 成功读 | 正常处理 reaction | 清零 + healthy 确认/恢复 |
| 401 / 403 | 不变 | +1；≥3 latch unhealthy |
| 404 | **state-sensitive（R9#2）**：`retiring|retired` → `message_gone=1`（观测解除）；**`posting+ID|active` → CAS → retired(reason=message_gone) 释放 live 槽**（DB 权威卡不许指向不存在的消息）；**repost 与 invalidate 分离（R10#2）**：runtime 上下文 gate 仍 pending → 下 tick 正常发卡流程发新 attempt；**boot reconciler 上下文只 retire 不 repost**——drain 完成、生产 enable 后由 pending-gate 扫描发恰一张新 attempt（保住 producer 排他不变量） | 不计（消息级，非通道级） |
| 429 | 不变，退避 | 不计（限速≠故障） |
| 5xx | 不变，退避 | +1 |
| malformed body | 不变 | +1 |
| 网络错误 | 不变，退避 | +1 |
| nonce-scan fetch 失败 | posting 保持（§4.2b） | +1 |
- GatePoller tick：不健康 ∧ 存在 **active** 卡 → CAS → retiring(channel_down) + edit「批准通道暂不可用，恢复后重发新卡」+ Lead 告警（一次性 marker）。**`posting ∧ message_id IS NOT NULL` 行在 channel_down 时同样 retire(channel_down)**（消息可识别 → 正常 retire 链；配合 §4.2 第 5 步「激活前置复核含通道健康」，封死「§4.2b 在通道不健康时把它激活」的窗口——两道，R4#2）。**未决的 `posting ∧ message_id IS NULL` 行不受 channel_down 连带**（R3#1）：它只能经 §4.2b 完整 nonce 扫描出结果——channel_down 期间保持 posting + 告警重试，绝不在身份未定时被通用 retire 吞掉。恢复 → 发卡流程自然重发（新 attempt，占位已释放）。中断期点击 → §4.4 回应路径（恢复时 reconcile 或明确告知未接受）。CAS 竞态测试：scanner-vs-activation、channel-down-vs-activation（E11）。

### 4.6 evidence-source 接口化（R2 接缝）

- 「QA 证据存在」抽 `QaEvidenceSource` 接口（v1 = auto_qa_record passed；1244 commit B 落地后加 head-bound `qa_passed` claim 实现，两源 OR）。
- `ReviewHoldReason` 预留 `no_qualified_reviewer`（R6 顶住语义）枚举 + 文案；产生逻辑归 1244 子单 D。

### 4.7 PR-2 步骤序（TDD）

RED：①at-most-one-live（并发第二 INSERT 冲突）②CAS 错 from-state 0 行 ③active⇒message_id+binding 不变量 ④**crash 收敛全谱（E7）**：从每个持久化子状态重启——posting 无 ID（nonce 完整扫描找到 / 完整扫描确认缺失→orphan-retire / **扫描不完整→保持 posting 重试** 三支）/ posting+ID / posting+ID+binding / retiring / active-孤儿 ⑤attempt 重发：post_failed → 新 attempt 成功；旧 attempt 行终态不复活 ⑥retire 三调用面 + rebind 先 retire 再发新（live ≤1 恒成立）⑦stale ✅ → 回应 + 零 approval + marker 幂等（retiring 态的卡也在观测集）⑧双频扫描：>20 张高频轮转公平 + **grey_edit_done=1 转低频层仍被扫** + 重启游标 ⑨404→message_gone 解除 / 401·403 ≥3 升级通道 / 429 退避不改状态 ⑩通道中断 retire + 恢复重发 + 中断期点击回应 ⑪**六路授权矩阵逐路 mutation 测试**（reaction 精确点名 / text·voice 永不直写 / deferred replay 拒 + 转通知 / actions·founder-consent 带 authority + 卡存在检查）+ **active-held 五格** + **§4.3b quarantine 全套**（posting/held 期旧 ✅ 激活/释放后零写入；verified 重新点击才写；移除失败+边不可证 → retire+repost；clear-vs-re-arm 与双 re-armer 竞态；cleared-crash-新 hold 重臂；ensureReactionBlocked 耗尽 → retire/block；mutation-failure→crash→restart barrier 前零写入）+ **lane 隔离与 boot barrier**（两 Lead 互不复位；channel_config_drift retire+repost；boot 对账前全路由非授权；**boot 期 404/drift 只 retire 不 repost，drain 后恰一张新 attempt；unresolved 有界终态 boot_reconcile_unresolved；多 lane 坏 lane 不阻塞好 lane；同 boot poison；live-404 双 execution**）⑫gate_answered retire ⑬notify marker per-attempt：post 失败后重试不被旧 marker 压制 ⑭POST ambiguity 三例 + scanner/channel-down vs activation 竞态。
GREEN：表 + CAS + 发卡改造 + reconcile + retire 接线 + 扫描 + 通道谓词 + authority 前置。
REFACTOR：evidence-source 接口抽取 + binding 镜像降级注释。

## 5. 契约级设计（本单只写不实施）

### 5.1 R4 canonical ship_subject（实施 = 子单，挂 FLY-1211 伞下）

versioned schema：`{schema_version, repo, workflow_run_id, policy_version, entries:[{path, op(add|modify|delete|rename), mode_before/after, blob_before/after}]}`；Bridge 从 Git 对象算、fail-closed、绝不 runner 自报。分离「被批 manifest」与「CI 候选 head」；卡激活/记批准前/rebase 后/merge 前四点重算比对。迁移纪律：shadow-compare → dual-write → 绝不 backfill 旧 head 批准 → 全新 gate epoch。依赖：1244 head-authority resolver（已交）+ 本单卡状态机（epoch 载体）。

### 5.2 R7 freeze_epoch（同一子单）

定义域 = readiness 通过（hold 放行 + binding 落定）→ 授权/ship 完成。机制 = server-owned mutation lease（第一方 writer fail-closed）+ 外部写检测（对比 freeze head，漂移 → 原子作废 epoch + retire(head_drift)——PR-2 已有该 retire 链，freeze_epoch 是其「检测更早」版）。已核：`progress` 对非 running session 拒绝（awaiting_review 面已闭）；QA-evidence commit 走 rebind 链 = 合法「有人按钮」动作。

### 5.3 merge 闸终态（排 1244 commit B 落地后）

`evaluateQaShipGate` 的 `qa_required=0 → qa_not_required` 放行退役，重写为与发卡面同一豁免语义（docs-only(server 判) ∨ evidence-source 两源），与 1244 真值表 (a)-(e) 合并。过渡期兜底（拍板 ②）：merge 全 founder-gated + Lead 人肉 verify-approval 链；发卡面已把无证据的卡挡在 founder 视野外。时序：`ship-eligibility.ts` 是 1244 commit B 主战场，先动 = rebase 冲突 + 真值表分叉。

### 5.4 run/generation 级 readiness barrier（R1/R2 全量终态，R1#1）

- 判据契约（PRD R2 原文）：`终点条件 ∧ 同 workflow_run_id/generation 每个 required obligation 对 frozen subject 满足 ∧ 无 active hold` → 才允许卡进入 active。
- 载体：`workflow_run` 身份（1232 已有表 + 1244 enrollment/`current_qa_attempt`）+ obligation 集（1244 子单 D）+ 本单 `founder_ship_card`（live 唯一键从 execution 升级为 run/gate-epoch）。
- 归属：**新子单**（挂 FLY-1211 伞下，排 1244 commit B + 子单 D 之后）；本单 `QaEvidenceSource` 接口与卡状态机为其预留接缝（execution→run 键迁移 = 加列 + 索引替换，attempt 语义不变）。

## 6. 验收矩阵（QA 段逐格核）

| # | 用例 | 期望 | 契约 |
|---|---|---|---|
| E1 | **事故重放**（main、awaiting_review、pr_number 有、`qa_required=0`、零 record、code diff、**codex gate 已满足**） | `'qa_evidence_missing'`；四面全 hold；卡不发；Lead 一次性原因 | R2 止血 |
| E2 | docs-only PR（server 判 0）无 record | 不因 QA hold | R4 豁免 |
| E3 | snapshot 缺失 / API 失败 / 分页不完整 / head 漂移 / repo 不符 / 版本变更 | hold（fail-closed）；补算后自动放行 | 北极星 |
| E4 | **pr_number null / head 缺失（codex off 与 codex_skip 两组）/ 逐 store 方法 throw（codex record·auto_qa_record·snapshot 各一格）** | `'qa_evidence_unknown'` hold（旧行为 fail-open/异常外冒的 RED 证明）+ 去重诊断 | R1#4/R2#5 |
| E5 | manual-spawn：校验矩阵 / 409 幂等 / **API 拒 executor 参数** / auto-vs-manual 并发 / 同 issue 两 parent / claim 后 crash / **stuck 死 runner 复活正负** / spawn QA PASS 全链解 hold | 全 fail-closed；verdict 链零特例；活 runner 与 passed 绝不被 re-drive | R1#5/R2#6 |
| E6 | 分类器：code→docs rename / removed-side symlink·gitlink / 100644↔100755 / symlink→file / **tree 不可得·truncated** / >100 分页 / >50 直接 ship-relevant / 计数不符 / **base_oid 变更** | rename 双路径 + 二段 Git-tree mode 验证；不确定一律 ship-relevant/重算 | R1#6/R2#4/R3#2 |
| E7 | **每个持久化子状态重启**：posting 无 ID（找到/确认缺失/**扫描不完整保持 posting** 三支）/ posting+ID / posting+ID+binding / retiring / active-孤儿 / **crash 于 CAS active 后-marker 前** + attempt 重发 + **POST ambiguity 三例（accepted-then-timeout / 5xx / 成功但 body 畸形 → 全部保持 posting 进 nonce reconcile）** | 每个非终态有收敛转移；无「可点但不可观测」的卡；不完整扫描绝不 orphan-retire；live ≤1 恒成立 | R1#2/R2#1/R4#1 |
| E8 | head 漂移 / re-review / rebind / gate_answered | 旧卡先 retire（edit 置灰 → 转低频观测层）再新卡 | R1 |
| E9 | 点 retiring/retired/posting 卡 ✅；stale text | 明确回应 + 零 approval 写入 + marker 幂等 | R9 |
| E10 | >20 张高频层 + **grey-edited 低频层仍被扫** + 重启游标 | 双频 durable 游标公平不饿死；解除观测唯一条件 = message_gone(404) | R1#7/R2#3 |
| E11 | 通道中断/恢复 + reaction 读 404/401·403 ≥3/429 + **scanner-vs-activation 与 channel-down-vs-activation CAS 竞态** | retire(channel_down)（含 posting+ID）+ 说明 + 恢复重发；激活前置复核挡竞态；404→message_gone、401/403→通道升级、429→退避 | R9/R4#2 |
| E12 | byte-compat 锚：qa_required=1 链 / 三段式相位 / implement·design·qa 角色 / onQaResult 五重链 | 逐字不变 | 红线 |
| E13 | **六路授权矩阵逐路 mutation 测试** + **active-held 五格**（codex_pending / qa_not_green / qa_evidence_missing / qa_evidence_unknown / store 读异常 下点击）+ **quarantine 全套**（posting/held carry-forward 零写入；verified 重新点击才写；hold 期重加 re-arm 后仍零写入；两轮 late-hold 循环；**clear-vs-re-arm 竞态；cleared-crash-新 hold 重臂**；移除失败+边不可证 → retire+repost 零写入）+ **health flip 后-sweep 前全部写入路由拒** + **boot reconciliation barrier**（mutation-failure→crash→restart：对账前零写入、恢复后需 fresh click；**启动各失败结果 unresolved 保持 closed；对账期间 card 生产被排他**）+ **同 boot poison**（healthy 行在场 + 突变失败 → 后续调用拒）+ **live 卡 404 → retire+新 attempt；同 lane 一 200 一 404 双 execution：死卡全路由拒**+ **dual re-armer 与 ensureReactionBlocked 耗尽 → retire/block** + **channel_config_drift → retire+repost** | typed 回应，绝不静默；零非-card-aware 写入；被拒 ✅ 绝不 carry-forward | R1#3/R2#2/R3#4/R4#3/R5#3/R6#1/R8#1/R8#2 |
| E14 | 硬计数器 SQL 四条（§1-2）在全部 E 用例后 | 恒 0 | PRD §6（execution 域） |

## 7. 真机 E2E（隔离环境，非生产 FLYWHEEL_STATE_DIR）

1. 重放 flag 批形状 → 卡被扣 + Lead 收原因（E1）。
2. manual-spawn → 真 QA runner PASS → 卡放行（E5）。
3. head 前移 → 旧卡置灰 + 新卡唯一（E8）；点旧卡 ✅ → 明确回应（E9）。
4. 文字「合」有活卡 → 收到指卡回复（E13，PR-2 后）。
5. 证据：pane 截图 + sanitized DB dump 落 `engineering/doc/FLY-1251-ship-gate-contract/qa-evidence/`，先于 gate 呈报。

## 8. 文件清单 + 与 FLY-1244 的 symbol 级集成矩阵（R1#8）

**PR-1**：`auto-qa-held.ts`（谓词 + guard）· `ship-relevant-diff.ts`（新）· `StateStore.ts`（snapshot 表 + `auto_qa_record.enrollment_source` 列 + 读写方法）· `auto-qa-coordinator.ts`（onMainAwaitingReview 触发 snapshot + **新公开 `manualSpawnQa`**（复用既有 admission 门，§3.3））· `plugin.ts`（manual-spawn 路由注册）· FLY-1099 deferred 分类表 · 各 `__tests__`。
**PR-2 层次归位（R11#3——持久化与编排分层）**：`StateStore.ts` 只放**三表迁移 + 原子 CAS/读写原语**（transitionShipCard 行级 CAS、quarantine 行 CAS、health 行读写/增计/latch）；**编排逻辑**（tryActivatePostingCard 的 gate/head/channel 复核、ensureReactionBlocked 循环、health 谓词组合与 probe、boot reconciler 的 Discord 读与启动协调、双频扫描）放 `gate-poller.ts` 或新 `teamlead/src/bridge/ship-card-service.ts`（implement 期按体量择一，语义同）· `plugin.ts`（**startBridge 序：await boot-reconciler drain → 再 gatePoller.start() + writer hook enable** + 依赖注入）· `event-route.ts`（retire 接线）· `auto-qa-coordinator.ts`（rebind 先 retire）· `gate-message-binding-store.ts`（supersede 扩展 + 读权威降级注释）· approval 入口前置（§4 seam）· 各 `__tests__`。

| 共享面 | FLY-1244 动 | FLY-1251 动 | 集成顺序/规则 |
|---|---|---|---|
| `ship-eligibility.ts` / `write-gate-response.ts` / `actions.ts` / `qa-result.ts` | A/B 主战场 | **零触碰** | 需碰 = 先回 Lead |
| `StateStore.ts` | A/B/C 各表 | snapshot / founder_ship_card / ship_card_reaction_quarantine / approval_channel_health 四表 + enrollment_source 列（独立 `IF NOT EXISTS` 迁移块）+ **行级原子原语**（编排在 bridge 层，R11#3） | 纯加性；rebase 时迁移块顺序无关 |
| `auto-qa-coordinator.ts` | commit B：enrolled verdict 走 capability（`onQaResult` 内加分支） | **不碰 `onQaResult`**；只碰 `onMainAwaitingReview`（加触发）+ spawn 私路复用 + rebind 前 retire | PR-1 先 merge；1244 B 后 rebase 本单分支时 `onQaResult` 无我方 hunk → 零冲突 |
| `plugin.ts` 路由/组装 | B/C 路由 | manual-spawn 路由 + **startBridge 启动序（await boot-reconciler drain → poller/hook enable）** | 加性注册，后 merge 方 rebase 解注册表毗邻冲突（机械） |
| approval 授权前置 | commit A `35a04f510`（已落，无 seam）+ **待落的 seam 后续 commit** | §4.3 `assertActiveCardAuthority`（hook 实现 + plugin.ts 注入，均在本单文件） | **§4.3 blocked 直到 seam commit 落地并把 hash 钉进本 plan**；seam 四项清单见 §4 头；seam 被拒 → 停，回 Lead 重划边界 |
| 联合语义测试 | — | — | 1244 B 落地后补一格：manual-spawn record 证据与 credentialed claim 互不旁路（两源 OR 的 evidence-source 测试） |

## 9. 与后续接缝

| 接缝 | 归属 |
|---|---|
| run/generation 级 readiness barrier + 卡唯一键 run 化（§5.4） | 新子单（FLY-1211 伞），排 1244 B + 子单 D 后 |
| R4 ship_subject + R7 freeze_epoch（§5.1/5.2） | 同上子单 |
| merge 闸终态（§5.3） | 1244 commit B 落地后 |
| claim 证据源接入 `QaEvidenceSource` | 1244 commit B 落地后一行实现 |
| review obligation 集 + `no_qualified_reviewer` 产生逻辑（R3/R5/R6 全量） | 1244 子单 D 汇合 |
| pre-readiness 批准 deferred 语义全量收敛（codex_pending/qa_not_green 现有 defer 行为） | 1244 authority 域 / 子单 |
| 非代码工作流 ship-gate | PRD §9 单独规格 |

## 10. 风险与对策

1. **误伤面**（hold 变严）：main-only + docs-only 豁免 + manual-spawn 逃生口 + Lead 一次性通知；E12 锁其余角色/相位。新增 `qa_evidence_unknown` 对半失败 session 的 hold 是**有意的**（unknown ≠ exempt）——Lead 通知给出恢复路。
2. **GitHub API 依赖**：失败=hold 非放行；退避防打爆；分页/计数完整性检测；classifier_version 支持演进。
3. **与 1244 并行**：§8 矩阵 + 四禁改文件 + 越界回 Lead；PR-2 授权收口（§4.3）在 1244 seam commit 钉 hash 前 = **blocked**（无第二形态）。
4. **卡状态机半失败**：五 crash 边逐一定义 + nonce reconcile + attempt 化重试；安全恒由 DB 态承载。
5. **Discord edit 长期失败**：观测义务永续（无窗）+ 游标轮转成本受控（每 tick N 条）；grey_edit 重试在扫描路径内。
6. **doc drift**：符号/语义定位，行号仅提示。

## 11. 开放项

**一条**：FLY-1244 authority seam commit（§4 头四项交付清单）尚不存在——需经 Tadashi 与 1244 对齐、落地后把 hash 钉进本 plan，§4.3 才解除 blocked。其余：brainstorm gate 三点已拍板；Codex R1/R2/R3 全采纳；R1 版「过渡形态」已作废（不存在第二形态）。
