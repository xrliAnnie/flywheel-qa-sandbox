# FLY-1655 self-ship 按不变量重设计 — 独立 QA 报告(FAIL)

Issue: FLY-1655 (https://linear.app/geoforge3d/issue/FLY-1655/founder-直令唯一单-self-ship-修了又坏-n-真根因每次修复只覆盖上一次事故的状态签名要按不变量重设计)
日期: 2026-08-09
基于: qa-handoff.md

> 历史记录：本文件记录 founder 终节点纠偏前的独立 QA R1 与当时实现，现已被 `qa-handoff.md` 的 terminal-land 方案取代。R1 指出的 snapshot blocker 已修；下文 A–G 补偿层描述不得作为当前验收前提。

---

## 0. 判决:**FAIL**(单点阻断,其余全绿)

被验 head:`2bf54924b0b12811c8b74f0b54de5e8a94fff25e`(= PR #795 head = origin/flywheel-FLY-1655,报判决前复核一致)。

**阻断项只有一条**:`packages/teamlead/src/bridge/run-infra.ts:639` 新增的
`if (!run.snapshot) throw new Error("active workflow snapshot not found")`
让**生产 dispatcher 的 pre-launch admission 接缝**对「active 但没有 snapshot 的 run」直接抛错 → `RunDispatcher.start()` 失败 → **runner 起不来**。

其余七个 Fix(A/B/C/D/E/F/G)在本轮独立验证中**全部通过**,含 11/11 阳性对照与真生产行的事故重放。修好这一条即可复验。

---

## 1. 阻断项 B1(blocker):F1 把 legacy admission 变成 fail-closed 抛错

### 1.1 事实链

| 证据 | 结果 |
|---|---|
| PR #795 head `2bf54924` 的 CI | `Unit (teamlead 2 of 3)` **FAILURE** / `CI OK` **FAILURE**(run 31305522245) |
| 失败用例 | `src/bridge/__tests__/workflow-shadow-wiring.test.ts > RunDispatcher.start() pre-launch seam (T1/T2/T7) > uses the production run-infra admission seam across boot-OFF → ON → OFF` |
| 报错 | `workflow claims admission failed for <execId>: active workflow snapshot not found`(`run-dispatcher.ts:1449`) |
| main(`cd922b4f`)的 CI | **SUCCESS**(run 31262716101)⇒ 不是既有红 |
| 本机 HEAD 复跑 ×3 | 3/3 失败(1 failed / 14 passed),非 flake |
| **单文件回退定位** | 只把 `packages/teamlead/src/bridge/run-infra.ts` 回退到 origin/main → **15/15 全绿**;单独回退 `workflow-run-snapshot.ts` / `workflow-template.ts` / `StateStore.ts` → **仍红** |

⇒ 归因唯一且精确:**`run-infra.ts` 的 F1 改动**。

### 1.2 精确 diff

```
-			const now = Date.now();
+			if (!run.snapshot) throw new Error("active workflow snapshot not found");
+			const now = new Date();
+			const credentialWindow = credentialWindowForNode(
+				parseWorkflowRunSnapshot(run.snapshot), input.node, now,
+			);
```

plan §7 F1 的授权范围是「删 30min/2h 硬编码,改调 `credentialWindowForNode`」。**新增的 snapshot 硬前置不在该范围内**,它把一条原本能走通的 legacy 路径改成了无出口的抛错。

### 1.3 生产可达性(真库,不是假设)

生产 `teamlead.db` 只读快照(VACUUM INTO,零写生产)统计 `workflow_run.snapshot` 为 NULL/空:

| status | 无 snapshot | 总数 |
|---|---|---|
| **active** | **1** | 3 |
| held | 2 | 20 |
| terminated | 49 | 141 |
| completed / canceled / cancelled | 2 / 4 / 1 | 11 / 8 / 1 |

当前这条 active 无 snapshot 的 run 是 `74530a72-c4bd-4dd8-a6fc-6eccfdfe9d79`(issue `LEARN-219`,`current_node_id=main`,建于 2026-08-01)。
⇒ 一旦部署,对这类 run 派 runner 会在 admission 阶段抛错、**起不来**;held 的 2 条恢复 active 后同样命中。

### 1.4 为什么这条必须挡

1. **硬门红**:`CI OK` 失败。按 `feedback_qa_pass_only_after_all_hard_gates`,硬门未过不发 PASS。
2. **命中本单要治的病**:本单的六条不变量里 I1/I3 就是「不得以缺行/缺料 fail-closed 拒人且无对账」。这行新代码恰好制造了一个**没有补齐路径、没有告警、直接抛错**的新 fail-closed 点 —— 与 issue 主旨相反。
3. **交接文档误判**:qa-handoff.md §4 把它写成「与分支零 diff 的既有 host-state 测试 …… `workflow-shadow-wiring` 1 个 active-snapshot fixture 缺口」。**测试文件确实零 diff,但它验的生产代码有 diff**;而且它在干净的 Linux CI runner 上同样红,不是 host state。handoff 自己说「CI/独立真机仍需给 canonical 结论」——canonical 结论现在有了,是红。

### 1.5 建议修法(供实现者裁量,QA 不写产品码)

需要给「active 但无 snapshot」一条**有出口**的语义,而不是抛错。两条方向任选:
- **A(最小)**:无 snapshot 时回落到既有 30min/2h 窗口(= 改前行为),并记一条 `credential_window_fallback` 审计事件;有 snapshot 才走 `credentialWindowForNode`。保住 F1 目的(manifest 可覆写),同时不新增无出口拒绝。
- **B**:把 snapshot 缺失当成需要对账的账实不符,复用 Fix A 的形状(可证明就补、不可证明就精确报因 + 聚合告警),而不是 `throw`。

修完请附:该用例 15/15 绿 + 一条覆盖「active run 无 snapshot 仍能 admit」的新回归。

---

## 2. 通过项:逐条证据

### 2.1 交付要求 2 —— FLY-1625 ①②③④ 各自终局(无第三态)

| # | handoff 裁定 | 我的独立核验 |
|---|---|---|
| ① holder/head 不取 QA cwd | 已落地 | `/head-authority` 服务端裁决在,409 body 现带 `detail.{required,derivable,failed_condition}`(`workflow-decision-routes.ts:404-421`);verify-approval 透传。**核实通过** |
| ② binding 失败后重试/对账 | 已落地 | `reconcileShipTargetBindingForHeadAuthority`(读时)+ `reconcileShipTargetBindingsAtBoot`(boot)真实存在,且**已接线**到 `plugin.ts:9346`(boot)与 `plugin.ts:7084`。**核实通过**,并用真事故行跑通(§2.3) |
| ③ 带审计的操作员杠杆 | 已落地 | `/gate-reissue/stage` + `/gate-reissue` 两条路由挂载(`workflow-decision-routes.ts:793/831`),durable saga 事件 `gate_reissue_requested / gate_reissued / gate_reissue_converged / gate_reissue_aborted` 齐。**核实通过** |
| ④ 凭据重铸入口 | **判死**,改由 F 使其不必要 | `submitWorkflowDecisionByCredential` 的过期强制点已被 `permanent` 旁路(`StateStore.ts:27782`);migration 幂等加列并把存量 `family='qa_verdict'` 刷成 `permanent=1`(`StateStore.ts:1903-1916`);output 凭据族(`:25026`)按计划**未动**。撤销改为**不变量式**:任何 session 进入 operational-terminal 即撤销其未消费凭据(`StateStore.ts:4744-4749`,reason `session_terminal:<status>`),而非枚举五个签名。**核实通过** |

四条都落在「已落地」或「判死」,**不存在「候选/以后再做」的第三态**。

### 2.2 交付要求 3 —— 阳性对照 11/11 独立复现

方法:对每条修复做**外科式 mutation**(精确改产品码 → 跑目标用例 → `git checkout --` 还原 → 断言工作树干净)。全程零提交,最终 `git status --porcelain` 为空。

| Fix | 摘掉的东西 | 结果 |
|---|---|---|
| A 读时补齐 | 让 `reconcileShipTargetBindingForHeadAuthority` 恒失败 | **红** 2 |
| A boot 对账 | 让 boot 循环里的 `reconcileShipTargetBindingAtBoot` 恒失败 | **红** 2 |
| B1 relay 硬拒 | 删掉 `approve_to_ship_requires_founder_writer` throw | **红** 1 |
| B2 consumed-gate 反馈 | 关掉 `shipGates.length===0 && hasApprovalIntent` 分支 | **红** 1 |
| C1 typed 409 | 去掉 try/catch,回到裸 throw | **红** 2 |
| C2 失败分道 | 破坏 `failureClass === "infrastructure"` 判定 | **红** 1 |
| D 交付事实刹车 | 让 `proveDeliveredWithoutReceipt` 恒不成立 | **红** 1 |
| E 新门恢复 | 卸掉 `/gate-reissue` 路由 | **红** 2 |
| F2 钥匙不过期 | 去掉 `!permanent &&` 旁路 | **红** 1 |
| F3 marker 存正文 | 去掉 marker 的 `status`/`summary` | **红** 3 |
| G 部署身份 | 删掉 `merge-base --is-ancestor` 闸 | **红** 2/10 |

11/11 全部「摘掉即红、恢复即绿」。断言是**有载荷的**,不是空过绿测。

### 2.3 交付要求 4 —— 在真产物上自测(不是干净 fixture)

拿生产 `teamlead.db` 的**只读** VACUUM INTO 副本(1.5 GB,`quick_check=ok`,生产零写),把 **FLY-1648 那条真事故行**恢复到 2026-08-07 事发当刻的状态(`workflow_run.status='active'`、carrier session `awaiting_review`),然后跑 **PR head 的已构建 dist**(`dist/build-identity.json.artifactBuildSha = 2bf54924`)里的真 `reconcileShipTargetBindingsAtBoot()`:

真实行:run `b3183071-…`,question `workflow-gate:d942281a…`,head `c5da6c58…`,carrier `558c9f66-…`,`workflow_ship_target_binding` **0 行**(= issue 描述的现场)。

| 场景(全部基于真行) | 结果 |
|---|---|
| **S1 忠实重放事故** | `scanned=1, reconciled=1`;binding 行补出,`frozen_head_sha=c5da6c5806…`、`probe_repo_slug=xrliannie/flywheel`;`ship_target_binding_reconciled` 事件 **1** 条 ⇒ **点燃本单的那次事故现在会自愈** |
| S2 holder head 改成不匹配 | 拒,`failedCondition=binding_head_mismatch`,**零写入** |
| S3 carrier session 终态 | 拒,`failedCondition=carrier_status_mismatch`,**零写入** |
| S4 run 改成 `held` | `scanned=0` —— 按设计不进 sweep,不制造误导告警 |
| S5 删掉 `workflow_node_pr_binding` 材料 | 拒,`failedCondition=node_binding_missing`,**零写入**(不凭空造授权) |

补齐是**严格证明后的补齐**,失败是**精确报因的失败**,两个方向都在真数据上成立。

### 2.4 交付要求 6 —— 409 说明「为什么缺」

`/head-authority` 的 `ship_target_binding_unavailable` 现在带 `detail.{required, derivable, failed_condition, superseded_at?}`;上表 S2/S3/S5 的 `failedCondition` 就是这套枚举在真数据上的实际取值 —— 不必再人工读码反推。

### 2.5 真 Discord N-to-N(529 QA Room,Discord-capable 强制项)

本改动是 Discord-capable(ship 卡片正文、consumed-gate 的 ❓ + severe alert、gate-reissue 换新卡、relay 拒绝)。走 **module-driven 真机路径**:真编译产物 + 真 test bot token + 真 thread POST/GET,**零 mock**;founder 一侧由 **Claude-in-Chrome 驱动 Annie 本人已登录会话**(非 bot,`author.bot=false` 是 deliverer 的硬前置)。

- 房间:QA Testing guild `1485787271192907816` / 频道 `#product-lead-test` `1493080993173737583`;thread `1535944225005375518`。**生产零触碰**。
- **① 卡片正文(Fix B3)**:真 Discord 渲染出新的批准指引原文 ——
  「Approval is recognized only from the founder's ✅ reaction on this card or the founder's direct reply in this card's thread.」
  同时全仓 `SHIP-VERDICT` 引导语已清除(仅 FLY-1463 历史文档保留并加了作废批注,shell sentinel 断言现行契约/模板里不得再出现)。
- **② consumed-gate 反馈(Fix B2)**:Annie 真人在该 thread 发批准 → 真 `emitFounderReplyDeliveryForThread` 经**真 Discord GET** 读到 → `result=advanced`,落 convergence 记录(`classification=approve`, `card_reference_valid=0`)→ convergence pass `alerted=1`,severity=**severe**,告警正文明确指向 **`/gate-reissue`**、并明确禁止「edit or rebind the old gate」→ **真 Discord reaction PUT 返回 204**,消息上真的出现 ❓(count=1)。
- **③ 去重**:第二次 pass `alerted=0`。
- BEFORE→AFTER 截图各一张(反应前 `reactions: []` → 反应后 ❓ 1)。
- 顺带更正一条旧记忆:该 529 test bot **有** ADD_REACTIONS 权限(实测 204),不是过去记的「必 403」。

### 2.6 自动化门(独立复跑,非引用 handoff 数字)

| 门 | 我的结果 |
|---|---|
| TeamLead 20 个改动测试文件 | **461 passed / 1 skipped**(handoff 记 459,head 上实测 461) |
| flywheel-comm 4 个改动测试文件 | **116 passed** |
| `scripts/__tests__/deploy-build-identity.test.sh` | 10 passed |
| `scripts/__tests__/package-onboard.test.sh` | 27 passed |
| `scripts/__tests__/restart-services-admission-pause.test.sh` | 13 passed |
| `pnpm lint` | 0 error / 13 既有 warning |
| **CI(canonical)** | ❌ 见 §1 |

---

## 3. 诚实边界:没测的部分

1. **§5 真机验收 1–4 未执行**:部署本 PR → 真 v2 DAG run 走到 founder_gate → founder 在卡片上批 → runner 自 merge + 自清理 + 归档 → 关 runner 后 5 分钟零重派。
   原因:需要把代码部署进生产并真的 merge 到 main;merge 是 founder-gated,QA 节点没有该权限,DAG 也禁止本节点 ship。§2.3/§2.5 给的是**机制级真数据/真 Discord** 证据,**不能**替代这条全链闭环。**在这条跑通之前,不得声称「self-ship 全链修复已在线闭环」。**
2. **`/gate-reissue` 真往返未跑**:换新卡、旧门永拒、恰一 carrier 拥新 qid —— 由单测 + 阳性对照覆盖;真机一轮留给部署后。§2.5 只证了告警**指向**它。
3. **>2h 后交判决的真机 F 全链未跑**:permanence 语义已用「真造一张过去时刻的 permanent 凭据」证到 claim 层;但生产 Bridge 现在跑的是旧码,我这次 `qa-result` 走的仍是旧的 bounded 路径,不构成新码的真机证明。
4. **canonical 全包 sweep 未由我重跑**:我只跑了改动面的定向套件 + CI。生产 host 跑全量 vitest 会压死 Bridge(`feedback_heavy_vitest_suite_on_prod_host_kills_bridge`),canonical 结论以 CI 为准 —— 而 CI 现在是红的。

## 4. 非阻断 advisory(转 Lead 裁量)

- **Fix G 的 build 身份有一个诚实缺口**:`artifactBuildSha` 由 `packages/teamlead/package.json` 的 build 脚本用 `git rev-parse HEAD` 写入。它能挡住本单要治的 stale-Bridge(运行版本是 intended 的祖先),但**挡不住脏工作树构建** —— 带未提交改动构建出的 dist 会被盖上一个干净 commit 的 SHA。若要闭合,构建时可一并记 `git status --porcelain` 是否为空(或产物内容摘要),脏树标 `unknown`/`dirty`。
- **`plugin.ts:9346` 的 boot sweep 是 `void`(不 await)**:失败只进聚合告警,不影响 boot —— 设计如此,但 boot 期竞态下第一轮可能扫在其它初始化之前,值得实现者确认一次时序。
