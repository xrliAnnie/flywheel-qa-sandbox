# FLY-1520 DAG 派发引擎 — QA 验证报告
Issue: FLY-1520
日期: 2026-07-28
基于: plan.md(codex design review R8 APPROVED)、PR #723、head `c2bd92bc`

**结论:FAIL —— 5 个 HIGH 缺陷,全部与已批 plan 的明文条款不符。**
F1/F2/F3 我在本机独立复现(见 `qa-findings.test.ts`,当前红);F4/F5 无需复现 ——
plan 要求的代码根本不存在或不完整,grep 即证(§8 逐条可复跑)。

派发/完成/ship 的**主干功能是对的**:验收四条(纯 PRD 单零评审、QA 单合同=verdict、
零场景特例、全链+crash 重放)逐条验过并经变异测试证明非空过(§2、§3)。
FAIL 出在**授权与恢复的边缘路径**:一条评审绕过、一条证据绑定失效、一条会把
founder 批准彻底卡死、两条会让流水线永久停摆。这些路径现有 33 条测试一条都没走到。

复现测试已提交(`packages/v2-dag/src/__tests__/qa-findings.test.ts`),
**在缺陷修好之前 CI 会是红的 —— 这是有意为之**,红色即修复信号,不要靠放宽断言转绿。

---

## 1. 施工纪律核查(逐条实证)— 全部通过

| 铁律 | 核查方式 | 结果 |
|---|---|---|
| 不加迁移 | `git diff merge-base...HEAD` 过滤 `migrat|\.sql` | ✅ 零命中 |
| 不动 v2-engine / v2-actions / v2-scheduler | 同上按包名过滤 | ✅ 零命中 |
| 新代码走新包 | 改动文件全集 | ✅ 仅 `packages/v2-dag/` + `engineering/doc/` + `pnpm-lock.yaml` |
| 依赖恰二 | `package.json` + 源码 import 全扫 | ✅ 只有 `flywheel-v2-kernel`、`flywheel-v2-engine`(+ node 内置) |
| 只 import index,零深路径 | 扫 `from "flywheel-v2-(engine\|kernel)/"` | ✅ 零命中 |
| 本包零 import v2-actions(偏离 2) | 扫 `v2-actions` | ✅ 零命中 |

## 2. 验收逐条 — 主干全部通过

### 2.1 纯 PRD 单 ship 一路畅通,零代码评审要求 — PASS

已有 `document-only-e2e` 只覆盖「单个 docs 写库节点」。补了更强的一档:
**两节点、全程不碰仓库(`writes_repo=false`)的 PRD 单**,且该世界里
**一个 reviewer family 都没注册** —— 引擎若真去要评审,连找都找不到人。
结果一路走到 merge 落地,`evidence.review_approval` 与
`review_family_exhausted` 事件数**均为 0**。

### 2.2 QA 单的合同 = verdict,非代码评审 — PASS

QA 节点(不写仓库、合同 `[{kind:"verdict"}]`)只凭一条 verdict 完成,
`node_completed` 回执里 `satisfied_items=[{kind:"verdict"}]`、
`evidence_refs` 恰是那条 verdict,零评审证据。

另补 plan §2.6 点名的 R2-3 反例(此前**无任何测试**):
**verdict 为 `fail` 时完成必须被拒**,task 停在 `running`;补录一条 `pass`
后同一节点正常完成 —— 前后对照证明拒绝来自 pass 判定本身。

### 2.3 零按场景写的特例 — PASS

派生矩阵不看节点名字,只看产出物分类。补了一组**对照实验**:两个节点
`kindLabel` 都是 `opaque`、reviewer 配置逐字相同,**唯一差异是 diff 内容** ——

| 产出物 | 结果 |
|---|---|
| 只有 `packages/app/src/__tests__/thing.test.ts` | ✅ 直接完成,零评审要求 |
| 同上 **再加一个** `packages/app/src/thing.ts` | ✅ 拒绝完成,要求跨族评审 |

