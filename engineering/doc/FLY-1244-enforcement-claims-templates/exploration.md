# FLY-1244 DAG 执法层：founder guard 收口 + claims 读切换 + 模板 schema — 探索

Issue: FLY-1244 (https://linear.app/geoforge3d/issue/FLY-1244/build-dag-模板引擎-子单b原-执法层founder-guard-收口-claims-读切换红测变绿-模板)
日期: 2026-07-14
基于: 无（上游 spec = main 上 engineering/doc/FLY-1135-layer1-dag-templates/plan.md，Codex 4 轮 APPROVED）

## 1. 问题定义

FLY-1135 低层 DAG 模板引擎按 4 子单交付（A=①②已 ship / **B=③④⑤本单** / C=⑥ / D=⑦⑧）。
子单 A（FLY-1232，PR #578 = a1681d660）交付了 substrate：teamlead.db 6 张 workflow 表、
一次性 decision capability（只存 sha256）、单事务 submit 原语、影子双写 + 派发 outbox ——
**全部零生产读路径接线**。系统的「执法」仍是旧形态，三个具体的洞本单要关：

1. **ship gate 吃一个过期的 headless 布尔**（FLY-1204 红测）：`qa_required=0` 是 write-once
   快照，head 前进后无法改写；`evaluateQaShipGate` 读到 0 直接放行——QA FAIL 过、head 换过
   都拦不住。且 QA verdict 是 runner 自报（共享 ingest bearer + `--exec-id/--pr-head` 双可伪）。
2. **founder-approval 写边界有两个未收口的直写分支**（FLY-1221）：`actions.ts approveExecution`
   与 `founder-consent/gate-response-router.ts` 都直接 `db.insertResponse(...)` 写 CommDB，
   不经 hold guard（text/reaction/voice 三条路径的 `founderApprovalHoldGuard` 生产接线是真的
   ——伞单 R1#8 已校正事实，缺口只是这两个分支）。
3. **TURN/approval 的权威在 CommDB，但账本在 teamlead.db，跨库无原子性**：`grantTurn` 覆盖
   单行 + epoch++，中间交接历史不可重建；founder approval 落 CommDB response 行，claims 账本
   看不见。

同时，子单 A 的接缝表把以下明确留给 B：**claim 并行写（verdict 生产者）+ capability 下发
通道 + founder guard 收口 + 跨库投影 + claims 读切换 + 红测变绿（E1）+ E4/E5 + 模板
schema/DDL 完整态 + admission 家族校验（函数层）+ materialize kind 状态机（原语层）**。

## 2. Scope（一个 PR，三块交付）

### ③ founder guard 收口 + 跨库投影（plan PR-3；§2.3 + §2.4b）

- 盘点全部生产批准写入点；hold 检查放最窄共享 pre-write 边界，直写例外路径保留纵深防御；
  突变测试摘**真实接线**（actions / founder-consent off|audit|enforce / text / reaction /
  voice / deferred replay / 同决策重试 / 应急旁路）。
- founder approval 经 server-owned source event 投影进 claims 账本（predicate=`founder_approved`，
  subject=pr head，issuer_kind=`founder_challenge`；founder 不持 runner 凭证）。**本单该 claim 只作审计
  投影**：`founder_challenge` 是 issuer 分类标签，不是 nonce/challenge 协议；现行 ship 权限仍由 CommDB
  response + session/head binding + `verify-approval` 判定，claim-driven 执法切换归后续子单 D。
- CommDB 侧新表 `workflow_source_event` + `turn_source_history`（append-only），**与权威写
  同一 CommDB 事务**；projector 按 `(project, source_event_id)` 幂等投影进 StateStore。
  `verify-approval` 读侧字节兼容（双读期不切）。

### ④ claims 读切换 + 红测变绿（plan PR-4；§2.4）

- 红测 `REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts`（origin/fly-1204-split 58cecc1f）
  **原样**落本分支并变绿，不许改弱断言。
- cutover 判别 = **durable 三段式身份**（`session_role=qa` ∧ `chat_thread_role=qa`），不是
  「有没有 claims」也不吃 READ flag：这类行停止承认 `qa_required=0` 豁免，一律要求当前 head
  的有效 `qa_passed` claim（§2.1 解析算法），缺证据 → fail-closed + 显式 re-QA 恢复。
  字节兼容只给真·非模板单 session run。
- claim 生产者接通：QA/codex verdict 经一次性 decision capability 写 claim；capability 下发
  通道按 FLY-245 broker 原则（明文只在 Bridge 内存）。
- fly-1204-split 存量按 §2.4 path/hunk 矩阵吸收；一次真机 E2E（plan §3.2 本格要求）。

### ⑤ 模板 schema / loader / 发布契约 + 物化 snapshot（plan PR-5；§3.1b + PRD Gate A-1/2）

- 完整 DDL：`workflow_template` / `workflow_template_revision` / `workflow_template_publication`
  / `workflow_category_binding` / `workflow_node_outputs`（原语层）。
- normative manifest schema + 校验清单 + 统一词汇映射表（决策结果 → claim predicate → 边条件）。
- 发布契约：revision 字节不可变 + publication append-only + CAS 指针 + DB triggers + 种子
  content-hash 幂等（绝不静默 repoint founder 改过的模板）+ stale-edit 409 + founder 写面
  （loopback + same-origin + confirmToken + audit，fleet-console 模式）。
- 物化 snapshot 函数：admission 选版 → 套 per-run override → 整体复验 → 钉 run。
- **种子 manifest 含模板 #1 正式修订**（FLY-1135 评论 a240c4bf，Annie 四条输入，见 §4 决策 4）。

## 3. 显式不做（本单）

- 派发驱动接线（orchestrator 按 snapshot 解释、模板派发启用）= 子单 D（等 FLY-1224 resolver
  已 ship，前置已满足但接线归 D）。
- node-id 生命周期 8 面 + generic 契约 + Blueprint capability 门控 = 子单 C。
- product 线 materializer 的 runtime 接线（本单只交 DDL + 状态机原语 + 测试）。
- Dashboard 模板编辑 UI = FLY-1038（本单交 StateStore API + 最小 loopback endpoints）。
- codex/agy/kimi 的 capability 已证明路径（本单只证 claude；无证明路径的后端 admission 拒，
  fail-closed——Lead 明令不许顺手做）。

## 4. 关键决策（brainstorm gate 已由 Tadashi 拍板，2026-07-14）

### 决策 1：红测无条件 vs default-off 的张力 —— 接受

红测原样断言（env 只带 `FLYWHEEL_QA_DONE_GATE=1`）要在 CI 变绿 ⇒ 三段式身份的
`qa_required=0` 停止承认必须是**无条件行为**（不吃 READ flag）。`FLYWHEEL_WORKFLOW_FORCE_LEGACY=1`
作应急回退（**进程 env 判定**——红测传显式 env 对象故 hermetic，不受机器 `.env` 影响）。

**部署纪律（Tadashi 背）**：携带 B 的那次 Bridge 重启之前，先跑 ⛔7b8255cf 的 fresh-spawn
E2E + 开 `FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1`；若 E2E 没赶上，重启前把 `FORCE_LEGACY=1` 写进
生产 env（fail-safe 顺序，绝不裸上）。**PR 描述必须把这条部署前置写成醒目 checklist。**

### 决策 2：capability 下发通道（claude 已证明路径）—— 接受

per-execution unix socket broker；连接时 `LOCAL_PEERPID` 取对端 pid → 进程树归属 tmux pane
→ pane 绑 execution 校验。R2#2 负测**必须真做**（runner A 知道 B 的 exec-id/head 且能枚举
`~/.flywheel`，仍伪造/重放不了 B 的决策）。qa-result marker 改存不透明请求 id，不存明文 body。
codex/agy/kimi admission 拒 = fail-closed（三段式 QA 节点现值 claude/opus，够用）。

### 决策 3：三个 scope 边缘 —— 全对

(a) `workflow_node_outputs` + materialize kind：只交 DDL + 状态机原语 + 测试；
(b) founder 写面 = StateStore API + loopback + confirmToken endpoints，UI 归 FLY-1038；
(c) admission 家族校验 = 校验函数 + 种子正负测，派发时调用接线归子单 D。

### 决策 4：模板 #1 修订落地形态 —— 接受

- **档位 = 三份独立种子模板**（`tpl_eng_heavy` / `tpl_eng_light` / `tpl_eng_trivial`），
  不做单模板多档——独立模板改动隔离、审计清晰。
- Lead 动态点菜 = 选模板 + per-run override（Q1=A 已定）+ **override 必带 reason 字段落
  snapshot 与审计**（Annie「判断理由可见」的直接落地）。
- QA = 一等节点，任何档不省（「不许单 session 自测收尾」）。
- 交接 = 指针不塞正文：进 manifest 节点契约字段 + 校验（拒全文塞 prompt），FLY-1236
  已 ship 的 pointer-objective 机制为准绳。

### Annie 四条 founder 输入的映射（FLY-1135 评论 a240c4bf）

| Annie 原话 | 落地 |
|---|---|
| 重活 = design Fable / implement Codex(xhigh)；轻活 = 全 Codex；琐事 = 轻量模板，design 段不许重 | 三份种子模板（heavy/light/trivial），厂商阵容进 manifest 节点 `{vendor, model, effort}` |
| Dashboard = 静态菜单；Lead = 动态点菜，理由可见、founder 可覆盖 | 模板表 = 菜单（founder 写面管理）；Lead 选模板 + per-run override 带必填 reason 落 snapshot/审计 |
| QA = 一等节点，不许单 session 自测收尾 | 三份模板全部含独立 QA 节点；校验清单拒无 QA 节点的 eng 模板变体（trivial 档 QA 用轻模型不是删节点） |
| 交接 = 指针不是正文（FLY-1236 准绳） | manifest 节点契约：handoff 输入 = worktree + design doc 指针；校验拒内联全文 prompt 字段 |

## 5. 已审计的代码事实（brainstorm 前 codebase audit）

| 事实 | 位置 |
|---|---|
| `evaluateQaShipGate` 读 `sessions.qa_required`，=0 直接 `qa_not_required` 放行；不看 session_role | `packages/flywheel-comm/src/ship-eligibility.ts:182` |
| 红测在 origin/fly-1204-split 58cecc1f，断言 session_role=qa 行 head=H2 时 `passed=false` 且 reason≠qa_not_required；env 只带 QA_DONE_GATE | `packages/teamlead/src/__tests__/REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts`（该分支） |
| `approveExecution` 直写 CommDB `insertResponse`（有 FLY-191 顺序修正、FLY-1041 绑定校验，但无 hold guard） | `packages/teamlead/src/bridge/actions.ts:188` |
| founder-consent gate-response-router 直写 `insertResponse`（有 consent evaluator，无 hold guard） | `packages/teamlead/src/bridge/founder-consent/gate-response-router.ts:349` 附近 |
| hold 谓词已存在且被三个 suppression 点消费（event-route / GatePoller / Heartbeat） | `packages/teamlead/src/bridge/auto-qa-held.ts` |
| `grantTurn` 覆盖单行 + epoch++，无 append-only 历史 | `packages/flywheel-comm/src/db.ts:929` |
| A 的 substrate：闭合词汇表 + 3 flag + capability 哈希 + 规范 submission digest 已在 | `packages/teamlead/src/workflow-claims.ts` |
| FLY-1224 phase 表 {vendor, model, effort} 三元组 resolver 已 ship | `packages/teamlead/src/bridge/three-stage-policy.ts` |
| FLY-1236 pointer-objective（指针不塞正文）已 ship，为交接契约准绳 | commit 6e62255ee |
| flywheel-comm 不能 import teamlead（依赖方向反）⇒ 解析算法需 flywheel-comm 侧 SQL 复现 + 跨实现契约测试 | 包依赖关系 |

## 6. 硬约束（issue 原文）

- flag 分立：写 / 读 / 应急回退三个独立 flag；enrollment 按 run 显式标记，绝不由表内数据推断。
- 验收矩阵逐格给测试；修订后 claims 断言逐条映射 S1-S16。
- ⛔ enable-gate pin（FLY-1232 评论 7b8255cf）：`FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1` 前必须
  全真 fresh-spawn E2E。
- 真机 E2E 证据先于任何 gate 呈报（2026-07-14 统一标准）。

## 7. 下一步

→ research.md：逐文件落点调研（gate 改造点 / broker 机制 / claim 生产者接线 / 1204-split
hunk 矩阵展开 / CommDB 事务面 / 模板 DDL 与种子 manifest 形态），然后 plan.md。
