# FLY-1278 跨家族审查门收敛修复 — 调研

Issue: FLY-1278 (https://linear.app/geoforge3d/issue/FLY-1278/fix-跨家族审查门在-lead-已裁决的非阻塞项上死循环-审稿人反复重提被-overrule-的优化建议强制门永不收敛fly-1251)
日期: 2026-07-15
基于: exploration.md

> 本文是纯事实审计：跨家族审查 lane 全链路的代码收据、生产 DB 现场证据、以及对设计有约束力的机制细节。方案取舍见 exploration.md，实施切片见 plan.md。

## 1. 跨家族审查 lane 全链路（代码收据）

### 1.1 Runner 侧（codex 作者）

- 契约：`packages/claude-runner/agents/codex-runner-contract.md:57-72` —— 三步：① `gate review_design|review_code --no-block "<one-line review request>"` 拿 questionId；② `request-review --type ... --question-id <id>`；③ `check <questionId>` 轮询 verdict，「fix + re-request on CHANGES」。**契约对 CHANGES verdict 的唯一指示是修了再请**——没有任何「非阻塞建议」的概念。
- `packages/flywheel-comm/src/commands/request-review.ts:84-90` —— POST payload 仅五个字段：`executionId / requestId / reviewType / questionId / planPath`。**没有任何 governance/ruling 载体字段**。
- gate 消息文本（runner 唯一能写自由文本的地方）落 CommDB `messages.content`，见 §2.2 —— 但见 §1.2：coordinator 从不读它。

### 1.2 Bridge 侧（ReviewRequestCoordinator）

文件：`packages/teamlead/src/bridge/review-request-coordinator.ts`

- `accept()` (177-415)：校验（gate 绑定 R12 HIGH-2 / requestId 幂等 / claude 作者拒收 409）→ code review 服务端冻结 head（`deriveWorktreeHead`，rev-parse-only，129-141）→ codex_skip lane（317-372，session 启动时冻结的快照）→ 落 job 行（round = 既有 job 数 +1，374-391）→ enqueue。
- `runJob()` (555-726)：per-execution 串行、全局并发 2；round 1 新 uuid / reround `--resume` 同一 reviewer session（593-599）；outcome 为 failed → job fail + gate 保持关闭（625-631）；**verdict 原样落库**：`completeCodexReviewJob(requestId, outcome.verdict, findingsJson)` (696)，唯一的加工是 head 复核（653-686）与 gate 重验（633-651）。**不存在任何 severity 政策**——reviewer 的二元 verdict 直接决定门开关。
- `commitAuthorityIfApproved()` (733-752)：verdict === "APPROVED" 且 code review → 写 `codex_review_record`（家族戳 + request_id 绑定）。
- `buildPrompt()` (754-790)：**全部输入 = review_type / round / target_path / frozen_head_sha / issue_id / execution_id / 上轮 findings_json**。
  - R1 contract 段只要求输出 `{"verdict": "APPROVED" | "CHANGES_REQUESTED", "findings": [{"severity": "HIGH|MEDIUM|LOW", ...}], "reviewedHeadSha": ...}` ——**从未定义什么 severity 才配 CHANGES_REQUESTED**。
  - reround 段 (786-789)：「Your previous findings were: {priorFindings} — Focus on whether they were correctly fixed and on anything new the fixes introduced.」——对一条被裁决不修的建议，这句话就是重提指令。
  - **gate 问题的 content 不在任何输入里**（`checkGate` 只读 type/from_agent/checkpoint/resolved_at，809-819）。RC1 的代码级证明。
- `respond()`/`isOurResponse()` (842-957)：gate 应答字节级幂等——existing response 必须与 canonical payload **byte-identical** 才算「我们的」投递（R14/R15 HIGH-1 防伪造）。
- `deliverStoredResponse()` (438-498)：outbox 崩溃重投**从 job 行重建 payload**（466-479），不重跑 reviewer。

### 1.3 Reviewer 子进程

文件：`packages/teamlead/src/bridge/claude-review-runner.ts`

- `claude -p <prompt> --session-id|--resume <uuid> --output-format json --model claude-opus-4-8 --effort xhigh`（101-120；effort 默认 xhigh = FLY-1224 Annie 直令，87）。
- `ClaudeReviewFinding` (28-34)：`severity?: string` 自由文本可选字段——**无枚举校验，无 id 字段**。
- 解析 fail-close（208-284）：非结构化 verdict 一律 `kind:"failed"`，门保持关闭。30min/轮 timeout，8MB stdout 上限，washJudgeEnv 洗凭据。

### 1.4 权威链与消费端

- `codex_review_record`（`packages/teamlead/src/StateStore.ts:1821-1861`）：PK = (execution_id, target_pr_head_sha)；status approved/skipped/pending；FLY-1188 补 `author_family / reviewer_family / request_id` 列。
- `isCodexCodeReviewApproved` (StateStore.ts:4883-4898) → `crossFamilyReviewSatisfied`（`packages/config/src/review-family.ts:67-77`，Bridge 与 CLI 共享规则）。
- 硬门开关先例：`packages/teamlead/src/bridge/codex-gate.ts:13-83` —— `FLYWHEEL_CODEX_HARD_GATE` **default ON、显式 =0 才旁路**（本次 severity 政策开关沿用此风格）。
- CLI 镜像：`packages/flywheel-comm/src/commands/verify-approval.ts:340` 同一规则。**消费端只认 record 行**——record 只在（effective）APPROVED 时写入，因此门侧政策改动对消费端零接触。
- legacy lane：`packages/flywheel-comm/src/commands/await-codex-gate.ts` —— claude 作者自驱 Codex 审、只在 APPROVED 时写 result 文件；其收敛动力学是 runner 会话式的，与本 issue 无关（byte-compat 边界）。

## 2. 生产现场证据（2026-07-15 直查）

### 2.1 teamlead.db · codex_review_job（execution bb9cb377…，FLY-1251 code review）

9 轮：R1 failed(gate)；R2/R3 CHANGES（真缺陷期，R3 HIGH 引出 sub-lease）；R4/R5 **APPROVED**（head 随后移动作废）；**R6-R9 CHANGES，每轮 findings_json 恰好一条、同一条 MEDIUM**（30s docs-only metadata lease 优化，file 同、line 401→402→403 漂移、title 措辞逐轮变化）。R6-R9 finding 原文均含「the TOCTOU guard … is the genuine correctness fix and should stay」「Recommend applying …」——审稿人自知这是建议，仍投 CHANGES_REQUESTED（RC2 的行为级证明）。

### 2.2 comm.db · gate 消息原文（runner 登记裁决的实际通道）

- R7 (`bbb62749…`)：「Round-6 MED proposed restoring the 30s docs-only metadata lease; please reconsider because approved plan §3.1 requires … QA reproduced a <=30s fail-open retarget window …」
- R8 (`ae1a4bf0…`)：「**Lead ruling on prior MEDIUM: authorization correctness > rate optimization** … reject the 30s docs-only lease … **Follow-up FLY-1274 owns** event-driven/conditional invalidation … Please review the exact head and **accept this governance decision**.」
- R9 (`4f46a2dd…`)：「Governance remains unchanged: **Lead explicitly rejected the repeated docs-only lease MEDIUM and moved optimization to FLY-1274** … **do not relitigate the settled authorization policy**.」

结论：issue 里「runner 把 governance 裁决注册进审查请求了，审稿人仍无视」在机制上应修正为——裁决写进了 gate 文本，而 gate 文本**结构上到不了** reviewer prompt（§1.2）。审稿人无视不是抗命，是失聪。

## 3. 对设计有约束力的机制细节

1. **payload 字节幂等 × 重投重建**：`isOurResponse` 是 byte-compare，`deliverStoredResponse` 从 job 行重建 payload → **effective verdict 及 advisories 必须在 verdict 时刻冻结进 job 行**，重投只读行、绝不重算（否则裁决表在窗口期变化 → 重建 payload 漂移 → 被判 FOREIGN、投递扣押）。升级窗口 edge case：改 payload 形状后，对**升级前已投递但未 stamp** 的旧 job 重投会 byte-mismatch → 一次性 FOREIGN alert；缓解 = 重投比对时同时接受旧形状 canonical（plan 落细节）。
2. **finding 无稳定身份**：实测 R6-R9 同一 finding 的 line/title 每轮漂移 → **(file,title) 指纹跨轮匹配不可靠**。可依赖的是 reviewer session `--resume` 连续性（同一会话有记忆）→ 让 reviewer 自己发稳定 `id` 并跨轮复用（schema 加字段 + prompt 指令），指纹只做次级兜底。
3. **codex_skip 快照冻结在 execution 启动**（accept() 317-372 + FLY-1188 plan §7.1）——mid-run 不可启用；这就是「唯一旁路粒度错误」的机制根源，per-finding 裁决必须走新表、不能复用 skip。
4. **round 计数 = 既有 job 行数 +1**（374）——同 execution 单调递增，head 变化不重置。R2+ 一律 `--resume` 上一轮 reviewer session uuid（`latestCodexReviewerSessionUuid`）。
5. **severity 现状是自由文本**（§1.3）→ 政策实现必须 fail-closed：非阻塞白名单 = {MEDIUM, LOW}（大小写归一）；缺失/其他值（含 CRITICAL）一律按阻塞。
6. **kill-switch 风格**：`FLYWHEEL_CODEX_HARD_GATE` default-ON、`=0` 旁路 + reverse-compat sentinel 测试（codex-gate.ts:72-83）——severity 政策开关 `FLYWHEEL_REVIEW_SEVERITY_POLICY` 沿用同款形态。
7. **alertLead 是 dep seam 但生产未注入**（Codex design review R1 实查纠正）：`ReviewCoordinatorDeps.alertLead` 存在（review-request-coordinator.ts:94-95）且测试注入，但 plugin.ts:6080 的生产构造**没有传**——plugin.ts:6072-6076 注释自认失败目前只到 console + durable row。⇒ advisory/dispute 告警需要补真实接线（新增 review 告警 kind 走 `ALERT_EVENT_TYPES`/kind-contract + 路由，或注入专用 sink）；issue-thread 贴文可复用 `AutoQaEffects.postThreadResult` 形态（auto-qa-effects.ts:146）。另：issue 身份在库里是 UUID/Linear-identifier 混用现实（StateStore.ts:3704、5445；PreHydrator.ts:35-40 分开持久化 node.id 与 issueIdentifier）——issue 级裁决查询必须 alias-aware。
8. **信任模型现状**：CommDB `from_agent` 可伪造（isOurResponse 注释自认，R14 HIGH-1）；本机 CLI 无进程级身份隔离。Lead 裁决通道 v1 的防线 = Bridge 端点校验（只裁已投递 finding + execution/issue 绑定）+ 全量审计 + Discord issue thread 可见性；CLI 硬身份 = FLY-246 域，不在本单造。
9. **FLY-1244 claims 账本不复用**：claims.db 是 workflow-template 域的证据账本（qa_passed/founder_approved），语义是「事实声明」；裁决是「治理决定」，生命周期/校验/消费者完全不同，塞进 claims 会污染两边的语义边界。裁决落 StateStore 新表（与 codex_review_job 同库同事务域）。
10. **三段式共享 issue、不共享 execution**：design/implement/qa 各自 execution_id；implement 被 respawn/续接时 execution 也会换 → 裁决若锚 execution 级，respawn 后 Lead 需重裁一遍——issue 级（project_name + issue_id）才符合「裁决跟着这单走」的直觉。审计行记录 ruled_by + 当时 execution 上下文。

## 4. 验收对照（issue 验收 → 机制保证）

| 验收 | 机制 |
|---|---|
| Lead 已裁决的非阻塞项，下一轮不再 block | 组件 A（MEDIUM 本就不阻）+ C/D（已裁决项从阻塞集排除 + prompt 告知勿重提）双保险 |
| 真 HIGH 缺陷仍 fail-closed | A 的白名单 fail-closed 方向（HIGH/未知/空 findings 均维持关门）；未裁决的 HIGH 无任何新旁路 |
| FLY-1251 不弱化授权、不 codex_skip 过门 | R6-R9 形态在 A 下为 advisory 放行；若未来出现被裁决的 HIGH，走 C 的受监督 per-finding 通道 |