`test` 这一档此前在完成路径上**从未被任何测试走到过**。

另补:作者本族不能给自己的产品代码签字(**按 family 名字**);换成另一族签字后
正常完成。⚠️ 但这条只在 family 名诚实时成立 —— 见 §4 F1。

### 2.4 ship 绝不重新过问「有没有代码评审」— PASS

`ship.ts` 全文零 review/verdict/artifact/docs/role/ci 字样(静态围栏,非空过已证)。
三条通用谓词逐条打反例:DAG 未全 done 拒(approve 侧 + executeShip 事务内重查
两处都验)· head 漂移拒 · actor 非授权拒 · 同一 capability 二次使用拒且
merge 端口只调一次。

### 2.5 全链 + kernel 单写 + crash 重放 — PASS

三节点全链 + dispatch/ship/launch 三组 crash 重放已覆盖并复跑通过。补了完成路径
重放:同一 `completionUid` 重复提交返回 `replayed`、`node_completed` 仍为 1、
**git 端口调用计数逐字不变**(plan §T3「replay-first,Git 零调用断言」)。

### 2.6 三层模型 / 每 worktree 至多一活 writer — PASS

`resume-activation` 已钉死 task→attempt→session。补了 worktree 单写槽:两个无边写库
节点同时 ready 时只派一个、第二轮不偷渡、同轮非写节点不被拦、持槽者完成后另一个才进。

## 3. 变异测试 —— 证明上面的绿不是空过

「测试全绿」本身不是证据。对每条被断言的守卫做定点变异,跑对应测试看是否变红。
**16 条变异全部被杀,零存活。**

- **运行时守卫 9/9 KILLED**:verdict 必须 pass · test 文件不归 product ·
  product 产出派生评审 · 作者族排除出 eligible · ship 拒 head 漂移 ·
  ship 绑定授权 actor · artifact digest 逐字节 · ship 事务内重查 DAG ·
  capability 恰一次消费。
- **静态围栏 6/6 CAUGHT**:注入场景词 / 角色合同词 / ship.ts 评审谓词 /
  第二处 `INSERT INTO tasks` / v2-engine 深路径 import / 第三个依赖,围栏全咬住。
- **阳性对照**:框架用两条已知被覆盖的变异做对照(全量套件下报 KILLED),
  排除「框架没真跑到 / 读的是 dist 旧产物」这类假阴性。

## 4. FAIL findings(5 × HIGH)

严重度口径:能导致**错误合并、权限绕过、或流水线永久卡死**才记 HIGH。
F1-F3 附独立复现(`qa-findings.test.ts`,当前红);F4/F5 无需复现 ——
plan 要求的代码**根本不存在**,grep 即证。

### F1 — admission 不校验 executor family,可伪造身份自审产品代码

- **位置**:`src/admission.ts:196`(以及 `src/contract.ts` 的 `parseExecutor`)
- **plan 明文**:§2.1a「executor 五字段合法,**family ∈ families 权威**」
- **实况**:`parseExecutor` 只做 `text(executor.family)` 非空串检查;
  `admission.ts` / `contract.ts` **全文零 `review_families` 引用**(grep 实证)。
  family 是调用方随便写的字符串。
- **场景**:`review_families` 里 `actual-family → agent-a`。admission 时把
  agent-a 的 executor family 报成 `forged-family`。agent-a 产出产品代码,
  完成时 `authorFamilies=["forged-family"]`,eligible 集合因此**没有排除
  `actual-family`**;再由 agent-a 以 `actual-family` reviewer 身份签一条 `code`
  批准 —— 被认作「跨族」,节点完成,自审代码直通 ship gate。
- **期望 vs 实际**:期望 admission 拒(family 不属该 agent);实际
  `status: 'admitted'`,整条绕过跑通。
- **影响**:跨族评审这条核心约束可被单个 agent 单方面绕过。

### F2 — 非写节点完成不在事务内重取 ship span,证据绑定的 head 可与实际 ship 的 head 不同

