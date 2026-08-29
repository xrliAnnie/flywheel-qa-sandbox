# FLY-1244 执法层 — 技术调研

Issue: FLY-1244 (https://linear.app/geoforge3d/issue/FLY-1244/build-dag-模板引擎-子单b原-执法层founder-guard-收口-claims-读切换红测变绿-模板)
日期: 2026-07-14
基于: exploration.md

调研目标：为 ③④⑤ 三块交付逐一落到具体文件/函数/证据，并把 brainstorm gate 里我
凭直觉写的机制（尤其决策 2 的 capability 下发）用真机 OS 事实校正。**结论优先级**：
Layer 1 复用现成（A substrate / FLY-245 broker 原则 / ship-eligibility 结构）；Layer 3
第一性——决策 2 的认证因子必须按本机可验证的 OS 行为重定。

## A. 基底：FLY-1232 已交付的 substrate（复用面）

`packages/teamlead/src/workflow-claims.ts`（151 行）+ `StateStore.ts` 已有：

| API | 用途 | 本单如何用 |
|---|---|---|
| `issueWorkflowDecisionCapability({runId,nodeId,executionId,attempt,allowedPredicateFamily,expiresAt,absoluteDeadlineAt})` → `{token, capabilityId}` | 签发一次性凭证（只存 sha256，明文只返回一次），deadline cap 已强制 | ④ QA/codex verdict 前，Bridge 内部签发 |
| `submitWorkflowDecisionClaim({token,clientRequestId,predicate,subjectKind,subjectDigest,issuerVendor,issuerModel,...})` | 单事务：验票→写 claim→核销→追加 run_event；E3 同 payload 幂等重放 | ④ verdict 提交时 Bridge 内部调用 |
| `appendWorkflowSystemClaim({issuerKind,predicate,subjectKind,subjectDigest,...})` | bridge_policy=qa_exempt / founder_challenge=founder_approved，allowlist + subject_kind 强制已在 | ③ founder_approved 系统 claim；⑤ 入口 qa_exempt |
| `resolveWorkflowDecisionClaim({runId,nodeId,decisionKind,subjectKind,subjectDigest})` → `{valid, reason}` | §2.1 解析算法：最高 attempt+server_seq 候选→验吊销/过期/冲突/pass，绝不回落旧 attempt | ④ 门解析（**但 flywheel-comm 侧要复现，见 D**） |
| `applyWorkflowShadowBatch(...)` | 唯一复合事务面（run/node/event/side_effect） | ⑤ 物化 snapshot + outbox（若接） |

闭合词汇（`WORKFLOW_CLAIM_PREDICATES` / `WORKFLOW_DECISION_FAMILIES` / `SYSTEM_CLAIM_ALLOWLIST`
/ `REVIEW_CLASS_PREDICATES` / `PASSING_PREDICATES`）+ 3 个 default-off flag helper 已在。
本单**不重写 substrate**，只接线读/写路径 + 补 §2.4b 跨库表 + ⑤ 模板表族。

## B. ④ 读切换：红测与 ship gate 的精确落点

### B.1 红测（唯一验收线）

`origin/fly-1204-split` commit `58cecc1f` →
`packages/teamlead/src/__tests__/REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts`。断言（原文，不许弱化）：
- session_role=qa ∧ chat_thread_role=qa 的行，`qa_required=0` 是 write-once，head 从 H1 前进到 H2 后，
- `evaluateQaShipGate({execId, prHead:H2, env:{FLYWHEEL_QA_DONE_GATE:'1'}})` 必须 `passed=false`
  且 `reason !== 'qa_not_required'`。
- **env 只带 `FLYWHEEL_QA_DONE_GATE=1`，不带任何 workflow flag** ⇒ 三段式身份停认 `qa_required=0`
  必须是**无条件**行为（不吃 `FLYWHEEL_WORKFLOW_CLAIMS_READ`）。这直接印证决策 1。

### B.2 现状 gate（要改的点）

`packages/flywheel-comm/src/ship-eligibility.ts:182` — `evaluateQaShipGate`：
```
if (qaRequired === 0) return { passed: true, reason: "qa_not_required", qaRequired: 0 };
```
读 `sessions.qa_required`，=0 直接放行，不看 `session_role`。**这就是红测捕获的洞。**

### B.3 改造（读切换）

`evaluateQaShipGate` 增一个前置分支：**当会话是 durable 三段式 QA 身份**（读同一 readonly 连接的
`sessions.session_role='qa' AND chat_thread_role='qa'`）时，`qa_required=0` 不再直接放行——
改走 claims 账本解析（§2.1 算法）查**当前 head** 的有效 `qa_passed` claim：
- 有有效 `qa_passed`（subject=git_head 匹配 prHead）→ pass；
- 无/过期/吊销/FAIL/head 不匹配 → fail-closed，新 reason（如 `qa_claim_missing_failclosed`）。
- `FLYWHEEL_WORKFLOW_FORCE_LEGACY=1`（进程 env）→ 应急回退到旧布尔路径。

字节兼容：非三段式身份（真·单 session main run）行为一字不变（走原 `qa_required` 布尔）。
红测传显式 env 对象 ⇒ hermetic，不受机器 `.env` 影响。

### B.4 依赖方向约束（重要）

`flywheel-comm` **不能 import `teamlead`**（包依赖反向）。但 `evaluateQaShipGate` 已经用
`better-sqlite3` 直接 readonly 打开 teamlead.db（`resolveStateDbPath`）——所以它**能读**
`workflow_claims` 表，只是**不能复用** `StateStore.resolveWorkflowDecisionClaim` 那段 TS。
⇒ 在 flywheel-comm 侧以**只读 SQL 复现** §2.1 解析算法（最高 attempt+server_seq→吊销/过期/
冲突/pass），并加一条**跨实现契约测试**：同一组 claim 行喂给两侧（StateStore 方法 vs
flywheel-comm SQL），逐 case 断言 verdict 一致（回落禁止、冲突、过期、吊销全覆盖）。

### B.5 claim 生产者接通（verdict → claim）

现状：`flywheel-comm qa-result`（238 行）POST `/events`（`event_type:"qa_result"`，共享
`FLYWHEEL_INGEST_TOKEN` bearer，payload 自报 `targetExecutionId/qaExecutionId/prHeadSha`）→
`AutoQaCoordinator.onQaResult`。**这就是红测结构原因 #2**（共享 bearer + 自报 exec/head 双可伪）。
enrolled 三段式 run 的 QA/codex verdict 改经决策 2 的能力路径写 `qa_passed`/`codex_approved`
claim（subject=服务端捕获的 head）；非 enrolled 保持旧 `qa_result` 路径字节不变。

### B.6 1204-split 存量吸收（path/hunk 矩阵，伞单 §2.4）

| commit | 取舍 |
|---|---|
| `58cecc1f` 红测 | 原样落本分支（唯一验收线） |
| `61593e8a` ship-path deadlock（QA phase owns PR head） | 只取 QA-head ownership hunks（它回退了 `4975ee0d` 的文件——冲突处以此为准） |
| `4975ee0d` retry admission 测竞用 worktree | 取**最终实现** |
| `40405388` PR-head ownership decides Codex gate | 整体吸收 |
| `8c24044f`+`b3457180` evidence-not-marker | 整体吸收 |
| `0a06fe3e` settle qa_required past premature approval | 由账本取代（记录取代关系，不再需要旧修补） |

最终合成树断言：`58cecc1f` 红测逐字节跑 + parked 分支 worktree/retry 测试对合成树全绿。

## C. ③ founder guard 收口 + 跨库投影

### C.1 直写点盘点（要收口的）

| 写入点 | 位置 | 现状 |
|---|---|---|
| `approveExecution` | `actions.ts:188` | 直写 CommDB `insertResponse`（有 FLY-191 顺序修正 + FLY-1041 绑定校验，但无 hold guard） |
| founder-consent gate-response | `founder-consent/gate-response-router.ts:349` 附近 | consent evaluator 后直写 `insertResponse`，无 hold guard |
| text/reaction/voice hold guard | plugin.ts 建闭包注入 → voice-routes / founder-ship-approval-handler | **生产接线是真的**（伞单 R1#8 已校正；注释是依赖契约文档不是站岗） |

hold 谓词 `isReviewHeld`（`auto-qa-held.ts`）= codex gate hold ∨ QA hold，已被 event-route /
GatePoller / Heartbeat 三点消费。③ 的收口 = 把 hold 检查放**最窄共享 pre-write 边界**（两个
直写分支进 CommDB 前的共用函数），直写例外路径保留纵深防御；沿用 FLY-1099 语义
（codex_pending/qa_not_green→defer，merge_block→reject），保留唯一 kill-switch。

### C.2 突变测试（摘真实接线，不摘注释）

逐权威路径摘 guard → 断言测试变红：actions / founder-consent(off|audit|enforce) / text /
reaction / voice / deferred replay / 同决策重试 / 应急旁路。

### C.3 founder_approved 进账本

founder approval 经 server-owned source event（issuer_kind=`founder_challenge`，
`appendWorkflowSystemClaim` 现成，subject_kind 强制 git_head 已在）投影 `founder_approved` claim，
subject=pr head。founder 不持 runner 凭证（伞单 R1#4）。这里的 `founder_challenge` 是 issuer 分类标签，
不是 nonce/challenge 协议；本单 claim 只作审计投影，**不参与 ship 放行**。`verify-approval` 继续以 CommDB
response、session/head binding 为权威（双读期不切）；claim-driven founder 执法切换归后续子单 D。

### C.4 跨库投影（§2.4b）

**权威库事实**：TURN 与 founder approval 的权威在 per-project **CommDB**（better-sqlite3，
`this.db` 支持 `.transaction()`——已验证类结构）；claims 账本在 **teamlead.db**。跨库无原子性。
- 正解：source event / outbox 行写进**与那次权威写同一个 CommDB 事务**——`insertResponse` 与
  `grantTurn` 各自的事务内附带写 `workflow_source_event` + `turn_source_history`（append-only）。
- `grantTurn`（db.ts:929）现覆盖单行 + epoch++，中间交接从终态行无法重建 ⇒ 必须补 append-only
  `turn_source_history`。
- projector 按 `(project, source_event_id)` 幂等投影进 StateStore。
- 双读期：`verify-approval` / runner TURN 读只在双读期之后切换（本单不切读侧）。
- 新表（CommDB 侧）：`workflow_source_event(project, source_event_id, kind, payload, at)` +
  `turn_source_history`（append-only）。

## D. 决策 2：capability 下发通道 —— 真机 OS 事实校正（Layer 3）

> **SUPERSEDED（2026-07-14）**：本节保留首次 OS 调研原文作决策轨迹，但其中「spawn env
> 对同用户不可读，因此 sibling 不能伪造 PASS」的结论已被后续 R2#1 推翻：shell snapshot 会持久化
> spawn env，且 head-binding 只保证 subject integrity，不认证 verdict。最终治理以 `plan.md` §2.1a /
> §4.1 为准：选项 B 是单 execution + 短 TTL 的爆炸半径收窄，不是同用户隔离；恢复原不变量依赖
> peer-credential broker / 独立 OS principal follow-up。

brainstorm gate 里我写的机制是「unix socket broker + LOCAL_PEERPID→进程树→pane→execution
校验」。**本机实测推翻了 peer-pid 那一半**，得到一个更简单且同样强的机制：

| 实测（2026-07-14, macOS 26.3.2, node net） | 结果 | 影响 |
|---|---|---|
| node `net` 服务端连接对象暴露 peer 身份？ | ❌ 只有 `_handle.fd`，无 pid/cred/peer | LOCAL_PEERPID 方案纯 node 不可行（需原生 helper，徒增攻击面与风险） |
| 同用户读别的进程 env 值？（`ps -Eww`/`ps eww`） | ❌ 脱敏（值为空） | **spawn env 注入的 per-execution 秘密同用户读不到** |
| `tmux show-environment -t <victim>` 泄露 pane 子进程 spawn env？ | ❌ 不泄露（只显式 set-environment 的会话变量） | 兄弟 runner 查 tmux 也拿不到 |

**修订后的 claude-tmux 已证明路径**（已 ask 报 Tadashi，属其批的信封内的强化）：
1. adapter 在 runner **spawn env** 注入一个**每 execution 一次性 bootstrap 凭证**（替掉共享
   ingest bearer——仅对 enrolled run 的 verdict 提交）；env 值同用户不可读（实测）。
2. runner 用它调 Bridge **专用 capability 提交面**，带 verdict payload；
3. **Bridge 内部** mint（`issueWorkflowDecisionCapability`）+ consume（`submitWorkflowDecisionClaim`），
   服务端捕获 subject（head），写 claim；**原始 capability token 永不离开 Bridge 内存，runner
   从不持有**。
4. bootstrap 凭证约束：单次消费、短 TTL、绑定恰一个 (run,node,execution,attempt)；**只经 spawn env
   注入，绝不 `tmux set-environment` / 不进 argv / 不落文件**。
5. qa-result marker（现存了完整 body）改存**不透明请求 id**，不存明文 payload。
6. codex/agy/kimi **无已证明路径 → admission 拒**（fail-closed）；三段式 QA 节点现值 claude/opus，够用。

**R2#2 负测（必须真做）**：runner A 已知 B 的 exec-id/head + 能枚举 `~/.flywheel` + 能
`tmux show-environment -t B` + 能连 Bridge，**仍拿不到 B 的 bootstrap 凭证 → 提交不了一个有效的
B 决策**。治的靶 = 共享 ingest bearer + `--exec-id/--pr-head` 双可伪（红测结构原因 #2）。

> 备选（若未来 codex 也要覆盖）：codex 的 workspace-write 沙箱**阻断 connect()**（FLY-245
> secret-broker 依赖的正是这条边），故 codex 的证明路径走 unix-socket broker——但本单不做。

## E. ⑤ 模板 schema / loader / 发布契约

### E.1 表族（完整 DDL，teamlead.db；伞单 §3.1b）

`workflow_template`（current_published_revision 指针）· `workflow_template_revision`（manifest
字节不可变 + BEFORE UPDATE/DELETE trigger）· `workflow_template_publication`（append-only 发布事件）
· `workflow_category_binding`（project+task_category→template_id）· `workflow_node_outputs`
（(run_id,node_id,attempt) + output_digest，**本单只交 DDL + 状态机原语 + 测试**，product runtime 归后续）。

### E.2 发布契约

revision 字节不可变；发布 = append-only publication 行 + **原子 CAS** `current_published_revision`
指针（**不改 revision 行 status**）；DB trigger 禁改已发布 manifest 字节；种子导入按 content-hash
幂等**绝不静默 repoint founder 改过的模板**；并发 stale-edit 409；founder 写面 = loopback +
same-origin + confirmToken + audit（fleet-console 模式，参照 `fleet-console.ts` / `fleet-admin.ts`）。
UI 归 FLY-1038（本单只交 StateStore API + 最小 endpoints）。

### E.3 manifest 规范 schema + 校验清单

normative schema（schema_version / node `{id,type,vendor?,model?,effort?,agent_file?}` / edges /
loop 四要素）+ 校验：唯一可达节点/恰一起点/合法终点与 gate 节点/只允许声明的环/出边条件互斥完备/
loop 四要素必填（`loop_when`∈{qa_fail,founder_feedback_kickback} + 出环 + `max_iterations` +
`on_limit`）/能力-模型-厂商相容/非法 skip 拒/**指针交接字段**（handoff 输入=worktree+design doc 指针，
拒内联全文 prompt 字段）。统一词汇映射表：决策结果 → claim predicate → 边条件（消 qa_fail/qa_failed 混用）。

### E.4 物化 snapshot 函数

admission 选 published revision（一次）→ 套 per-run override（必带 reason）→ 整体复验（含 skip/
豁免/跨厂商 family）→ 钉 run；此后该 run 一切派发/重试/对账只读钉住的 snapshot。

### E.5 家族校验（决策 3c）

规范 review-family 枚举 {claude, codex} + 从**已解析执行 backend/model** 映射（`adapterTypeToFamily`
同口径，绝不信 manifest/runner 自报）；带 review 语义的节点与其上游作者节点同 family → admission 拒。
**本单交校验函数 + 种子正负测；派发时调用接线归子单 D。**

### E.6 三份种子模板（模板 #1 修订，决策 4）

| template_id | 档位 | design | implement | qa | 回头边 |
|---|---|---|---|---|---|
| `tpl_eng_heavy` | 重活 | {claude, fable} | {codex, gpt-5.6-sol, effort:xhigh} | {claude, opus} | qa→implement {qa_fail/qa_pass/max 3/escalate} |
| `tpl_eng_light` | 轻活 | {codex, …} | {codex, …} | {codex, …}（跨 family 用不同上游作者 or 保留 claude qa 满足互审）| 同 |
| `tpl_eng_trivial` | 琐事/冒烟 | 轻模型 design（不许重）| {codex, …} | 独立 QA 节点用轻模型（**不删节点**）| 同 |

⚠️ 跨厂商互审不变量：`light`/`trivial` 全 Codex 时，review 节点与其上游作者节点不能同 family——
需在 manifest 设计里让 qa/review 的 producer≠reviewer vendor（heavy 天然满足 implement=codex≠qa=claude）。
E.5 校验 + 种子正负测会钉住；`light`/`trivial` 的精确阵容在 plan 的 manifest 样例里定死并过 admission 正测。
Dashboard = 静态菜单（模板表）；Lead 动态点菜 = 选模板 + per-run override 带 reason（理由可见）。

## F. 交付顺序与 flag（伞单 §3.2 映射到本单）

本单 = 伞单 PR-3(③) + PR-4(④) + PR-5(⑤) 合成一个 PR。flag 分立：`FLYWHEEL_WORKFLOW_CLAIMS_WRITE`
（写路径）/ `FLYWHEEL_WORKFLOW_CLAIMS_READ`（读路径）/ `FLYWHEEL_WORKFLOW_FORCE_LEGACY`（应急回退）
已在 workflow-claims.ts；enrollment 按 run 显式标记（typed 列，A 已有）。**红测的三段式停认
`qa_required=0` 无条件**（不吃 READ flag，见 B.1）——READ flag 只门控「切到 claims 账本查证据」这一步，
FORCE_LEGACY 反悔到旧布尔。

⛔ **部署前置（PR 描述硬 checklist）**：携带本单的 Bridge 重启前，要么 (a) 跑过 7b8255cf 的
fresh-spawn E2E + `FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1`（三段式 QA verdict 才有 claim，否则 fail-closed
卡 ship），要么 (b) 过渡期 `FLYWHEEL_WORKFLOW_FORCE_LEGACY=1`（fail-safe 顺序，绝不裸上）。Tadashi 背这条纪律。

## G. 一次真机 E2E（plan §3.2 本格要求）

隔离环境（非生产 FLYWHEEL_STATE_DIR）起一次真三段式 fresh-spawn：WRITE=1 + READ=1 → QA 节点经
bootstrap 凭证提交 `qa_passed` claim → ship gate 读账本放行；对照 head 前进后旧 claim 失效卡 ship；
R2#2 负测在同环境跑（sibling runner 伪造失败）。证据先于任何 gate 呈报（2026-07-14 标准）。

## H. 风险

1. **爆炸半径**：④ 动 ship gate 主路径——靠三段式身份判别 + 遗留分支字节兼容 + 突变测试 +
   FORCE_LEGACY + 红测锁死。
2. **决策 2 认证因子依赖 OS 行为**：spawn-env 不可读是本机实测事实——负测把它变成 CI 常驻断言；
   若未来跨 OS，证明路径需各自复验（no proven path→refuse 是结构保证）。
3. **跨库半写窗口**：source event 与权威写同 CommDB 事务消掉；projector 幂等；边界 crash 测试
   证明权威与账本都存活。
4. **1204-split rebase 成本**：按 §2.4 path/hunk 矩阵逐 commit 摘，不整体 merge。
5. **doc drift**：以符号/语义定位，不锚行号。

## I. 下一步

→ plan.md：把 ③④⑤ 切成实现步骤序（TDD RED→GREEN）、验收矩阵逐格映射 S1-S16 + E1-E6、
文件清单、部署 checklist。
