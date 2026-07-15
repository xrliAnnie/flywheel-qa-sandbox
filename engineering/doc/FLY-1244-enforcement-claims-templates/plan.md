# FLY-1244 DAG 执法层 — 实施计划

Issue: FLY-1244 (https://linear.app/geoforge3d/issue/FLY-1244/build-dag-模板引擎-子单b原-执法层founder-guard-收口-claims-读切换红测变绿-模板)
日期: 2026-07-14
基于: research.md

> 三段式 pipeline：本文档由 design 阶段产出，**implement 阶段在同一分支照此执行**，QA 阶段独立复验。
> 上游 spec = main 上 `engineering/doc/FLY-1135-layer1-dag-templates/plan.md`（Codex 4 轮 APPROVED）
> §2.1/§2.2/§2.3/§2.4/§2.4b/§3.1/§3.1b/§3.2。基底 = FLY-1232（PR #578=a1681d660）已合并的
> substrate（6 表 + capability + 单事务 submit + 影子/outbox，全 default-off）。
> brainstorm gate 4 决策 + 决策 2 机制修订 + Codex design R1（10 HIGH/4 MED/1 LOW）全采纳，Tadashi
> 已批（2026-07-14，含威胁模型收窄 + materialize/founder-mutation-endpoint defer + 三-commit 结构）。

---

## 0. 交付物与红线

**一个 PR，三块交付，三个可独立 review 的顺序 commit**。

> **「default-off + 字节兼容」的精确边界（R2#9，全文统一口径）**：非三段式 run + 未启用模板的旧路径行为**一字
> 不变**。**唯一有意的行为改变** = **durable 三段式 QA 身份**（`session_role='qa' ∧ chat_thread_role='qa'`）**无
> 条件**停认 `qa_required=0`（红测要求），其去向按 enrollment 分流（§4.2）——**这条不是「字节兼容」，是本单的
> 核心执法改变**，凡本文出现「字节兼容」处均以此为界，不含 durable 三段式 fail-closed 分支。

- **③ founder guard 收口 + 跨库投影**（伞单 §2.3 + §2.4b）—— **commit A**
- **④ capability 生产者 + enrollment + claims 读切换 + 红测变绿**（§2.2/§2.4）—— **commit B**
- **⑤ 模板 schema / loader / 发布契约 + 物化 snapshot + 模板 #1 修订**（§3.1b + PRD Gate A-1/2）—— **commit C**

**三-commit 内部 gate（Codex R1#14）**：A（source/projector + 认证生产者 + 突变测试）先落 → B（capability
E2E + enrollment + 读切换，READ 生产保持 off 直到 fresh-spawn + crash/replay 矩阵过）→ C（模板存储 +
只读路由，隔离在执法层之后）。生产 `…_CLAIMS_READ` 在全矩阵绿前不开。

**红线**：
- flag 分立：`FLYWHEEL_WORKFLOW_CLAIMS_WRITE`（写）/ `…_CLAIMS_READ`（读）/ `…_FORCE_LEGACY`
  （应急回退）；**enrollment 按 run 显式 typed 标记 `workflow_run.claims_read_enrolled`（已存在，DEFAULT 0，
  “Never inferred”）**，绝不由表内数据 / flag 推断。
- 账本表绝不弱化 append-only；红测原样落地、绝不弱化断言。
- ⛔ **enable-gate pin**（FLY-1232 评论 7b8255cf）：`…_CLAIMS_WRITE=1` 前必须全真 fresh-spawn E2E。
- 真机 E2E 证据先于任何 gate 呈报（2026-07-14 统一标准）。
- **「绝不落持久化面」只对 decision-capability token 成立**（明文只在 Bridge 内存）；**submission credential
  的 server 侧只存 hash，但其 runner 明文经 spawn env 交付、可能落 shell-snapshot = 选项 B 已接受的残留**
  （§11b，非缺陷）。威胁模型显式收窄（§4.1/§2.1a）。
- merge 即入库，生效等 Bridge 重启（攒批）；Runner 绝不自 merge / 自 :cool:。

## 1. 总验收

1. **红测变绿**：`REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts`（origin/fly-1204-split `58cecc1f`
   原样）跑绿，且未弱化任何断言。（它无 READ、无 enrollment ⇒ 走 §4.2 真值表 (e) **fail-closed** 变绿。）
2. **§13 PRD S1–S16 sentinel 全成立**（§8 ship-gate 证据模型按本单 claims 形态落地）。
3. **E1–E6 sentinel 全立**（伞单 §2.5）。
4. **default-off + 字节兼容**：不启用 + 不迁移的旧路径行为一字不变。
5. **一次真机 E2E**（§7）+ 可复现 sanitized OS 证据脚本落档，先于任何 gate 呈报。

## 2. 架构决策与威胁模型（Codex R1 采纳后定稿）

| # | 决策 | 落地 |
|---|------|------|
| 1 | 红测无条件 vs default-off | 三段式身份**无条件**停认 `qa_required=0`；去向按 enrollment 分流（§4.2）。`FORCE_LEGACY` 走 **live-`.env` resolver**（§4.4），非纯 process env。 |
| 2 | **两条独立不变量**（R1#1/#2 + R3#4 更正） | **① subject integrity**：ship gate 要一条 server 捕获 subject==ship-head 的 `qa_passed` claim（§4.3，治「自选 head」）。**② verdict authentication**：提交者经 per-execution 凭证（§4.1，治理已定 = 选项 B 收窄；真隔离 = peer-cred follow-up）。两条**独立**、分开测；**head-binding 单独不闭合 verdict 伪造**，绝不这样声称。 |
| 3 | 三 scope 边缘 | (a) **materialize kind + node_outputs 整块 defer**（R1#12，见 §10）；(b) 模板 founder **变更 endpoint defer 到 FLY-1038**（R1#9，loopback≠founder 身份），B 只交 StateStore 写 API + 只读路由 + boot 种子导入；(c) 家族校验 = **新 admission 比较器 `manifestReviewFamilyOk`**（消费 **resolved backend/model** family，只借 `adapterTypeToFamily` 的词汇，**不复用**遗留 status/skipped 语义的 `crossFamilyReviewSatisfied`，R2#7/R3#9），派发接线归子单 D。 |
| 4 | 模板 #1 修订 | 三份独立种子模板 heavy/light/trivial；Lead 点菜=选模板+per-run override 带**必填 reason**；QA=一等节点任何档不省；交接=指针进 manifest 契约字段+校验。 |

### 2.1 威胁模型（显式收窄，Codex R1#2）

**本机实证（2026-07-14, macOS 26.3.2）**：① node `net` 拿不到对端 pid；② `~/.claude/shell-snapshots/*.sh`
+ codex-home `shell_snapshots/*.sh` `export` dump 进程 spawn env（fd 交付经 tmux **不可行**——Codex spike
证实已运行的 tmux server fork pane 不继承 Bridge/adapter fd）；③ 同用户 sibling 可 `tmux send-keys` +
`capture-pane` **主动驱动** B 的 pane。

**收窄声明**：单用户 fleet 下，文件系统/env/tmux 对同用户**不可隔离**是**既有属性**，非本单引入。本单
**能治**且必须治的靶 = 红测结构原因：**(i) 过期 headless 布尔**（`qa_required=0` write-once）+ **(ii)
自报 head**（共享 bearer + `--exec-id/--pr-head` 双可伪）。**§4.3 head-bound server-captured 证据 + §4.1
per-execution 凭证退役共享 bearer** 分别消灭 (i)、(ii) 的一半：subject integrity（head 由 server 从真实 PR head
捕获）+ verdict 提交面从共享 bearer 换成 per-execution 凭证。per-execution 凭证是**纵深防御，不是隔离**。

**移出 scope（既有单用户属性，follow-up = 原生 peer-cred broker 或独立 OS principal，且为 READ 上生产的硬前置）**：
主动同用户 pane 注入（send-keys/capture-pane 驱动 B 用它的凭证）+ 同用户密钥物理窃取。plan 与代码注释**不得**
声称比这更强的隔离不变量。

### 2.1a 伞单 §2.2 收窄修订（Tadashi 授权 2026-07-14；本设计取代原 §2.2 三段式）

> 本节是**对 FLY-1135 伞单 §2.2 的正式修订**（伞单 owner Tadashi 明确授权；已知会 Annie，未阻塞）。实现期把
> 本三段同步落进伞单 plan.md 的 §2.2。

1. **原不变量（伞单 §2.2 原文精神）**：capability 明文只在 Bridge/父进程内存；**一个知道 B 的 execution/head、
   能枚举 `~/.flywheel` 的同用户 sibling，仍无法产出或重放 B 的一个有效决策**。
2. **为何单用户 fleet 不可达**：本机实证（§2.1 三条）—— node `net` 无 peer-cred、fd 不跨 tmux server、
   shell-snapshot dump env、tmux send-keys/capture-pane 可主动驱动 B 的 pane。任何把凭证送进 B 同用户可读
   进程树的机制都被同 uid 读到；真正满足原不变量的只有**原生 peer-cred broker**（Bridge 认证连接方而非发 bearer）
   或**独立 OS principal**——两者是大投入，本单不做。
3. **新收窄不变量（本单实际保证，R4#1 精确措辞）**：ship gate 只接受一条 **server 从真实 PR head 捕获 subject**
   的 `qa_passed` claim，且 verdict 提交经 **per-execution 凭证**（退役 fleet-wide 共享 bearer）。**保证**：过期
   headless 布尔不再放行、自选 head 无效、**把被动 harvest 的爆炸半径从「一个永久共享 token 开全队」压到「一个
   execution + 短 TTL」**、跨 execution 自报无效。**不保证（诚实）**：**不阻止同用户 snapshot harvest 本身**——
   同用户 sibling 仍可从 shell-snapshot 读到某活 execution 的凭证、在 TTL 窗口内伪造该 execution 的 PASS
   （§11b 已知接受残留），也不防 send-keys 主动注入。**恢复原不变量的 follow-up = 原生 peer-cred broker /
   独立 OS principal 新 issue（挂 FLY-1135 伞下，READ 上生产的硬前置）。**

## 3. commit A — ③ founder guard 收口 + 跨库投影

### 3.1 收口经**现成共享 writer**（Codex R1#8）

现状：`writeGateResponseAndRunPostWrite`（`approval-signal/write-gate-response.ts:104`）已是 text/reaction/
voice/deferred 的共享写入原语；但 `actions.ts:188 approveExecution` 与 `founder-consent/
gate-response-router.ts:349` 两条**直写** `insertResponse` 绕过它。

**做法**：把 hold 判定 + approval 写入统一到**一个 Bridge-owned `writeFounderApproval`**（增强现有共享
writer 或在其上封一层）：re-read session binding/status/head → 评估 `reviewHoldReason`（`isReviewHeld`，
`auto-qa-held.ts`）→ **在同一 CommDB 事务**写 approval response + source event（§3.3）→ 返回 typed 结果
`{ defer | reject | already_applied | written }`。**actions / founder-consent / text / reaction / voice /
deferred replay 全部改路由经它**；各 caller 侧原有校验保留作纵深防御。沿用 FLY-1099 语义（codex_pending/
qa_not_green→defer，merge_block→reject）；保唯一 kill-switch。

**突变测试（摘真实接线，Codex R1#8）**：突变**共享 writer 自身** + **每条生产路由边**（actions /
founder-consent off|audit|enforce / text / reaction / voice / deferred replay / 同决策重试 / 应急旁路）→
断言变红。
> ⚠️ **不声称消除跨库竞态（R2#5/R3#2 更正）**：hold/binding/head 在 teamlead.db，approval 写在 CommDB，同
> 一 CommDB 事务**无法**联合锁住 teamlead.db 的读——check→write 跨库竞态**不可能靠单库事务消除**。安全由
> 本单不把投影 claim 接入 ship 权限判定；现行安全边界仍由 CommDB response、session/head binding 与
> `verify-approval` 的 USE-time 复验保证。claim-driven founder 执法切换归后续子单 D，不靠不存在的联合锁。

### 3.2 founder_approved 进账本（唯一写者 = projector，Codex R1#7 / R2#5）

founder approval **不**在 `actions.ts` 直接 `appendWorkflowSystemClaim`（否则两写者）。改：`writeFounderApproval`
写 CommDB source event（含 server-resolved 身份），**projector（§3.3）是 founder claim 的唯一写者**。

> **实现边界更正（代码审查）**：B 的 `founder_approved` 是审计投影，不是新的 ship authority。
> `issuer_kind='founder_challenge'` 只是 allowlist 分类标签；`authority_id=question_id` 提供来源关联与幂等键，
> 不构成 nonce/challenge 协议。放行仍读取 CommDB response，并按 session/head binding 由
> `verify-approval` 复验；claim-driven founder 执法切换归后续子单 D。

**source-event allowlist（R2#5，精确）**：**只有**成功插入的**结构化 `approved:true`** response、且其
`actor/classification` 等价于 `verify-approval` 的 **`isTrustedApprovalAttribution`**（canonical founder /
`bridge` / enforce 模式且 attribution 可得的 `bridge-founder-consent`）才写 `kind='founder_approval'` source
event → 投影 `founder_approved` claim。**feedback、off/audit 模式的 Lead-attributed 写入不产生 source event**
（复用 `founder-attribution.ts` 的现成判定，与遗留 reader 的 attribution 保护同口径，绝不放宽）。founder-id
不可得 / attribution kill-switch 情形按 `founder-attribution.ts` 现语义（SKIPPED）处理并在 payload 标注。
- **写入原语（R2#5）**：response + source event 用 **CommDB 条件插入**（等价 `insertResponseIfGateOpen` ——
  gate 仍 open 才写），在同一 CommDB 事务内附 source。
- **跨库竞态诚实声明（R2#5 / R3#2）**：session binding/head/hold 在 teamlead.db，CommDB 事务开着也
  **无法消除**跨库 check→write 竞态。B 不把异步投影 claim 当作放行依据；现行 `verify-approval` 在 USE time
  读取 CommDB 权威 response 并复验 session/head binding。若同 head rebind 到新 `review_question_id` 或出现
  hold，旧 response 不满足当前 binding。claim 的 `authority_id` 仅冻结来源 question 供审计，未来若切换
  claim-driven founder enforcement，必须在子单 D 另行定义 generation/revocation 契约并补对应竞态测试。

### 3.3 跨库投影（目的地幂等，Codex R1#7）

**CommDB 新表**（append-only，BEFORE UPDATE/DELETE trigger）：
```sql
CREATE TABLE workflow_source_event (
  project TEXT NOT NULL, source_event_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'founder_approval' | 'turn_grant'
  payload TEXT NOT NULL,       -- versioned canonical JSON (server-resolved identity)
  payload_digest TEXT NOT NULL, schema_version INTEGER NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (project, source_event_id));
CREATE TABLE turn_source_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL,
  from_role TEXT, to_role TEXT NOT NULL, epoch INTEGER NOT NULL,
  target_run_id TEXT,                 -- commit A 内恒 NULL = project/issue 级 destination(不依赖 §4.2b);run 级=B/D
  source_event_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL);   -- 一 source event 一行,防 retried grant 二次 epoch++
```
- **versioned canonical source payload**：approval 事件写入时 server 解析并冻结 `run_id / issue / question_id /
  response / actor / approved_head / classification`（TURN 事件冻结 `old_holder / new_holder / resulting_epoch`）——
  **绝不在投影时再查 head/active run**（否则绑到新 head 或后一个 run，R1#7）。用 **approval 专用 / TURN 专用**
  CommDB 方法，不给通用 `insertResponse` 塞语义。
- `grantTurn`（db.ts:929）覆盖单行 + epoch++ ⇒ **先按 caller-stable `source_event_id` 查重（同一 grant 重试同
  id），再在同一 CommDB 事务内 epoch++ + 附写 `turn_source_history`**（append-only；`UNIQUE(source_event_id)`
  保证 retried grant 不二次 epoch++，R3#8）。
- **canonical digest 的包依赖方向（R3#8/R4#5 —— 定稿单一 home）**：`canonicalSubmissionDigest` 现住 teamlead
  （更高层），CommDB source event 在 flywheel-comm 侧创建。⇒ **下沉到 `flywheel-config`**（两侧已依赖它），source
  写入与目的地 receipt digest 用**同一实现**（不留「两侧各一份」的第二字节契约，避免 exact replay 变 poison）。
- **A/B 顺序解耦（R3#8/R4#5 —— commit A 不依赖 B）**：commit A 内 TURN **恒**落 **project/issue 级 destination**
  （`target_run_id=NULL`，**不**解析唯一 run、不冒充 `workflow_run_event`）；`applyWorkflowSourceEvent` 对 null-run
  TURN 的返回 = **只写 receipt + project-history disposition**（不建 run event），返回类型显式含此 disposition。
  run 级 TURN run-event 化是 B/D 之后的事。commit A 因此可独立实现。
- **StateStore 目的地幂等原语** `applyWorkflowSourceEvent`（新，单事务）；destination receipt + dead-letter
  DDL（R2#6，可执行）：
  ```sql
  CREATE TABLE workflow_source_receipt (
    project TEXT NOT NULL, source_event_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
    claim_id INTEGER, applied_at TEXT NOT NULL,
    PRIMARY KEY (project, source_event_id));            -- 目的地唯一键（teamlead.db 侧）
  CREATE TABLE workflow_source_deadletter (             -- poison 事件终态,可审计,不无限重试
    project TEXT NOT NULL, source_event_id TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY (project, source_event_id));
  ```
  `applyWorkflowSourceEvent` **返回 tagged union（R5#3，两类目的地分明）**：
  - founder approval → `{kind:'founder_claim', status:'applied'|'replayed', claimId}`（插 receipt + claim 同事务；
    精确重放返回既有 claimId；digest 不符 fail-closed）；
  - TURN（commit A 恒 project/issue 级）→ `{kind:'turn_project_history', status:'applied'|'replayed'}`——**只写
    receipt + project-history disposition，不建 `workflow_run_event`、不解析 run**（A/B 解耦，§下）。
  canonical digest 复用下沉到 `flywheel-config` 的 sorted-key 规范化（与 `workflow-claims.ts`
  `canonicalSubmissionDigest` 同实现）。
- `turn_source_history` 的 **`UNIQUE(source_event_id)`**（一 source event 一行，防 retried grant 二次 epoch++）+
  `source_event_id` 由 caller 稳定派生（同一 grant 重试同 id）—— 见 DDL。
- **projector 驱动**：启动 drain + 周期 drain；malformed/poison → `workflow_source_deadletter` 终态（可审计，
  不无限重试）。crash 测试：source commit 后 / destination commit 后未 ack / 重启中，权威行与账本都存活且不重复；
  retry-before/after current-state update 不二次 epoch++。
- 双读期：runner TURN 读 / `verify-approval` **本单不切读侧**（只补源 + 投影）。

### 3.4 commit A 步骤序（TDD）

RED：突变测试（3.1 全路由边）+ 目的地幂等 receipt（精确重放 no-op / digest 不符拒）+ 三 crash 窗口 +
append-only trigger 拒改 + versioned payload 冻结身份（投影不重查 head）。GREEN：`writeFounderApproval` +
CommDB 两表 + `applyWorkflowSourceEvent` + projector。REFACTOR：founder claim 唯一写者 = projector（逐点数）。

## 4. commit B — capability 生产者 + enrollment + claims 读切换 + 红测

### 4.1 capability 交付通道 = 选项 B（Tadashi 拍板 2026-07-14，伞单 owner 授权改 §2.2）

**术语区分**：**decision-capability token** = substrate 凭证（`token_hash` 存 DB，明文只在 Bridge 内存，runner
从不持有）；**submission credential** = 派发时 mint、**持久化 server 侧**的 per-execution 提交凭证，runner 用它
认证到专用提交面。两者分离。

**R2#1 的硬事实（我 R1/R2 的错，已更正）**：head-bound server-captured 证据挡得住**自选 head**，但**不认证
verdict**——sibling A 偷到 B 的 env 提交凭证后，拿它提交 `qa_passed`，Bridge 忠实盖 B 身份 + 真实当前 head H，
ship gate 接受这条对 H 的伪 PASS（A 无需碰 head）。单用户 fleet 上，任何把 secret 送进 B 同用户可读进程树的
机制都泄。

**决策（选项 B，含 §2.2 修订授权）** —— 落定必带五条（Tadashi 直令）：

1. **per-execution 凭证 = 纵深防御，诚实标注不是隔离**：它**退役 fleet-wide 共享 ingest bearer**（把攻击面从
   「一个永久共享 token 开全队」压到「一个 execution + 短 TTL」），但**不声称同用户隔离**。删除 R1/R2 的 L1 假
   隔离声明。威胁模型显式收窄（R4#1 精确）：**保证**共享 bearer 被动 harvest 的**爆炸半径**被压到单 execution +
   短 TTL、跨 execution 自报无效；**不保证**阻止同用户 snapshot harvest 本身（凭证明文经 spawn env 落 snapshot
   仍同 uid 可读）+ 同用户主动注入（send-keys/capture-pane）/ 密钥物理窃取 = 单用户 fleet **既有属性**。
2. **伞单 §2.2 修订（三段式，§2.1 承载，不一句话带过）**：原不变量 → 为何单用户 fleet 不可达 → 新收窄不变量
   + 恢复原目标的 follow-up 指针。
3. **原生 peer-cred broker（或独立 OS principal）= 独立 follow-up issue，挂 FLY-1135 伞下，且是 READ 上生产的
   硬前置**：enable-gate 现有**两**前置——fresh-spawn E2E（7b8255cf）**与** peer-cred 加固；两者未过 READ 绝不
   上生产（§6 Gate-0 守）。
4. **残留 = 已知接受项**：同用户 TTL 窗口可伪造某 execution 的 PASS —— 列进 §11b「已知限制」+ 指向 peer-cred
   follow-up。
5. **退役共享 bearer 的改进保留**（enrolled run 的 verdict 提交不再用共享 `FLYWHEEL_INGEST_TOKEN`）。

**交付形态（选项 B）**：per-execution bootstrap 凭证经 spawn env 注入（落 shell-snapshot 是接受的收窄残留），
`workflow_submission_credential`（§4.1b，选项-B bearer 单形态）持久化 hash + 一次性 consume + 短 TTL。

**提交面（R1#6）**：runner 到专用提交面只带 submission credential + verdict payload + client_request_id；
**Bridge 派生 issuer session/backend/model、producer execution/backend、server-owned 当前 head、expiry** → 内部
mint+consume 写 claim。**client head 只比对，绝不信任。** head resolver = **§4.3b 导出的共享 head-authority**
（现成 `capturePhaseHeadSha` 抽出为共享 resolver，持久 worktree `git rev-parse`）；ship gate 与提交面用**同一**
head 权威。

**负测（§7 真跑，选项 B）**：sibling A 具备 B 的 exec-id/head + 枚举 `~/.flywheel` + 读两处 shell-snapshots +
`tmux show-environment -t B` + 连 Bridge。断言**仍成立的**保证：server 选定 head（非自选）、精确重放幂等、
mismatched/无凭证拒。**明确记录**「凭证生命期内同用户 sibling 可伪造 B 的 PASS」= 已知接受残留（§11b），
**不测、也不声称** head-binding 挡 verdict 伪造；out-of-scope 项（send-keys 主动注入）明列不测。

### 4.1b 持久 submission 凭证表 + 单事务（Codex R2#3 / R3#5 / R4#2 —— 选项 B 定稿、约束齐全）

治理已定 = 选项 B（§4.1）⇒ **DDL 就是选项 B 的可执行形态，不再留 peer 分支**（peer-cred 是后续 follow-up 的独立
schema，届时另建，不占本表）。

**新表 `workflow_submission_credential`（选项 B，teamlead.db，与 claims 同库；FK/CHECK 齐全，R4#2）**：
```sql
CREATE TABLE workflow_submission_credential (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_hash TEXT NOT NULL UNIQUE,          -- 选项 B 必存 hash(明文只在 Bridge 内存/spawn env)
  run_id TEXT NOT NULL, node_id TEXT NOT NULL, execution_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('qa_verdict','review_verdict')),
  decision_capability_id INTEGER,                -- 与 substrate 凭证精确关联(consume 时回填)
  issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, absolute_deadline_at TEXT NOT NULL,
  consumed_at TEXT, consumed_client_request_id TEXT, consumed_submission_digest TEXT, claim_id INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0, revoked_reason TEXT,
  -- 复合 FK: 凭证的 (execution,run,node,attempt) 必须逐字匹配那条不可变绑定(防错配到别的 run/node/attempt)
  FOREIGN KEY (execution_id, run_id, node_id, attempt)
    REFERENCES workflow_execution_binding(execution_id, run_id, node_id, attempt),
  FOREIGN KEY (decision_capability_id) REFERENCES workflow_decision_capability(id),
  FOREIGN KEY (claim_id) REFERENCES workflow_claims(id));
-- 部分唯一索引: 每 (run,node,attempt) 至多一条 live(未 consume 未 revoke)凭证
CREATE UNIQUE INDEX ux_submission_live ON workflow_submission_credential(run_id,node_id,attempt)
  WHERE consumed_at IS NULL AND revoked = 0;
```
（§4.2b 的 `workflow_execution_binding` 相应加**复合唯一键** `UNIQUE(execution_id, run_id, node_id, attempt)`
供此复合 FK 引用。）

**单事务原语 `submitWorkflowDecisionByCredential`**（**取代** R1「先 issue 再 submit 两事务」）：一个事务内
① 认证 credential（有效×未过期×未 consume×未 revoke×family 允许）② 内部派生/校验 decision-capability（回填
`decision_capability_id`）③ 写或返回 claim（回填 `claim_id`）④ **原子记录 replay 结果**（consumed_at +
client_request_id + submission_digest）。
- **精确重放**（同 credential + 同 client_request_id + 同 submission_digest）→ 返回既有 claim（response loss /
  Bridge 重启后仍可，**不依赖 Bridge 内存里的 decision token**）；**mismatched → 拒**。与 substrate 幂等语义对齐
  （精确 consumed 重放先于 expiry 检查返回既有 claim）。
- **替换凭证**：同 attempt 的替换只经**已认证 execution 通道**重 mint，且**吊销 orphan**（revoked=1）。
- **marker（R1#3，覆盖 `qa-result`）**：只存**非机密**重试数据（client_request_id + submission_digest + 绑定
  run/node/attempt），**不存明文 token/body**；重试用**仍有效 credential** 走同一单事务重认证。
- 故障注入：交付前 / 读凭证后-Bridge 收到前 / **claim commit 后-response 丢失** / Bridge 重启 —— 每点重放收敛
  到同一 claim，绝不 strand、绝不冲突重 mint。

### 4.2b ship gate 的唯一 execId→run→QA node 绑定（Codex R2#4）

现状：`evaluateQaShipGate` 只收 `execId + prHead`；`workflow_run.claims_read_enrolled` 是 run 级；
`workflow_run_node.execution_id` **无唯一约束**（且 `upsertWorkflowRunNode` 可改 `execution_id`——单唯一索引
不保证不可变）；`resolveWorkflowDecisionClaim` 需 QA `nodeId`（省了会查 `node_id IS NULL` 命中不到 runner-node
claim）。
- **定稿 schema（R3#6/R4#2 —— 专用 append-only 绑定表，含复合唯一键）** `workflow_execution_binding`：
  ```sql
  CREATE TABLE workflow_execution_binding (
    execution_id TEXT PRIMARY KEY,        -- 一 execution 一行,append-only(无 UPDATE 路径)
    run_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt INTEGER NOT NULL, bound_at TEXT NOT NULL,
    UNIQUE (execution_id, run_id, node_id, attempt));   -- 供 §4.1b 复合 FK 引用
  -- BEFORE UPDATE/DELETE RAISE(ABORT) — 绑定不可变
  ```
  §4.5 fail-closed admission 事务写它。
- **「当前授权 QA attempt」= 可执行的权威源（R5#1 —— 新增 run 级字段，不靠隐含推导）**：`workflow_run` 加一列
  `current_qa_attempt INTEGER`（admission/re-qa 事务**原子更新**为本次授权的 QA attempt；default NULL = 未 enroll）。
  ship gate 授权解析用**精确 SQL**：
  ```sql
  -- 给定 execId,解析当前授权 (run,node,attempt);任一步为空/多行 → fail-closed
  SELECT b.run_id, b.node_id, b.attempt
    FROM workflow_execution_binding b
    JOIN workflow_run_node n
      ON n.run_id=b.run_id AND n.node_id=b.node_id AND n.attempt=b.attempt AND n.execution_id=b.execution_id
    JOIN workflow_run r
      ON r.run_id=b.run_id AND r.current_qa_attempt=b.attempt   -- 该 execution 的 attempt 必须是 run 当前授权 QA attempt
   WHERE b.execution_id=:execId AND r.claims_read_enrolled=1;
  ```
  即：不可变绑定 join **当前** `workflow_run_node` 投影（`execution_id` 仍相等 → 不是被替换的旧 execution）**且**
  该 attempt == `workflow_run.current_qa_attempt`（run 级权威，非 resolver 的 max-attempt）。
- **claim 侧匹配（R3#6/R5#1）**：候选 claim 的 `issuer_execution_id`/`attempt` 必须逐字等于上面解析出的
  `(execution_id, attempt)`——**不因 resolver 取 max-attempt 而放行更新 attempt 的 claim**。两侧（StateStore +
  flywheel-comm）或一个 enrolled-gate wrapper 都测这条精确谓词。
- **migration preflight 只作用于被 enroll/backfill 的行（R5#1 —— 不全局 null 扫）**：admission 写绑定时对**这一条**
  execution 校验 dup/null，冲突 fail-closed；**既有 legacy/非-enrolled 的 `workflow_run_node.execution_id` null
  合法保留，字节兼容**，不做全局 null preflight（否则 default-off 迁移会在 Bridge boot 崩）。
- 契约测试（BIND）：同 issue 两 run / **同 attempt 替换 execution（旧 execution 不再是当前投影 → 拒）** / **后一个
  逻辑 attempt（`current_qa_attempt` 前移后旧 attempt claim 不放行）** / 旧 execution 在新 attempt 后 / stale /
  缺绑定 / 绑定 run/node 与 `current_qa_attempt` 不符 —— 全 fail-closed；legacy null 行不误伤。

### 4.2 read-switch 真值表（Codex R1#4 —— 补全 enrollment + READ）

`evaluateQaShipGate`（`ship-eligibility.ts`）新分支，**FORCE 先于任何 claims 查询解析**（§4.4）：

| 情形 | 判定 |
|---|---|
| (a) `FLYWHEEL_QA_DONE_GATE=0` | 现有独立 bypass 不变（`qa_gate_off`） |
| (b) `FORCE_LEGACY` on（live-`.env`） | 完整旧 QA 布尔路径 |
| (c) 非 durable 三段式 QA 身份（`session_role='qa' ∧ chat_thread_role='qa'` 不成立） | 旧布尔路径（字节兼容） |
| (d) durable 三段式 QA 身份 ∧ `FLYWHEEL_WORKFLOW_CLAIMS_READ=1` ∧ **该 run `claims_read_enrolled=1`** | 按 §2.1 解析算法查 claims 当前 head 的有效 `qa_passed`；有→pass，无/过期/吊销/FAIL/head 不符→fail-closed |
| (e) durable 三段式 QA 身份 ∧（无 READ **或** 未 enrolled） | **fail-closed**（新 reason `qa_claim_gate_unenrolled_failclosed`）+ 显式 re-QA 恢复；**永不返回 `qa_not_required`** |

**红测正是 (e)**：它是 durable 三段式 QA 身份、无 READ、无 enrollment ⇒ fail-closed ⇒ `passed=false` 且
reason≠`qa_not_required` ⇒ 变绿。**真·生产三段式 run 经 (d) 才真读 claims**，需 READ=1 + 显式 enrolled。

**可信 enrollment（R1#4）**：新增 admission 期 API（fail-closed，非 best-effort 影子）在派发前把 run
`claims_read_enrolled=1`（显式 CAS + 审计），与 §4.5 mint seam 同一 admission 事务。

### 4.3 head-bound server-captured 证据（治两结构因之一：自选 head）

enrolled 三段式 QA verdict → 经 §4.1 提交面，Bridge **从真实 PR head 服务端捕获 subject**（`capturePhaseHeadSha`）
→ 写 `qa_passed`/`qa_failed` claim（subject_kind=git_head，subject_digest=server-captured head，issuer=QA 节点
resolved vendor/model）。ship gate（§4.2 (d)）查「当前 ship-head 的有效 `qa_passed`」。**治的靶 = 红测结构因
(i) 过期 headless 布尔 + (ii) 自选 head**：H2 想过必须有 subject==H2 的 claim。
> ⚠️ **诚实边界（R2#1）**：head-binding **不认证 verdict 提交者**——认证靠 §4.1 的 transport（治理决策）。
> head-binding 单独只保证「claim 绑对 head」，不保证「提交者是真 QA」。两者叠加才闭合结构因 (ii)。

### 4.3b 单一权威 head resolver 贯穿提交面 + 所有 ship 面（Codex R3#3）

**现状问题**：`capturePhaseHeadSha` 是 `PhaseOrchestrator` 注入 effect（plugin.ts 组装），**不是**共享
resolver；而现有 ship 面（event-route / `DirectEventSink` / complete-marker / external-merge / recovered-merge
finalization / CLI `--pr-head $(git rev-parse HEAD)`）**接受 caller 自报 `prHead`**。若提交面 server 捕获 head、
ship 面却比对一个自报旧 head，H1→H2 只在窄 fixture 过、真 finalization 仍放 stale。
- **交付**：抽一个**导出的 head-authority 接口**（持久 worktree `git rev-parse` 权威源，缺失/清理的 worktree
  fail-closed），**提交面 + 每个 ship/finalization 入口都用它**；session/evidence 里的 head 值**只作比对/缓存，
  绝不作权威**。
- 集成测试：event-route / `DirectEventSink` / complete-marker reconcile / external-merge reconcile /
  recovered-merge finalization 各一格，证明它们用同一 head 权威。**文件清单相应加 plugin 组装 + merge-ship-gate +
  各 sink**（§9 更新）。
- **CLI `verify-approval` 的 head 权威（R4#3 —— 补上被 gated 方仍能自选 head 的洞）**：现状 `verify-approval`
  硬要 `--pr-head $(git rev-parse HEAD)` 且**用法文本把它当 ship 前置权威**，而 CLI 在 runner descendant 里跑、
  自报 head。teamlead-only 的 resolver 又不能被 flywheel-comm import。**定稿**：`verify-approval` 改**调一个
  Bridge endpoint**（`POST /api/workflow/head-authority`，loopback），由 Bridge 用 §4.3b 的权威 resolver 从
  **持久 worktree** 解析 head，CLI 自报的 `--pr-head` **只作比对值**（不符→拒），**server 解析的 head 才是 ship
  权威**；worktree 缺失/清理 → fail-closed。§9 加 `verify-approval.ts` / index / runner-wake / runner-Lead 契约
  文件 + 一格测试：**CLI 传 H1 而权威 worktree 是 H2 → 拒**。

### 4.4 FORCE_LEGACY 复用 live-`.env` resolver（Codex R1#5）

`ship-eligibility.ts` 已有 `resolveDefaultOnGate`（显式 `argsEnv` 键胜出→测试 hermetic；readable
`~/.flywheel/.env` 权威含 key-absent；不可读回落 process env）。`FORCE_LEGACY` 用**同款 resolver**（default-OFF
语义 `resolveDefaultOffGate`），**在任何 claims 查询之前解析**——长命 runner descendant flip `.env` 即时生效。
测试：force on/off × durable QA × enrolled/non-enrolled × 缺列 × 长命 runner `.env` flip。

### 4.5 fail-closed admission/mint seam（Codex R1#6）

capability mint 需 spawn 前 durable `(run,node,execution,attempt)`。现影子 seam best-effort/swallow/返回 void/
可能建未 enrolled 影子 run ⇒ **enrolled run 走独立的 fail-closed admission seam**：原子返回权威 run/node/attempt
身份 + `claims_read_enrolled=1` + mint submission credential，**失败即 fail-closed（不启动 runner）**，绝不
落一个「永远拿不到有效票」的 runner。

**claim-driven orchestration 边界（R1#6，明确 defer）**：本单 = 产 claim + ship gate 读 claim；**QA FAIL→
implement kickback 的 DRIVE 仍走现有 `AutoQaCoordinator`**（claim 是**附加**证据，非唯一触发器）。「committed
`claim_written` event/outbox 作为编排唯一幂等触发器 + startup replay + exactly-once」= **子单 D**（outbox
观察→驱动）。B 不把 verdict 提交改成新编排路径，避免 claim-commit→coordinator 新 crash 窗口。

### 4.5b codex-review-result 的归属（Codex R2#8 —— 明确留在现有 FLY-827 路径）

`codex-review-result` **不进** capability 迁移：B 的种子 ship claim = `qa_passed` + `founder_approved`，
**不要求 `codex_approved`**；代码审仍走**现有 FLY-827 `crossFamilyReviewSatisfied` gate**（`本单不改其权威`）。
B 对 `codex-review-result` 只做**一件事：marker 洗成不透明**（去明文 body），**不**给它接 capability/claim 生产。
未来模板 review 节点的 claim 生产 = **子单 D**；本单保留 substrate 级 E6 测试（同 family review claim 拒）。

### 4.5c in-flight 三段式 re-QA 恢复命令（Codex R2#9 —— 可执行,非手改 DB）

§4.2 (e) 是**有意的行为改变**（durable 三段式 QA 无 enrolled → fail-closed）——部署时在飞的三类 session 各需
**可执行且相位安全的恢复**（R3#7 —— 绝不违反三段式相位顺序），不是手改 DB：
- **design / implement 在飞**（尚未到 QA）：**继续现有相位**，让它**正常 handoff** 时**创建一个新 admitted +
  credentialed 的 QA attempt**（§4.5 admission）；过渡期若现有 ship 面会评它，用 `FORCE_LEGACY` 兜（§4.4）——
  **绝不**提前起 QA 去测一个未完成 worktree / 抢 TURN / 跳过 handoff。
- **QA 在飞且无凭证**：这个才 supersede/revoke 旧的、respawn 一个新 admitted QA attempt。
- **命令（定稿，R3#7 —— 选 authenticated Bridge API，不留 CLI/API 二选一）**：Bridge admission API
  `POST /api/workflow/re-qa`（loopback + confirmToken，与 §5.7 只读面同框架但**这是内部运维动作非 founder 变更**），
  **幂等键 = (run, QA attempt)**（非 issue 级），同 run 重复调收敛同一未决 QA attempt。
- **禁止对已在跑的无凭证 attempt 追认 enrollment**（否则 §4.5 fail-closed 意义被架空）——只能起**新** attempt。
- 部署分类测试：design/implement（继续相位 → handoff 建新 QA）/ qa（supersede 重起）各一格；命令注册文件入 §9。

### 4.6 flywheel-comm 侧解析（依赖方向，Codex 采纳）

`evaluateQaShipGate` 已 readonly 打开 teamlead.db ⇒ 能读 `workflow_claims`，但不能 import
`StateStore.resolveWorkflowDecisionClaim`。⇒ flywheel-comm 侧**只读 SQL 复现** §2.1 解析（最高 attempt+
server_seq→吊销/过期/冲突/pass，**绝不回落旧 attempt**）+ **跨实现契约测试**（同组 claim 行喂两侧逐 case 断言
一致）。family 校验复用 `packages/config/src/review-family.ts`（config 是低层包，两侧都能 import）。

### 4.7 1204-split 吸收（path/hunk 矩阵，Codex R1#13 —— 目的地文件/符号级）

| 源 commit | 目的地文件/符号 | 取 hunk 目的 | 排除/取代 | 现树等价 |
|---|---|---|---|---|
| `58cecc1f` | `__tests__/REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts` | 红测原样（唯一验收线） | — | 无（新文件） |
| `61593e8a` | ship-path deadlock：QA phase owns PR head 的 ownership hunks | 只取 head-ownership 判定 | **排除**它回退的 `4975ee0d` 文件块 | 与现树 retry/ownership 逐块 range-diff |
| `4975ee0d` | retry admission 测竞用 worktree（**最终实现**） | worktree-occupancy 判据 | 排除被 61593e8a 回退的中间态 | patch-id 比现树 |
| `40405388` | PR-head ownership decides Codex gate（16 文件）| head-ownership 决定 gate 的符号 | 逐文件 range-diff，跳已落等价 | 现树 `crossFamilyReviewSatisfied`/head-ownership |
| `8c24044f`+`b3457180` | evidence-not-marker | ship 豁免立于证据非 marker | — | 现树 ship-eligibility 语义 |
| `0a06fe3e` | settle qa_required past premature approval | **语义参照，非 cherry-pick**（由账本取代） | 整块 | §4.3 head-bound claim 取代 |
| `78e29299` | parked-patrol 再入 guard/throttle 测试 | **语义参照**（现树已有等价实现） | 不重复落地 | 现 worktree parked-sweep 实现 |

**实现期**：对本分支跑 range-diff / patch-id 逐块比对，**不盲 cherry-pick**；合成树上跑红测 + 每个具名
parked/retry/worktree/head-ownership 套件全绿。

### 4.8 commit B 步骤序（TDD）

RED：红测落地（走 (e) 自然变绿）；§4.2 真值表五情形逐格；跨实现契约测试；§4.1 提交状态机 + 恢复 + 负测三格
（含两 marker）；§4.3 head-bound（H2 卡 ship / re-QA 后放行 = E2）；§4.4 FORCE 五组；§4.5 admission fail-closed。
GREEN：capability 提交面 + Gate-0 选定交付 + admission/mint seam + enrollment CAS + `evaluateQaShipGate` 分支
+ flywheel-comm SQL 解析 + 两 marker 改不透明。REFACTOR：解析双实现契约锁一致。

## 5. commit C — 模板 schema / loader / 发布契约 + 物化 snapshot

### 5.1 表族完整 DDL（Codex R1#11 / R2#7 —— 可执行 SQL）

```sql
CREATE TABLE workflow_template (
  template_id TEXT PRIMARY KEY, name TEXT NOT NULL,
  project_scope TEXT NOT NULL CHECK (project_scope = 'global' OR length(project_scope) > 0),
  current_published_revision INTEGER, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  seed_owner TEXT NOT NULL DEFAULT 'system' CHECK (seed_owner IN ('system','founder')),
  seed_content_hash TEXT);                        -- 出厂种子 manifest hash,判 founder 是否改过
CREATE TABLE workflow_template_revision (
  template_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
  manifest TEXT NOT NULL, manifest_digest TEXT NOT NULL, schema_version INTEGER NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (template_id, revision),
  FOREIGN KEY (template_id) REFERENCES workflow_template(template_id));
CREATE TABLE workflow_template_publication (            -- append-only 发布事件
  id INTEGER PRIMARY KEY AUTOINCREMENT, template_id TEXT NOT NULL, revision INTEGER NOT NULL,
  published_by TEXT NOT NULL, published_at TEXT NOT NULL,
  FOREIGN KEY (template_id, revision) REFERENCES workflow_template_revision(template_id, revision));
CREATE TABLE workflow_category_binding (
  project TEXT NOT NULL, task_category TEXT NOT NULL,   -- 默认行哨兵 '*'(非 nullable → 无多默认)
  template_id TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project, task_category),
  FOREIGN KEY (template_id) REFERENCES workflow_template(template_id));
CREATE TABLE workflow_template_audit (                  -- founder 写面审计(seed 导入/发布/绑定/run override)
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('seed_import','publish','rebind','create','run_override')),
  template_id TEXT, revision INTEGER, run_id TEXT, detail TEXT);   -- run_override 记 run_id + reason(detail)

-- 可执行 append-only triggers(R4#4，不再只写注释):
CREATE TRIGGER trg_wtr_no_update BEFORE UPDATE ON workflow_template_revision
  BEGIN SELECT RAISE(ABORT, 'workflow_template_revision immutable'); END;
CREATE TRIGGER trg_wtr_no_delete BEFORE DELETE ON workflow_template_revision
  BEGIN SELECT RAISE(ABORT, 'workflow_template_revision immutable'); END;
CREATE TRIGGER trg_wtp_no_update BEFORE UPDATE ON workflow_template_publication
  BEGIN SELECT RAISE(ABORT, 'workflow_template_publication append-only'); END;
CREATE TRIGGER trg_wtp_no_delete BEFORE DELETE ON workflow_template_publication
  BEGIN SELECT RAISE(ABORT, 'workflow_template_publication append-only'); END;
CREATE TRIGGER trg_wta_no_update BEFORE UPDATE ON workflow_template_audit
  BEGIN SELECT RAISE(ABORT, 'workflow_template_audit append-only'); END;
CREATE TRIGGER trg_wta_no_delete BEFORE DELETE ON workflow_template_audit
  BEGIN SELECT RAISE(ABORT, 'workflow_template_audit append-only'); END;
```
**materialize/node_outputs 不在本单**（§10 defer）。物化 snapshot 落 `workflow_run.snapshot`（A 已有列）。
> ⚠️ **迁移幂等（R5#2）**：上面所有 `CREATE TABLE`/`CREATE TRIGGER`/`CREATE INDEX`（含 §3.3/§4.1b/§4.2b 各表）
> 实现时一律带 **`IF NOT EXISTS`**（StateStore 迁移在每次 Bridge boot 重跑，非幂等会在第二次启动崩）。

### 5.2 发布契约（Codex R1#11 / R2#7 —— 单事务 CAS）

- revision manifest 字节不可变 + trigger 禁改。
- **发布 = 一个事务**：① 校验 `revision` 属于该 `template_id`（FK + 存在性）② append publication 行 ③ **CAS**
  `UPDATE workflow_template SET current_published_revision=:new WHERE template_id=:id AND
  current_published_revision IS :expected`（0 行 → 409）。pointer CAS 与 publication insert **同事务**。
- 种子导入按 **manifest content-hash 幂等**：`seed_content_hash` 匹配 no-op；**不同且 `seed_owner='founder'`
  （founder 改过）→ 拒 + 写 `workflow_template_audit`，绝不静默 repoint**。
- 并发编辑 stale-edit **409**（expected revision CAS 失败映射）。

### 5.3 manifest normative schema + 校验清单（Codex R2#7 —— 精确 enum/键边界）

```
schema_version: int                                    # 支持版本 = 常量 SUPPORTED_MANIFEST_SCHEMA (=1)
nodes: [ { id: str, type: 'design'|'implement'|'qa'|'gate',
           vendor?: 'claude'|'codex', model?: str, effort?: 'low'|'medium'|'high'|'xhigh',
           handoff_pointer?: { worktree: bool, design_doc: bool } } ]   # 拒内联全文 prompt 字段
# 注(R3#9): 本单 3 种子无 generic 节点 → agent_file 字段本单不引入(避免引用不存在的 node type);
#           generic 节点契约 = 子单 C(原⑥),届时它引入 agent_file + 对应校验。
edges: [ { id: str, from: nodeId, to: nodeId,
           condition: 'design_done'|'implement_done'|'qa_pass'|'founder_approved' } ]  # 封闭 enum
loops: [ { id: str, from: nodeId, to: nodeId,
           loop_when: 'qa_fail'|'founder_feedback_kickback',
           exit_when: 'qa_pass', max_iterations: int(>0), on_limit: 'escalate' } ]
terminal_gate: { node: nodeId, predicate: 'founder_approved' }
ship_claims: [ 'qa_passed'|'founder_approved' ]         # 该模板 ship 要求的 claim predicate 集
```
**required/optional 键 + unknown-key 边界**：required = `schema_version, nodes[].id, nodes[].type, edges[].{id,
from,to,condition}, terminal_gate.{node,predicate}, ship_claims`；顶层 + 每级对象**任何 unknown key 拒**（nested 一并）。
校验：schema_version ∈ 支持集 · 唯一可达节点边 · 恰一起点 · 合法终点=gate 节点 · 只允许**声明的 loop 边**（回边只
能来自 `loops[]`）· 出边条件**互斥完备** · loop 四要素必填 · 能力-模型-厂商相容 · 非法 skip 拒 · **handoff 只准
指针字段（拒内联全文）** · **统一词汇映射表**：决策结果→claim predicate→边条件（消 `qa_fail`/`qa_failed` 混用）。
**三份 exact manifest = repo YAML 种子文件**（`packages/teamlead/src/workflow-seeds/tpl_eng_{heavy,light,trivial}.yaml`，
含全部 node/edge id、condition、handoff_pointer、terminal_gate、ship_claims、冻结 model id）—— 作为 commit C
的具名交付物，与 loader/importer 同 PR 落地，不留省略。

### 5.4 物化 snapshot 函数 + per-run override schema（R4#4 —— 定义 override 精确面）

admission 选 published revision（**一次**）→ 套 per-run override → 整体复验（skip/豁免/跨 family）→ 钉 run；
此后一切派发/重试/对账只读钉住的 snapshot。

**per-run override 精确 schema（Q1=A：Lead 派发时可覆盖，能力字段结构上不在覆盖面）**：
```
override: {
  reason: str,                                   # 必填,落 snapshot + 审计(Annie「理由可见」)
  nodes?: { <nodeId>: { model?: str, effort?: 'low'|'medium'|'high'|'xhigh', skip?: bool } } }
```
**允许改**：节点 `model` / `effort` / `skip`。**禁止改**（结构上不在 schema）：节点 `type`、边、loop、
`terminal_gate`、`ship_claims`、`vendor`（vendor 改会破跨 family 不变量 → 不给覆盖）。
- **`skip` 的处置（R5#2 —— 避开 manifest unknown-key 冲突）**：`skip` **不进 manifest 节点 schema**（§5.3 unknown-key
  会拒），而是**独立 overlay**，在 **manifest 校验之前**消化：override overlay 决定哪些节点被 skip → 生成一个**已消化
  overlay 的 effective 图** → 该图**再**跑 §5.3（不含 skip 键的纯 manifest 校验，验非法-skip 是否越界）+ §5.5
  family 校验。effective-snapshot 里不残留 `skip` 键。
- override（含 reason）落 `workflow_run.snapshot` + `workflow_template_audit`（action=`run_override`，run_id + reason）。

### 5.5 家族校验 + 种子跨 family 可满足性（Codex R1#10 —— 用现有事实澄清）

**代码事实**：`packages/config/src/review-family.ts` 的 `crossFamilyReviewSatisfied` + `adapterTypeToFamily`
已是全队跨 family 规则；FLY-1224 phase 表已定：**Claude 作者→Codex 审；Codex 作者→Claude 审**（Opus xhigh）。
故 implement=codex 时代码审 = **Claude**，不是 codex 自审。

**B 的种子 ship-gate claim = `qa_passed` + `founder_approved`**（两者可满足：heavy 的 qa=claude≠implement=codex；
founder=challenge）。**`codex_approved` 不作为 B 种子的必需 ship claim**——代码审仍走**现有 FLY-827
`crossFamilyReviewSatisfied` gate**（未进 claims 账本，本单不改）。避免 R1#10 的「不可满足 codex_approved 路径」。

**admission 家族校验 = 新的 author-vs-reviewer 比较器（R2#7/R3#9，不复用 crossFamilyReviewSatisfied）**：
`crossFamilyReviewSatisfied` 是**遗留 review-record verdict 函数**（带 `status/skipped` 语义），不是模板
admission API。本单新增 `manifestReviewFamilyOk(authorResolvedFamily, reviewerResolvedFamily)`：入参是
**服务端从已解析 backend/model 派生的 family**（经 `adapterTypeToFamily` **仅取词汇**——**绝不信 manifest 自报
vendor**，manifest vendor 只是意图，权威 family 来自解析后的 executor backend），判 reviewer family ≠ author
family。**种子级可达性测试**：每条**要求 review claim** 的边都有**跨 family issuer** 可达（本单种子 ship_claims
无强制 review claim → 该测试对种子空过，但比较器 + 正负单测（Claude 作者→Codex 审过 / Codex 作者→Codex 审拒）
齐全供子单 D）。

### 5.6 三份种子 manifest（精确阵容，无省略；模板 #1 修订）

| template_id | 档 | design | implement | qa | 回头边 | ship claims |
|---|---|---|---|---|---|---|
| `tpl_eng_heavy` | 重活 | {claude, claude-fable-5} | {codex, gpt-5.6-sol, xhigh} | {claude, claude-opus-4-8} | qa→implement {loop_when:qa_fail / exit:qa_pass / max:3 / on_limit:escalate} | qa_passed + founder_approved |
| `tpl_eng_light` | 轻活 | {codex, gpt-5.6-sol} | {codex, gpt-5.6-sol} | {claude, claude-opus-4-8} | 同 | qa_passed + founder_approved |
| `tpl_eng_trivial` | 琐事/冒烟 | {codex, gpt-5.6-sol}（design 段不许重）| {codex, gpt-5.6-sol} | {claude, claude-fable-5}（独立 QA 节点，轻模型，**不删节点**）| 同 | qa_passed + founder_approved |

- 三档 qa 均 claude（跨 family 满足 E6 且 QA=一等节点，trivial 用轻模型≠删节点）。
- Dashboard = 静态菜单（模板表）；Lead 点菜 = 选模板 + per-run override 带 reason。
- 交接指针进 manifest `handoff_pointer` + 校验拒内联全文（FLY-1236 准绳）。
- **精确 model id 冻结**：`claude-fable-5` / `gpt-5.6-sol`(effort xhigh) / `claude-opus-4-8`（= `three-stage-phases.ts`
  `DEFAULT_PHASE_DISPATCH` 真值；rename 一行 diff）。

### 5.7 founder 写面边界（Codex R1#9 —— defer mutation endpoint）

**B 只交**：StateStore 写 API（seed 导入 = **boot system 权限，非网络 endpoint**；发布 CAS API）+ **只读路由**
（模板/版本/绑定查询）。**founder 变更 endpoint（create/publish/rebind）defer 到 FLY-1038**（它有真
founder-authed 浏览器 session）——loopback+same-origin+confirmToken 是 CSRF 防护非身份边界，sibling runner
能连 Bridge 就能 stage+apply（`isSameOrigin` 虽拒 no-Origin，但 Origin 头非机密可伪造）。**负测**：同用户
本地进程无法经 B 的路由 stage/apply 一次模板变更（因 B 不挂 mutation endpoint）。

### 5.8 commit C 步骤序（TDD）

RED：DDL 逐列 + trigger 拒改；发布 CAS/append-only/幂等（含 founder-改过拒 repoint）/409；manifest 校验清单
逐条正负；三种子 admission 正测 + 同 family 负测 + 可达性；物化 snapshot（选版→override 带 reason→复验→钉）+
审计；只读路由；mutation endpoint 缺席负测。GREEN：表族 + StateStore API + loader/校验器 + 物化 + 只读路由 +
三种子 manifest + YAML 种子文件。REFACTOR：词汇映射表单一真相。

## 6. ⛔ Gate-0（实现前置）+ 部署前置 checklist（PR 描述必须醒目呈现，Tadashi 核对）

**Gate-0（commit B 实现/merge 前必须闭合，R3#1/#10）**：
- [x] §4.1 transport 治理决策**已签署 = 选项 B**（Tadashi 2026-07-14，伞单 §2.2 修订已授权，§2.1a 落地）。
- [ ] 选项 B 的**可执行 schema/API**（§4.1b `workflow_submission_credential` 选项-B 形态 + §4.2b
  `workflow_execution_binding`）+ macOS 平台矩阵 + §7 选项-B 负测结果落 Gate-0 制品。
- [ ] **生产 READ=1 的两个硬前置**（缺一不上生产）：① fresh-spawn E2E（FLY-1232 pin 7b8255cf）② **peer-cred 加固
  follow-up 已落**（恢复伞单原 §2.2 隔离，Tadashi 直令 3）。**本单只交收窄形态 + READ 保持 off**。

携带本单的 Bridge 重启前，**二选一**（fail-safe 顺序，绝不裸上）：
- [ ] **(a) 生产开 READ**（`FLYWHEEL_WORKFLOW_CLAIMS_READ=1`）—— **仅当两个硬前置都过**（R4#1，Tadashi 直令 3）：
  ① fresh-spawn E2E（7b8255cf）+ `FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1` **②peer-cred 加固 follow-up 已落**（恢复
  伞单 §2.2 隔离）**且**目标三段式 run 走了 §4.5 admission enrollment。**本单交付时前置②未落 → (a) 不可选，READ
  保持 off；** **或**
- [ ] **(b)** 过渡期把 `FLYWHEEL_WORKFLOW_FORCE_LEGACY=1` 写进生产 `~/.flywheel/.env`（**live-`.env` 即时对
  长命 runner 生效**，§4.4）——**本单的实际部署路径 = (b)**（READ off，三段式 run 走 FORCE_LEGACY 旧布尔，
  否则 §4.2 (e) 对 durable 三段式 fail-closed 卡 ship）。
- [ ] 三 flag + enrollment 现状/目标态 + **Gate-0 治理决策（=选项 B）与选项-B 负测结果**在 PR 描述列清。
- [x] 红测机器无关项已确认：验收测试显式钉
  `FLYWHEEL_WORKFLOW_FORCE_LEGACY=0`，因此不受开发机 live `~/.flywheel/.env`
  污染；生产部署路径 (b) 是有意的 emergency rollback，打开时明确回到旧布尔路径。

## 7. 一次真机 E2E + sanitized OS 证据（Codex R1#15；R3#4 —— 负测按治理选项分支）

隔离环境（**非生产** `FLYWHEEL_STATE_DIR`，遵「Runner 绝不 host 上跑 provisioning 测试」）：
1. `WRITE=1 + READ=1` + admission enrollment，起真三段式 fresh-spawn；
2. QA 节点经 §4.1 **选定交付路径**提交 → **权威 head resolver（§4.3b）**捕获 head → 写 `qa_passed` claim；
   ship gate 读账本放行；
3. head 前进后旧 claim 失效卡 ship（E2）；re-QA 后放行；
4. **§4.1 负测（治理已定 = 选项 B，只测选项 B，R4#4/#6 —— 绝不重复被证伪的声明）**：
   **明确记录**「凭证生命期内同用户 sibling 可伪造 B 的 PASS」= 已知接受残留（§11b）；只测**仍成立的**保证:
   server 选定 head（非自选）、精确重放幂等、mismatched/无凭证拒。**不测、也不声称** head-binding 挡得住 verdict
   伪造。out-of-scope 项（send-keys 主动注入）不测但报告注明。（选项 A 的「产不出/重放不了」证据 = peer-cred
   follow-up issue 的 E2E，不在本单。）
5. **sanitized 证据脚本** `scripts/qa-fly-1244-os-proof.mjs`：只记 **boolean/key-name（绝不记值）**——snapshot
   持久化、tmux 可见性、peer-cred、argv/env 暴露、选定交付路径；**平台/runner 版本变了证明不再成立 → E2E 失败**。

## 8. 验收矩阵（QA 逐格核；映射 S1-S16 + E1-E6）

| # | 用例 | 期望 | 映射 |
|---|------|------|------|
| E1 | 红测 | 变绿（走 (e) fail-closed，断言原文） | S8 |
| E2 | QA 对 H1 PASS 后 head→H2 | ship gate 拒；kickback 新 attempt 对 H2 PASS → 放行 | S8/S9 |
| E3 | (a) 精确同 payload 重放 consumed；(b) 异 payload/过期/旧 attempt/冲突；(c) 伪 subject/无凭证 | (a) 幂等返回既有 claim；(b)+(c) fail-closed | S8 |
| E4 | 突变共享 writer 或任一路由边 | 突变测试红 | S1-S2 |
| E5 | 遗留 run（(c) 分支） | ship gate + Auto-QA 字节不变 | S3-S7 |
| E6 | 同 family review claim | admission 拒 + claim 层拒 | S10 |
| TT | §4.2 真值表五情形 (a)-(e) | 逐格判定正确；(e) 永不 qa_not_required | S8 |
| BIND | §4.2b execId→run→node 唯一绑定 | 同 issue 两 run/重复 attempt/stale/缺/损坏绑定全 fail-closed | S8 |
| CRED | §4.1b 单事务 credential + 恢复 | claim commit 后 response 丢失 + Bridge 重启后精确重放收敛同 claim；mismatched 拒 | S8 |
| L1 | §4.1 负测（选项 B）：明列残留 + 删 L1 假声明 | server 选定 head/精确重放/mismatched 拒；PASS-forge 残留记录在 §11b（不声称 head-binding 阻 verdict 伪造） | S8 |
| FC | FORCE live-`.env` 五组 | 长命 runner flip 即时生效 | S8 |
| RQ | §4.5c re-qa（design/implement 继续相位→handoff 建新 QA；仅在飞无凭证 QA 被 supersede 重起） | 相位安全，不提前起 QA/不抢 TURN；旧无凭证 attempt 不可追认 | S8 |
| HEAD | §4.3b 单一 head 权威贯穿提交面 + 每个 ship sink + **CLI verify-approval** | CLI 传 H1 而权威 worktree H2 → 拒；各 sink 用同一 head 权威 | S8 |
| AUTH | §3.2 founder_approved allowlist | 仅 isTrustedApprovalAttribution 的 approved:true 投影；feedback/audit-Lead 不投影 | S1-S2 |
| T1 | 跨库目的地幂等 receipt + 三 crash 窗口 + TURN 不双 epoch | 精确重放 no-op / digest 不符拒 / 无重复 founder claim / TURN 一 source 一行 | S1-S2 |
| M1 | 模板 DDL/trigger/发布 CAS/幂等（含改过拒 repoint）/409 | 逐条成立 | S11-S16 |
| M2 | manifest 校验清单逐条 + 三种子 admission + 可达性 | 正过/负拒 | S11-S16 |
| M3 | 物化 snapshot 选版→override(reason)→复验→钉 + 审计 | 成立 | S11-S16 |
| M4 | mutation endpoint 缺席 + 只读路由 | 同用户进程 stage/apply 不能；只读可查 | S11-S16 |

## 9. 文件清单（预期改动）

**commit A**：`flywheel-comm/src/db.ts`（CommDB 两表 + approval/TURN 专用方法 + 事务内附写 source）·
`teamlead/src/StateStore.ts`（`applyWorkflowSourceEvent` 目的地幂等）· `teamlead/src/bridge/approval-signal/
write-gate-response.ts`（增强为 `writeFounderApproval` typed 结果）· `actions.ts` / `founder-consent/
gate-response-router.ts` / `voice-routes.ts` / `founder-reaction-approval-handler.ts` / deferred（改路由经共享
writer）· `teamlead/src/bridge/founder-approval-projector.ts`（新，唯一 founder-claim 写者）· 各 `__tests__`。

**commit B**：`flywheel-comm/src/ship-eligibility.ts`（§4.2 真值表 + FORCE live-`.env`）·
`flywheel-comm/src/workflow-claim-read.ts`（新，SQL 解析 + 契约测试目标）· `flywheel-comm/src/commands/
qa-result.ts`（提交面 + 不透明 marker）· **`codex-review-result.ts`（仅 marker 洗成不透明，**不**接 capability，
§4.5b）** · `teamlead/src/StateStore.ts`（§4.1b `workflow_submission_credential` 表 + `submitWorkflowDecisionByCredential`
单事务 + §4.2b `workflow_execution_binding` 表 + §4.5 enrollment CAS）· `teamlead/src/bridge/
workflow-capability-broker.ts`（新，§4.1 提交面 + Bridge 内部 mint/consume + Gate-0 选定交付 + 恢复状态机）·
**新 shared head-authority resolver（§4.3b）+ 其在 plugin 组装 / merge-ship-gate / event-route / DirectEventSink /
complete-marker-reconciler / external-merge-reconcile / recovered-merge finalization 的接线** ·
`teamlead/src/bridge/run-dispatcher.ts` + admission/mint seam · **re-qa Bridge API 路由 + 注册（§4.5c）** ·
**`flywheel-comm/src/commands/verify-approval.ts` + index + runner-wake + runner-Lead 契约（§4.3b CLI head 权威）** ·
**`flywheel-config` 下沉 `canonicalSubmissionDigest`（§3.3 两侧共用，单一 home）** ·
`auto-qa-coordinator.ts`（enrolled verdict 走 capability；非 enrolled 不变）· 各 `__tests__` +
`scripts/qa-fly-1244-os-proof.mjs`。
> ⚠️ §4.3b 的 ship-面接线触及多个 finalization sink——实现期若某 sink 的 head 来源改造超出预期，先回 Lead 再动。

**commit C**：`teamlead/src/StateStore.ts`（§5.1 表族 DDL + **CREATE TRIGGER**/CHECK + 发布 CAS + 物化 snapshot）·
`teamlead/src/workflow-templates.ts`（新，schema + 校验 + 词汇映射 + `manifestReviewFamilyOk` 家族校验 + 三种子 manifest）·
`teamlead/src/bridge/workflow-template-routes.ts`（新，**只读**路由）· `packages/teamlead/src/workflow-seeds/
tpl_eng_{heavy,light,trivial}.yaml`（三份 exact 种子 YAML）· 各 `__tests__`。

**doc-first 授权变更（R4#6 —— 命名交付，非口头「实现期改」）**：
- **伞单 `engineering/doc/FLY-1135-layer1-dag-templates/plan.md` §2.2 同步落 §2.1a 三段式收窄修订**（Tadashi 授权）。
- **本单 `research.md` §D 标注 superseded**：其「spawn-env 交付使 sibling 伪造失败」结论被 R2#1（head-binding 不
  认证 verdict）+ 选项 B 裁定推翻——保留原文但加 superseded 抬头，指向本 plan §4.1/§2.1a。

`REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts`（58cecc1f 原样）· 本三件套 + progress。
若发现读切换/broker 需触碰计划外 Blueprint/adapter 代码，先回 Lead 再动。

## 10. 与后续子单接缝（defer 清单，Codex R1#12/#14）

| 接缝 | 归属 |
|------|------|
| `workflow_node_outputs` + `materialize` kind 副作用状态机（product 线）**整块 defer** | product 线子单（本单完全不碰，R1#12） |
| 模板 founder **变更 endpoint**（create/publish/rebind，真 founder auth） | FLY-1038（R1#9） |
| `claim_written` event/outbox 作为编排**唯一触发器** + startup replay + exactly-once | 子单 D（R1#6） |
| 家族校验**派发接线** + 注册表迁移 + orchestrator 按 snapshot 解释 + 模板派发启用 | 子单 D（FLY-1224 已 ship） |
| node-id 生命周期 8 面 + generic 契约 + Blueprint capability 门控 | 子单 C（原⑥） |
| **原生 peer-cred broker / 独立 OS principal（恢复伞单原 §2.2 隔离不变量）** | **follow-up 新 issue，挂 FLY-1135 伞下，且是 READ 上生产的硬前置**（Tadashi 直令 3；§6 Gate-0 守） |
| codex/agy/kimi 的 capability 已证明路径 | 后续（本单只证 claude / 收窄模型） |

## 11. 风险与对策

1. **爆炸半径**（④ 动 ship gate 主路径）：真值表 (c) 字节兼容 + 突变测试 + FORCE live-`.env` + 红测锁死 +
   三-commit 内部 gate（READ 生产 off 直到全矩阵过）。
2. **交付通道（选项 B）**：per-execution 凭证经 spawn env 落 snapshot 是**接受的收窄残留**（§11b）；主修
   （§4.3 head-binding + §4.1 退役共享 bearer）已定；READ 上生产硬前置含 peer-cred 加固（§6 Gate-0）。
3. **跨库半写窗口**：source 与权威写同 CommDB 事务 + 目的地幂等 receipt + 三 crash 窗口测试；B 不把异步
   投影用于放行，现行 USE-time 权威仍由 CommDB response + session/head binding 复验。
4. **1204-split rebase 成本**：§4.7 file/symbol range-diff，不盲 cherry-pick。
5. **威胁模型过度声称**：§2.1/§2.1a 收窄 + plan/代码注释不得声称更强隔离 + out-of-scope 明列 + §11b 已知限制。
6. **doc drift**：符号/语义定位，不锚行号。

## 11b. 已知限制（Tadashi 直令 4 —— 接受项，非缺陷）

1. **同用户 sibling 在凭证 TTL 窗口内可伪造某 execution 的 PASS**：单用户 fleet 下 per-execution 凭证经 spawn
   env 送达、落 shell-snapshot 同 uid 可读。这是**已知接受残留**（§2.1a 收窄不变量的代价），非缺陷。**恢复原
   §2.2 隔离不变量的 follow-up = 原生 peer-cred broker / 独立 OS principal**（挂 FLY-1135 伞下，READ 上生产硬前置）。
2. **同用户主动 pane 注入（`tmux send-keys` + `capture-pane` 驱动 B 用它的凭证）**：既有单用户 fleet 属性，
   移出本单 scope，同 follow-up 收敛。
3. 本单只证 **claude** backend 的收窄交付路径；codex/agy/kimi 的已证明路径后续单独做（三段式 QA 现值 claude/opus，够用）。

## 12. 开放项

**无 —— 唯一曾开放的 §4.1 transport 治理决策已由 Tadashi（FLY-1135 伞单 owner）拍板（2026-07-14，gate
`question`）：选项 B**（治理接受收窄威胁模型 + 正式修订伞单 §2.2，已授权；已知会 Annie，未阻塞）。五条落定
要求全部折入（§4.1 + §2.1a §2.2 修订 + §11b 已知限制 + §6 Gate-0 双前置 + §10 peer-cred follow-up）。

历史收口：brainstorm gate 4 决策 + 决策 2 机制修订 + Codex design R1（10 HIGH）+ R2（5 HIGH/4 MED）+ R3
（4 HIGH/5 MED/1 LOW）全采纳/明确 defer。§4.1 已定稿 → 交末轮 Codex design review 求 APPROVED。