- **位置**:`src/completion.ts:527` 附近(`if (bound.payload.writes_repo && ...)` 分支)
- **plan 明文**:§T3「writes_repo=false:零 Git 观测;head subject := **事务内**
  ship worktree 的 current span_tip(R2-4;head 绑定证据对着它验)」
- **实况**:span_tip 在**事务外** `observeNodeCompletion` 里读一次;写事务里只有
  写库节点才复核 `span.head !== observation.base`,非写节点这段整体跳过。
- **场景**:QA 节点对 head A 诚实出具 `pass` verdict。并发 writer 在
  「快照读」与「写事务」之间把 span_tip 推到 B(复现里用 `LaunchLockPort` 这个
  真实端口接缝制造)。完成仍以 A 通过,全节点 done,`maybeRefreshShipGateTx`
  **在 B 上开 gate**。
- **期望 vs 实际**:期望完成被拒(证据陈旧);实际 `status: 'completed'`,
  gate 开在一个从没有 verdict 覆盖过的 head 上。
- **影响**:节点完成合同与实际被合并的 head 脱钩 —— 验收第 2 条的运行时保证失效。

### F3 — gate 可把 ship 授权给 runner,但 runner 的无 task 绑定 action 违反 kernel CHECK,批准彻底卡死

- **位置**:`src/gate.ts:222` `usableActor`(runner 分支)+ `src/ship.ts:168`
- **kernel 明文**(`packages/v2-kernel/src/migrations/0006-actions-black-box.ts`):
  ```sql
  CHECK ((attempt_id IS NULL AND attempt_generation IS NULL AND activation_id IS NULL)
         OR (task_id IS NOT NULL AND attempt_id IS NOT NULL AND attempt_generation IS NOT NULL))
  CHECK (actor_kind='lead' OR activation_id IS NOT NULL)
  ```
  runner ⇒ 必须有 activation_id ⇒ 就必须同时有 task/attempt 全套 lineage。
  ship action 是 issue 级的,压根没有 task lineage。
- **实况**:`usableActor` **专门写了 runner 分支**(有活 activation 就返回),
  `approveShipGate` 的 `const actor = emitter ?? fallback` 会选中它,
  `actionActor()` 给 runner 填 activationId 但不填 task/attempt。
- **期望 vs 实际**:期望「授出去的权限必须花得掉」;实际
  **`SqliteError: CHECK constraint failed`**,栈直指
  `ship.ts:168 → recordActionIntent → kernel.ts:229`。merge 一次都没发生。
- **影响**:founder 批准被搁浅 —— 权限已授、capability 已铸、gate 已 approved,
  但每次 execute 都硬失败,且没有任何自愈路径。这正是 FLY-921 那类
  「批准活着却 ship 不出去」的事故形态。
- **注**:复现走的是 `defaultActionAgentId` 配成活 runner。emitter 路径在正常
  完成流里因 binding 已清而选不中,但 `usableActor` 的 runner 分支是**有意写的**,
  说明这是设计意图而非偶然 —— 要么让它真能用,要么在授权前 fail-closed。

### F4 — reconciler 走到上限时静默过期:不落审计行、不通知 founder

- **位置**:`src/reconcile.ts:195-213`(拒绝结算)+ `src/reconcile.ts:244-257`
  与 `:271-283`(两处 due 扫描的 expire)
- **plan 明文**:§2.4 四格表「确定拒绝 ⇒ recordActionOutcome(failed)+**同事务**
  retry 记账(next_retry **或达上限 expire**)」;§T5-4「failed ⇒ 达 max ⇒
  gate expired + **founder mailbox**」
- **实况**(两段,均 grep 实证):
  1. **结算事务无上限分支**:`:195-213` 无条件算 backoff 并写 `next_retry_at`,
     该事务内没有 `attempt_count >= max_attempts` 判断 —— 上限判断只存在于**另一个**
     事务(due 扫描 `:244`)。plan 要求「同事务」。
  2. **expire 是哑的**:`reconcile.ts` 两处 `state: "expired"`(`:251`、`:277`)
     ——`auditShipGateTx` **全文零命中**、`ship_retry_exhausted` **全文零命中**;
     文件里两处 `appendMailboxTx`(`:339`、`:481`)都在别的路径,不在这两个
     expire 块内。对照 `ship.ts:258-288` 的 exhausted 分支:`auditShipGateTx` +
     `ship_retry_exhausted` event + founder mailbox 三件齐全,同一事务。
