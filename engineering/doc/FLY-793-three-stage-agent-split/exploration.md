# FLY-793 三段式 agent 拆分 — 探索

Issue: FLY-793 (https://linear.app/geoforge3d/issue/FLY-793/pipeline-三段式-agent-拆分-designimplementqa-各一个-agent-各配模型-可开关-77-前-fable)
日期: 2026-07-02
基于: 无

## 0. 状态 / Scope 纪律

**brainstorm 已闭环(Annie 2026-07-02 拍板 甲)。** 锁定架构见 **§2A**。已确认:三段基建大多已 merge、D/I/QA 理解、**「一条分支到底」**、**worktree 双保证 + 「ship 的是分支 B、不是 worktree」**(经 Lead 图2)、回退=统一 walk-back(§3.3)、prefer-Fable 旋钮(§5,暂时)、N-块=甲(§4)、**大架构=一个 issue / 一次 RPCI / 内部三阶段(§2A)**。下一步:**锁定 → Codex design review → plan**(跟 FLY-795 `progress.md` / FLY-799 收尾简化对齐同一甲模型)。

排期(Tadashi 定,Annie 认):
- **本 issue 现在做前半**:拆 sub-issue + 每段模型(含 FLY-767 难度路由并入)+ QA=Sonnet + **文件级交接** + **定接口**。
- **深交接(worktree 承接 + QA↔Implement 来回改的执行状态层)挂着等 FLY-795 地基**——795 定 durable/可交接接口时两边对齐,**别各造一套**。
- 字节兼容:所有开关默认 OFF/opt-in = 现状零变化。

> 本文所有分支模型/拆分选择均为**带推荐的方案**,以 Annie 拍板为准(她正在过)。不锁实现、不进 implement。

---

## 1. 现状审计(已 merge,勿重造)

| 能力 | 现状 | 关键代码 |
|---|---|---|
| **每阶段模型** | FLY-728 已落。dispatch 时带 `model` 参数,或 issue 打模型 label(`fable`/`opus`/`sonnet`/`haiku`)。resolve ladder:`手动标签` > `dispatch model 参数(Lead 分拣)` > `项目默认` > `account 默认`。 | `packages/config/src/runner-label.ts`;`lead-rules-base/model-routing.md` |
| **难度路由(强制 Lead 分拣)** | **FLY-767(793 的子 issue,In Progress,PR #418)**:precedence ① tag → ② 强制 Lead 分拣 → ③ default(Opus-4.8),fleet-wide;「难→Fable」硬线。 | `lead-rules-base/model-routing.md`(fleet-wide) |
| **Design→Implement 意图交接** | doc-flow(FLY-205):`exploration/research/plan` **commit 到分支**,下段 checkout 同分支直接读。干净、无损、file-based。 | `lead-rules-base/doc-flow-rules.md`;Blueprint 注入 |
| **独立 QA + 来回改 loop** | FLY-579/752(方案 A):独立 QA 跑单独 `QA·FLY-XX` sub-issue、指父 issue pinned commit;FAIL 保活等 `retest_wake`、`feedbackWakeMain` 唤实现者;仅 PASS 收工。 | `auto-qa-coordinator.ts`;`Blueprint.ts:786`;`agents/qa-executor.md` |
| **worktree/分支** | 每 runner 一个 worktree,分支按 **issue** 派生:`branch = worktreeName(mainRepoPath, issueId)`。 | `WorktreeManager.ts:144/260` |
| **程序建 sub-issue** | `createQaIssue` 已能编程建 `QA·FLY-XX` 并 dispatch runner。 | `auto-qa-effects.ts` |

**关键推论**:分支按 issue 派生 → 三个独立 sub-issue 会各派新分支;现有 QA 也不共享 worktree、是 fetch 父 pinned commit。所以「两 runner 先后往同一分支接力提交」是三段式真正新增、且正好是 FLY-795 的跨-agent 交接。

---

## 2. 真正「新」的只剩 4 件

| # | 新增件 | 依赖 795? |
|---|---|---|
| ① | 一个 issue 自动拆成 Design/Implement/QA 三 sub-issue + 按序接力 | 否(编排,复用 createQaIssue) |
| ② | 三段共用**同一条分支**(worktree 延续) | 深交接层依赖(接口先定) |
| ③ | QA→Implement **跨 sub-issue** 重唤起续修 | 深交接层依赖(接口先定) |
| ④ | 可开关 + 7/7 时间盒 | 否 |

（另:Design 可把大 feature 拆成 N 块,见 §4。）

---

## 2A. 锁定架构(Annie 拍板 2026-07-02 · 甲)

**一个 Linear issue = 一次 RPCI flow**;Design / Implement / QA 是这**一个 flow 内部的三个阶段**,各是**一个独立 session、各自模型**,在**一条分支 B + `progress.md`** 上接力。**Bridge 的 RPCI(整体 run 流程)不改**;**不拆成 3 个独立 sub-issue**(若要 sub-issue,只当**进度视图**、不各跑 RPCI)。

> **相对早期草案的关键更正**:单位是「一个 issue 的内部阶段」,**不是**三个 sub-issue 各跑一条 RPCI。§3/§4 的分支 / worktree / 回退 / N-块顺序机制**全部照旧成立**——只是「阶段」从「sub-issue 各自的 run」变成「同一 issue flow 内部、换模型的 session 接力」。§7 里凡写「sub-issue 拆分」按此更正为「内部 phase-session 接力」。

**① 三段在一个 issue 内怎么做 stage 转换(复用/扩现有 stage 机制)**
- 现有 pipeline 已有 stage 链:`started→onboard→brainstorm→research→plan→design_review→implement→test→code_review→pr_created→approve→ship→completed`(`flywheel-comm stage set`)。三段式 = 把这些 stage 分成 **3 个 phase**,每 phase 由**一个独立 session** 跑:
  - **Design phase(Fable)**:onboard→brainstorm→research→plan→design_review。产物 = docs + `progress.md` 落 B。(brainstorm gate + Codex design-review gate 都在此 phase。)
  - **Implement phase(Opus)**:读 B + `progress.md` 续 → implement→test→code_review→pr_created。产物 = 代码 + PR + 更新 `progress.md`。
  - **QA phase(Sonnet)**:独立验。复用 FLY-579/752 的独立 QA session,但作为**同一 issue 的内部阶段**、在 B 上、读 `progress.md`(而非另建 QA·FLY-XX sub-issue+RPCI)。**独立性靠「另一个 session + 另一个模型」保住,不是靠另一个 issue。**(与现有 auto-QA 的 reconcile = plan 阶段项。)
- **phase 边界 = session 交接点**:某 phase session 跑到边界(Design 到 design_review 完、Implement 到 pr_created)→ Bridge **结束当前 session、为同一 issue 在同一分支 B 上起下一个 phase 的 session(换下一档模型)**,经 `progress.md` 交接。**Bridge 整体 run 不变,内部从单 session 变多 session 接力**;要扩的只是「stage 边界识别 → 换模型起新 session」这一小步。

**② 每段 session 怎么带各自模型起**
- 复用 FLY-728 dispatch `model` 参数:Design phase 传 Fable、Implement 传 Opus、QA 传 Sonnet;拿不准 → prefer-Fable 旋钮(§5,暂时)。零新模型机制。

**③ `progress.md` = 内部交接载体**
- 分支 B 上的**干净进度快照**(非有损 summary)。Design 写(设计 + N-块计划 + 下一步)、Implement 读+更新(实现到哪块 / 下一步)、QA 读。回退 / 重启时下一个 session 读 `progress.md` 续做。**schema / 位置跟 FLY-795 对齐(795 owns 它);FLY-799 收尾简化也用同一甲模型对齐。**

---

## 3. 分支模型(一条分支到底,Annie 已确认)

### 3.1 一条分支 vs 分层 branch

Annie 初始设想 = **分层 branch**(Design 分支 → Implement 从其上开 → QA 再开)。分层会造出「QA 的 test 代码 + Implement 2.0 的改动怎么合」的麻烦:QA 的 Q 分支从旧的 I 开,Implement 改 I 后 Q 落后,每来回一轮要把 I 合/rebase 进 Q。

**推荐 = 一条分支到底 B**(取父 issue 分支名),三段 + 来回改**轮流往 B 上摞提交**:
1. Design commit 文档到 B;
2. Implement commit 代码到 B(摞文档上);
3. QA(若写 test)commit 到 B(摞代码上)——注:QA 也可保持「纯独立验、不写码」(现状);但要让 QA test 跨轮留存,就写进 B,一条分支照样接住;
4. QA 测出 bug → Implement 回 B 改(git 拉,见【文档+自己上轮代码+QA test】)→ push;
5. QA 回 B(见【Implement 2.0 修 + 自己 test】)→ 重跑/补 test → push;
6. 重复 4-5 直到过。

**为什么没 merge**:轮流写、同一时刻只一个 writer,每人上场 `git pull` 拿最新 B 再往上摞。QA test 与 Implement 修天然在同一条线上按时间排,永不需合分叉分支。Annie 担心的 merge 问题**直接消失**(压根没有第二条分支)。

### 3.2 worktree 生命周期 + 来回改重唤起(file-based,重启不怕)

- **分支 B = 长期存在、丢不了**;**工作区 = 每轮用完就扔的草稿纸**。每轮(首次 Implement / QA / 来回改某轮)= 在 B 上开全新工作区 → 干活 → push → 拆工作区。轮流 + 同时刻只一个 → git 永不撞「分支已被另一工作区占用」。
- **每段各有自己的 worktree、但都在同一条 B 的双保证**(Annie 2026-07-02 点名):① 每段 `git worktree add <该 runner 专属临时路径> B` 显式点名 B → 只可能 checkout B(现用 FLY-99 的 `-B` reset-or-create);② **git 硬拦**同一分支被两 worktree 同时 checkout(B 已被占则 `add ... B` 直接报 "'B' is already checked out at ...";**不 `--force`**)+ 顺序轮流 → 任一时刻恰好一个活 worktree 在 B;③ 干完 `git push` → `git worktree remove`(FLY-603 dirty-safe、不带 `--force`);④ **重启清理复用现成 WorktreeManager(FLY-99+FLY-603)**:`git worktree prune` 无条件丢 stale admin 记录,让 `worktree add -B B` 不撞 "already checked out at Y";新 runner `add ... B` + `git pull` 就在 B 上续。**B 的真身 = push 出去的提交(remote+本地 ref),worktree 可弃可重建 → 重启不丢活。**
- **QA→Implement 传话**:QA 把「错在哪」落成文件 commit 到 B(或用现成 qa-result 机制)。
- **重唤起 = 在 B 上重新起一个 Implement runner**(非「叫醒一直挂着的」):它开新工作区、git 拉 → 见【文档+已有代码+QA test+QA 错在哪】→ 照改。**状态全在分支文件里 → 机器重启也不怕**,重启后重起一个一拉接着改、不从头(直接治 709),不硬依赖 795。代价 = 每轮重读干净文件(非有损摘要)。
- **795 之后升级**:同一个 Implement 会话原地续(连重读都省、in-flight 思路不丢)。→ 现在先文件级(A),795 落再升级。

### 3.3 回退到上游(regression 到 Design)—— 同一套 walk-back(Annie 2026-07-02 新增)

更硬的回退:Implement 做完后发现 **Design 一开始就错** → 打回 Design 重做 → Design 改了、Implement 也要跟着改。在一条分支模型里,这跟 QA→Implement 来回改是**同一套机制**,只是「回退落点」更靠上游、然后**下游重新顺一遍**。

前提:分支 B **只往前加提交、从不回退历史**。「回退到 Design」不是 git 倒回,是在 B 顶上继续加提交(修正的设计 + 跟着改的实现)。
1. 重新唤起 Design(在 B 上,git 拉)→ 读【v1 文档 + Implement v1 代码 + QA test + 「为什么被打回」反馈文件】→ 写修正文档 v2 → commit 到 B 顶。
2. 下游 re-flow:重新唤起 Implement → 读【文档 v2 + 自己 v1 代码 + 「设计变了」】→ 改代码配 v2、commit → 再 QA。
3. 全程轮流摞提交、单 writer、无 merge。

**旧 Implement 代码 / QA test 怎么办**:
- **默认**:留着、在 B 上往前改(不删历史)。新一轮 Implement 拉下来照新设计改受影响部分、留没受影响的;B 的**最终状态** = v2 文档+代码+test(= ship 的东西),中间 v1 只是历史。
- **极端**(设计变太狠、旧码没用):新一轮在 B 上重写那些文件(仍往前 commit),必要时 `git revert` 反做旧提交(revert 也是往前加、干净)。
- **永不做**:回退/改写 B 历史(不 force-push、不 reset)——别人可能已拉旧 head,只往前走才保证状态一致 + 重启接得上。

**统一性**:不管回退落 Design 还是 Implement,都是同一个「重新唤起某段 + 读修正上游/自己旧产出/原因 + 往前改」+「下游 re-flow」动作。不为「回退到 Design」单独造机制。→ 这也是选一条分支的又一理由。

---

## 4. N-块拆分(Design 拆大 feature,Annie 2026-07-02 新增)

Design 把大 feature 拆成 N 块可实现的;Implement/QA 不拆、只执行/验。N 块怎么落分支/PR:

- **路甲(推荐:一条分支、N 块顺序)**:Design 在 plan.md 列 chunk 1..N(带依赖)commit 到 B;一个 Implement 段照 plan 一块块做,QA 逐块验(不对走 §3.2 来回改),N 块都过 → 一个 PR。依赖白送(同 B)、编排轻(仍 3 sub-issue)、QA 早发现;代价 = PR 偏大。
- **路乙(每块各分支各 PR)**:Design 拆完 → 每块各 Implement+QA sub-issue、各分支、各 PR,独立 review/QA/ship。PR 小好 review;但依赖块要 stacked PR(= 分层 branch 麻烦搬到块间)+ N×2 sub-issue + N thread,编排重。

**推荐甲**(与 §3.1 一条分支一套);PR-size vs 小-PR-可增量-ship 的取舍待 Annie 拍。

---

## 5. 每阶段模型 + FLY-767 难度路由并入

- 三段模型已定:Design=**Fable** / Implement=**Opus** / QA=**Sonnet**。落法 = 给三个 sub-issue 各带模型(label 或 dispatch `model` 参数),零新机制(FLY-728)。
- **767 并入**:三段式让模型路由变成**按阶段结构化**——Design=重推理→Fable、Implement=Opus、QA=简单验→Sonnet。767 的强制 Lead 分拣仍管:**非三段式路径** + **7/7 后 2-agent fallback** 里「整个 issue 该用哪个模型」。三段内=结构化 per-stage,三段外=Lead 分拣。
- **⚠️ 拿不准/稍难往哪偏的默认旋钮 = prefer-Fable / strong-over-weak(Annie 2026-07-02 拍板,覆盖 Tadashi 的 default-Opus 推荐,暂时)**:趁 Fable 窗口开着,稍微难一点的就交 Fable(宁可多花把难活做好)。所以 **issue 级 / Implement 段拿不准 → 默认偏 Fable(不是偏 Opus)**;Design=Fable 不变。**「暂时」——Fable 窗口(7/7)关闭后此旋钮重议**(那时大概率回 default-Opus)。这个默认旋钮做成配置化,跟 §6 的模型映射一起可切。
- **7/7 后**(Fable 窗口关):只改模型映射,不改编排。两条 revert 待 Annie 定:(a) 合回 2-agent(Design+Implement 同 runner Opus + QA Sonnet)【推荐,省一次交接】;(b) 保持 3-agent 但 Opus/Opus/Sonnet。

---

## 6. 开关 + 时间盒 + 可见性(④⑤)

- **一个 mode flag**(config 键,非硬编码)控:是否三段拆分 + 三段模型映射。default OFF = 现状零变化(对齐 doc_flow/auto-QA opt-out 纪律)。
- **可复用**:flag + 模型映射配置化 → 以后别的「强而便宜」模型(不只 Fable 5 天)可直接复用(issue「不只为这 5 天」诉求)。
- **阶段可见**:每段一 sub-issue = 每段一 `[FLY-XX]` thread;复用 FLY-560 stage emoji + FLY-728 模型短码,标题即显「哪段+哪模型」。零新机制。

---

## 7. 前半要定的接口(本 issue 现在做)

先把「不依赖 795」的接口钉下来,让 795 的深交接层能对齐插入:

1. **三段拆分契约**:父 issue → 3 sub-issue(Design/Implement/QA),各带 stage 标记 + 模型;event-driven(上段 completed → 建/派下段),复用 createQaIssue 同构。
2. **共用分支契约(接口,深交接实现挂 795)**:三个 sub-issue 钉死同一分支名 B(取父分支)。**接口** = 「dispatch 一个 runner 时可指定它落到分支 B(而非按自己 issueId 派生)」。这是 795 durable 交接要接的插座 —— 现在**定接口**,实现随 795。
3. **QA→Implement 反馈落分支契约**:QA 的「错在哪」落成分支上的文件(或复用 qa-result),Implement 重起时读。
4. **重唤起契约**:「在分支 B 上重新起一个 Implement runner、带上 QA 反馈」——现在定成 file-based;795 升级为同会话续。
5. **toggle/模型映射配置**:mode flag + per-stage 模型表(配置化,7/7 后改映射即 revert)。

**具体代码锚点(前半、与分支模型无关,可先钉):**
- **①拆分/接力** 复用 `auto-qa-effects.ts:156 createQaIssue({parent, ...})` + `buildQaIssueContent`——已能用父 issue 的 team 编程建子 issue;三段拆分同构建 Design/Implement sub-issue。event-driven 接力挂 `auto-qa-coordinator` 现有的「session_completed → 建下段 + dispatch」位点。
- **④mode flag** = `.flywheel/config.yaml` 新 key(如 `pipeline.three_stage`),由 `ConfigLoader.ts:317` 那套 optional-mapping 校验加载(镜像 `doc_flow`);policy 解析镜像 `auto-qa-policy.ts:38 resolveAutoQaPolicy`(default-OFF、malformed 时 fail-closed)。
- **每段模型** 复用 FLY-728 dispatch `model` 参数(§5),无新机制。

---

## 8. 对 FLY-795 的需求(深交接层,两边对齐、别各造一套)

- **R1 单分支跨-agent 延续**:后段 runner 落到前段分支 B(§7.2 接口);795 定「分支/worktree 归属如何跨 sub-issue 传递、同时刻单 writer、交接原子」。
- **R2 干净进度快照(非有损)**:每交接点产物干净可续(docs commit 已满足 Design→Implement;795 保证 code+执行进度也非有损摘要 —— 795 正题)。
- **R3 跨 sub-issue 续修**:file-based 重起(§3.2)先行;795 升级为同会话原地续。
- **R4 与守护交互**:交接/重起的 runner 不被 idle-watchdog/reconciler/reaper 误杀(FLY-752 已趟一版)。

**对齐信号(Tadashi 2026-07-02)**:795 的 durable/可交接进度接口初步形态 = 分支上的 **`progress.md`**(干净进度快照,非有损 summary)。→ 793 的「阶段交接 + 回退 + 重启续做」都读写这个 `progress.md`;plan 阶段与 795 对齐它的 schema/位置,**别各造一套**。§7.3(QA 反馈落分支)、§3.2/§3.3(重起读干净文件)都汇到这个接口。

### 8.1 793 对 `progress.md` 的消费需求(供 795 定 schema;793 只消费不定死)

1. **phase + 步骤游标**:当前 phase(design/implement/qa)+ phase 内细粒度步骤(如做到第几块、子步)——够一个 fresh session 中途续起。
2. **N-块计划 + 每块状态**:块清单(id/顺序/依赖/done 判据)+ 每块状态(todo/doing/done/qa-pass/qa-fail)。
3. **每个交接边界的 payload**:design→implement(设计摘要 + docs 指针 + 块计划);implement→qa(PR/commit + 各块状态);qa→implement(findings + 失败的块);founder/流程→design(回退原因)。
4. **产物指针**:B 上 exploration/research/plan 路径、PR 号、reviewed commit sha。
5. **写入纪律**:仅当前 active phase 单写;每个有意义步都 commit 到 B(重启至多丢最后一个未提交步);干净结构/散文(非 raw diff —— 呼应「completion 存干净摘要非 raw diff」的方向)。
6. **模型/phase 映射在外**(config §6,非 progress.md):progress.md 只记 phase,不记模型选择。

> 这些是 793 的**消费需求**,交 FLY-795 定 `progress.md` 的 schema/位置;FLY-799(收尾简化)同模型对齐。

---

## 9. Open questions 状态

| # | 问题 | 状态 |
|---|---|---|
| Q-branch | 一条分支到底 vs 分层 branch | ✅ Annie 确认「一条分支到底」(含回退到 Design §3.3) |
| Q-nchunk | N 块:一条分支顺序(甲) vs 每块各 PR(乙) | ✅ Annie 确认 **甲**(一个 issue 内部 phase 顺序,§2A) |
| Q-arch | 一个 issue 内部三阶段 vs 三 sub-issue 各跑 RPCI | ✅ Annie 确认 **一个 issue / 一次 RPCI / 内部三阶段**(§2A;Bridge RPCI 不改) |
| Q-trigger | 哪些 issue 开三段式 mode | 待过(建议 per-issue opt-in;mode 触发、非拆 sub-issue) |
| Q-revert | 7/7 后合回 2-agent vs 3-agent Opus/Opus/Sonnet | 待过(建议合回 2-agent) |
| Q-qacode | QA 是否写 test 代码进 B(vs 纯独立验) | ✅ Annie 拍 **QA 给写权限**(写 test/report 进 B,权限跟别的 issue 一样);三段全顺序 writer(plan Step 3/8) |
| Q-autoqa-reconcile | 三段式内部 QA phase 与现有 auto-QA(FLY-579/752 独立 sub-issue)怎么 reconcile | plan 阶段(与 795/799 对齐) |

---

## 10. 本 session 明确不做

- **不**锁深交接实现(§8,等 795,先定接口 §7)。
- **不**进 implement / 不开 PR。
- 交付 = 本 framing 文档(committed)+ 与 Annie 互动过分支/拆分模型 + §7 接口 + §8 需求交 795。