- **期望 vs 实际**:期望最后一次失败时同事务 expire + 落 gates 审计行 + 通知
  founder;实际先排下一次 retry,再由 due 扫描翻成 expired,且
  **零 `ship_retry_exhausted` event、零 mailbox、零 gates 审计行**。
- **影响**:crash-in-flight 的 ship 走 reconciler 收敛时,founder 永远等不到
  「ship 失败了,来看一眼」的通知 —— gate 悄悄变 expired,流水线静默停摆。
- **注**:这条比初版描述窄。上限判断**存在**(在 due 扫描里),缺的是
  「同事务」+ 三件通知。修复 = 把 `ship.ts` 的 exhausted 分支镜像过来。

### F5 — launch 收割没有 ref 兜底、没有 `lost_open_attempt`,worktree 消失后写槽永久占死

- **位置**:`src/dispatch.ts:841`
- **plan 明文**:§4 Ports 表列了 `WorktreeRefPort | readExactRef / worktreePresent
  | lost-open 证据`;§T6 收割「worktree+ref 双失 ⇒ 仅 adoptWriterGap
  (**lost_open_attempt**)(§2.3 全绑定,一次性消费;task 不 done)」;
  §2.3 要求 `action='adopt_writer_gap' | '**lost_open_attempt**'` 双名字空间。
- **实况(grep 实证)**:
  - `WorktreeRefPort` / `readExactRef` / `worktreePresent` —— **src/ 全文零命中,端口从未定义**;
  - `lost_open_attempt` —— **src/ 全文零命中,路径从未实现**
    (`adopt_writer_gap` 那半边实现了)。
  - `dispatch.ts:841` 直接 `await ports.git.readHead(snapshot.path)`,worktree 没了就抛,
    recovery 只把异常记进 `failures[]`。
- **期望 vs 实际**:期望能从 exact ref 结算(ref 可读时),ref 也没了才走
  capability 门控的 `lost_open_attempt` 释放套件;实际 activation/attempt/task
  全部原地不动,task 停在 `running`,**writer slot 永久被占**,重跑 recovery 也推不动。
- **额外问题**:`launch-recovery.test.ts:290` 明确断言
  `{ id: bad.taskIds.node, state: "running" }` —— **把这个残缺行为钉成了期望**。
  而该测试的 git 端口 `readRef()` 是能正常返回的,按 plan 本该走 exact-ref 结算。
  修复时这条断言必须一起改,否则测试会锁死缺陷。
- **影响**:该 worktree 上后续所有写库节点永久无法派发,issue 卡死。

## 5. 本段顺带补上的覆盖缺口(非缺陷,已随 §2 的测试补齐)

以下守卫**代码本身正确**,但实现段没有任何测试能证明它们还在 —— 逐个删掉,
原 33 条测试**全绿通过**。现已各自补测并经变异验证(删掉即变红)。

| # | 守卫 | 为什么漏掉 | plan 出处 |
|---|---|---|---|
| 1 | dispatch:观测 head == chain_head | 与 #2 在 `writer-gap` 夹具里**互相遮蔽**:该夹具同时触发两个子句,删任一条另一条仍拦得住 | §T2-3、M2 |
| 2 | dispatch:pending_gap 未清 fail-closed | 同上 | §T1、M2 |
| 3 | completion:writer revision 未变 | 观测窗竞态无测试 | §T3-3、M3 |
| 4 | completion:activation.generation == attempt.generation | 伪 activation 无测试 | §T3-2(R3-1)、M3 |
| 5 | completion:replay-first(Git 零调用) | 完成路径重放无测试 | §T3、M3 |

补测手法:#1/#2 各自构造「只剩这一条子句能拦」的世界;#3 借 git 端口接缝制造并发
链写入,并配**健康对照**(链安静时同一条完成直接通过)排除夹具坏掉的解释;
#4 直接扰动 activations 行世代模拟伪造。

plan §5 把 #3/#4 写在 M3 退出条件、#1/#2 写在 M2 —— 属已批计划点名要钉、实际漏钉的
部分。同样漏钉的 **fail verdict / many 0-1-N / artifact digest** 已在 §2 补齐。

## 6. 非阻塞观察

1. `three-node-e2e.test.ts` 给 `submitNodeCompletion` 传了 `observation: {...manifest: []}`
   并用 `as Parameters<...>` 绕过类型检查。该字段**不在 `NodeCompletionRequest` 里,
   运行时被完全忽略**(函数内部自己重新观测)。实测删掉后该测试逐字照过 ——
   它想表达的「伪造空 manifest 会被拒」并没测到,当前断言实际是被「缺跨族批准」拒的。
   结论仍成立,属误导性写法,建议清理。
2. `document-only-e2e` 标题写「explicit exemption」,但代码里没有任何豁免机制 ——
   docs 分类天然不派生评审而已。措辞与实现不符,建议改名。

## 7. 修复建议(按优先级)

1. **F3** 最先修 —— 它会卡死真实的 founder 批准,且修法最明确:
   要么 `usableActor` 对 runner fail-closed(ship actor 只能是 lead),
   要么给 ship action 补上合法 lineage。前者更贴 plan「ship 是 issue 级动作」的定位。
2. **F1** 次之 —— admission 里把 `executor.family` 对 `review_families:{project}`
   做权威校验(plan §2.1a 原文),不通过就 typed reject。
3. **F2** —— 写事务内重取 ship span 并与 `observation.head` 比对,不等就回滚。
4. **F4** —— 把 `ship.ts` 里那段 `exhausted` 分支镜像到 reconciler 的拒绝路径。
5. **F5** —— 补 `WorktreeRefPort` + exact-ref 结算 + `lost_open_attempt` 路径;
   **同时改掉 `launch-recovery.test.ts:290` 那条把缺陷钉死的断言**。

## 8. 复现命令

```bash
cd packages/v2-dag
npx vitest run src/__tests__/qa-acceptance.test.ts   # 21 passed —— 验收主干
npx vitest run src/__tests__/qa-findings.test.ts     # 3 failed —— F1/F2/F3 复现(预期红)
pnpm run test                                        # 54 passed + 3 failed
cd ../.. && pnpm lint && pnpm -r build               # 均通过
```

F4/F5 无需运行,grep 即证:

```bash
# F1 — admission 从不查 family 权威
grep -rn "review_families" packages/v2-dag/src/admission.ts packages/v2-dag/src/contract.ts   # 零命中

# F4 — reconciler 的 expire 是哑的(对照 ship.ts 三件齐全)
grep -n 'state: "expired"' packages/v2-dag/src/reconcile.ts                    # :251 :277
grep -n "auditShipGateTx\|ship_retry_exhausted" packages/v2-dag/src/reconcile.ts  # 零命中
grep -n "auditShipGateTx\|ship_retry_exhausted" packages/v2-dag/src/ship.ts      # 三件齐全

# F5 — 端口与路径从未实现
grep -rn "lost_open_attempt\|WorktreeRefPort\|readExactRef" packages/v2-dag/src/  # 零命中
```

变异脚本为一次性验证工装,未入库;§3 各条变异的定点(文件 + 原文 + 替换)已在
本报告与 commit message 里写明,可按图复跑。

---

# 复验第 2 轮 — head 57207caf(2026-07-28)

**结论:FAIL(仅 1 条 MEDIUM,F1c)。原 5 条 HIGH + §10 全部真修好并经变异验证。**

## 1. 原 5 条 HIGH — 全部 FIXED,且变异验证「删掉即红」

| | 修法 | 变异验证 |
|---|---|---|
| F1 | `hasApproval` 增 `excludedReviewerAgentId`,按 **agent 身份**排除本任务 executor(两个调用点都加) | KILLED |
| F2 | 非写节点在写事务内重取 ship span,`shipSpan.head !== observation.head` ⇒ 拒 | KILLED |
| F3 | `usableActor` 为 runner 返回真实 lineage,`executeShip` 再校验 lineage 仍 active 且匹配 | KILLED |
| F4 | 结算事务内 `auditShipGateTx` + `ship_retry_exhausted` event + founder mailbox | KILLED |
| F5 | 新增 `WorktreeRefPort`(worktreePresent/readExactRef)+ exact-ref 结算 + `lost_open_attempt` 一次性 capability | KILLED |

**F1 的修法比我要求的更强**:我只要求 admission 校验 family 名,实际改成了**身份级**排除 ——
executor 本人无论谎报什么 family 都签不了自己的字。我专门写了 F1b 探针(families 在 admission
**之后**才注册)验证这一层不依赖注册时序,**通过**。

**`launch-recovery.test.ts` 那条钉死缺陷的断言是真改了,不是绕过**:
`reaped: 1→2`、`failures: [卡住项]→[]`、`state: "running"→"ready"`,标题也从「isolates a vanished
worktree」改成「falls back to the exact branch ref」。

**§10 补齐**:新增 `applies two consecutive runtime contract configurations without recompilation`
—— 两次真 admission 喂两份不同 contract 数据(verdict / artifact)并各自完成,不是 parse 层。

## 2. 我的原有守卫仍然有效

- 验收 21 条全绿;静态围栏 6/6 仍咬得住(注入即抓)
- 原 9 条运行时变异:8 杀,1 条「capability 恰一次消费」由 KILLED 变 SURVIVED

**那 1 条不是回归,是防护变厚了**。实测二次 merge 的拦截层:

```
未变异        → CAS expected 1 changed row(s), got 0      (capability fence)
去掉 fence 断言 → action supersede must use a new invocationUid  (kernel action 层)
```

`invocationUid = capability_id`,所以同一 capability 重放会被 kernel 独立拦一次。两层冗余,
我的变异只拆了一层,安全属性(不会二次 merge)始终成立。

## 3. implement 改了我的测试文件 —— 逐条核对,未削弱

- `qa-findings.test.ts`:**纯新增**一条 F1 测试,我的断言一行未动
- `qa-acceptance.test.ts`:仅把 `family-a`(作者族)加进 registered families ——
  F1 修复后 admission 要校验 family,不注册作者族会导致 admission 直接拒、测试跑不到断言。
  **我的对照实验性质未变**:两个节点改动逐字相同,eligible 集合仍排除作者族,
  「加一个产品文件就要评审」仍然成立(该条变异 KILLED 可证)

## 4. 新发现 F1c — MEDIUM,本轮 FAIL 的唯一原因

**位置**:`src/admission.ts:202` —— `if (familyAuthority) { ... }`

**问题**:plan §2.1a 的 `family ∈ families 权威` 是**无条件**要求,实现是**有条件**的 ——
`review_families:{project}` 尚未注册时,整段校验跳过,未经校验的 family 字符串被冻进
`tasks.payload`。

**后果**(已复现,`qa-probe-f1c.test.ts`,当前红):
admission 早于 `registerReviewFamilies` 发生 ⇒ 声明一个不存在的 family(如 `ghost-family`)⇒
后续注册真 families ⇒ 产品代码完成时 `authorFamilies=["ghost-family"]` **排除不掉任何真族** ⇒
**作者本族的指定 reviewer 给作者的产品代码签字,被算成「跨族」**,节点完成。

**为什么身份级修复挡不住**:F1 的身份排除只挡 executor 本人;这里签字的是**另一个 agent**
(作者本族的注册 reviewer),身份检查不触发。

**严重度定 MEDIUM 而非 HIGH,理由说清楚**:
- 单个 agent **不能**再自签(F1 已修死),需要「注册时序 + family 名配置错」两个前提
- descriptor 来自角色 md/config(plan §10),由可信派发方读入,不是 agent 自填 ——
  所以这更像「配置写错会静默失效」,不是「agent 主动绕过」
- 但它确实让验收条「产品代码 ⇒ 跨族评审」**静默失去保证**,而 ship 按设计**绝不重问评审**,
  完成事务是这条保证的唯一成立点 —— 所以不能只当配置问题放过

**修复建议(不要改成无条件 admission 校验)**:
无条件会**打断现有合法路径** —— `document-only-e2e` 与我的 pure-PRD 验收都在
**零 families 注册**下 admission 并完成(纯文档/纯 PRD 本就不需要评审)。
建议改在**完成侧**:需要派生评审时(有 product 产出),断言
`payload.executor.family ∈ review_families` 权威,不在则 fail-closed。
这样纯文档/纯 PRD 路径不受影响(它们根本不查 families),而任何真要评审的节点
其作者族必须是真族、必然被正确排除。

## 5. 全仓门

```
packages/v2-dag  62 passed(含 implement 新增 8 条)
qa-probe-f1b     1 passed   ← 时序无关性回归
qa-probe-f1c     1 failed   ← 本轮 FAIL 的复现,修好应转绿
pnpm lint        干净(仅他包既有 15 warning)
pnpm -r build    通过
```

---

# 复验第 3 轮 — head 38c7a8e3(2026-07-29)

**结论:FAIL(仅 F1d,LOW~MEDIUM,与 F1c 同根因)。F1c 已修好,其余全部保持通过。**

## 1. F1c 已修 —— 修法正是建议的那条

`completion.ts` `requireContract` 内新增:

```ts
if (productOutput && !Object.hasOwn(families, input.payload.executor.family)) {
  throw new DagContractError(`executor family ... is not authoritative`);
}
```

在**完成侧**断言、`admission.ts` 一字未动 —— `document-only` 与纯 PRD 两条零-families 路径因此保住。
变异验证 **KILLED**;我的 `qa-probe-f1c` 已转绿。

`completion-contract.test.ts` 被 implement 加了 7 行(注册 `family-a` + provision reviewer)。
核过:该测试的性质(eligible 耗尽 ⇒ 审计事件 + mailbox、task 保持 `running`)未变,
是 F1c 修复后的必要适配,**不是放宽**。

## 2. 回归面全部保持

| 项 | 结果 |
|---|---|
| 原 5 条修复变异 | 5/5 KILLED |
| F1c 修复变异 | KILLED |
| 静态围栏 | 6/6 CAUGHT |
| 包内套件 | 64/64 |
| 全仓 lint / build | 通过 |

## 3. F1d — 本轮 FAIL 的唯一原因(与 F1c 同根因)

**位置**:`src/completion.ts` —— 新检查挂在 `productOutput` 上。

**问题**:声明式 review 走不到这条。节点不产出产品代码、但合同里写了
`{kind:"review_approval"}`(例如文档节点要文档评审)时,在同样时序下
(admission 早于 `registerReviewFamilies`)family 仍未经校验 ⇒ `authorFamilies`
排除不掉任何真族 ⇒ **作者本族的指定 reviewer 可以满足这条声明式跨族评审**。

**复现**:`qa-probe-f1d.test.ts`(当前红)—— 节点 `status=completed`,应当被拒。

**severity LOW~MEDIUM 的理由**:ship 关键路径干净 —— 真正 gate 产品代码上线的
**派生**代码评审已被 `productOutput` 那条检查保护。F1d 只影响声明式 review,
不 gate 产品代码。前提仍是两条(注册时序 + 角色配置 family 名写错)。

**修法(Lead 已拍「修」)**:把 family 权威断言从 `productOutput` 条件里挪出来 ——
families 只要被查(`productOutput` **或** `declaredReview`),就先断言
`executor.family` 在权威表,fail-closed。约 2 行,以 `qa-probe-f1d` 转绿为准。
