# PRD · founder-approval 绑定根治 —— 让 Annie 的批准真的算数

Issue: [FLY-1211](https://linear.app/geoforge3d/issue/FLY-1211) · 日期: 2026-07-13 · 作者: Honey Lemon (Product Lead)
基于: Annie 直令(2026-07-12「先讨论清楚该怎么修,再动代码」)· 2026-07-13 与 Annie 逐轮共创(~13 轮)· Tadashi 工程交底 + 生产 commit 数据 · Aunt Cass 独立复核 · 我的源码核查 · Codex design-review round-1/2

> **状态: v6 —— ✅ Codex design-review APPROVED(3 轮:round-1/2 CHANGES-REQUESTED → v5 consolidate → round-3 APPROVED)。** Annie 主导收敛、定主通道 = A(§7)。单一权威契约,契约级修订全并入正文。v6 加了 round-3 的 3 条非阻塞 wording/telemetry 收尾。
> **范围决定(v5,Codex round-2 #2):本 PRD 的 ship-gate 契约 scope = 可 merge 的代码仓库工作流。** run-level barrier 在这个 scope 内**与图形状无关(段数无关)**。非代码流(如 product 模板「出 PRD → founder 批」)**复用**同一个 run-barrier 原则,但它的 artifact 身份 / founder 动作 = **单独规格**,不在本 PRD(见 §9)。
> **eng 机制层(barrier / ship_subject schema / 卡状态机 / freeze_epoch / 单一 approval authority)= 待与 Tadashi co-design**(输入见 §12)。
> **可视化:** [讲解](https://fw-reports-a53de2.vercel.app/r/9baeac72261e1d324e42dd1b072eeb6a/) · [收敛设计](https://fw-reports-a53de2.vercel.app/r/421e3dafc9e987775523de37f5153b88/)

---

## 1. Problem —— 她是在流沙上签字

Annie 在 thread 里清楚地说「合 / ship / OK」,系统认不出、resolve 不了对应的 approve gate,全部 fallback 到 `founder_reply_ambiguous`,每次 ship 都要 Tadashi 人肉中转。修了三轮(FLY-799 → 1099 → 1198)仍未根治。

**真正的机制(源码 + 生产数据核实,不是推测):**

1. **确定性的 ✅ 通道其实早就建好了,而且是活的。** FLY-799 的 founder ✅-reaction 批准路径已实现、已在 `plugin.ts` 注入(default-on,但可被 `FLYWHEEL_FOUNDER_AUTO_APPROVE=0` / `FLYWHEEL_FOUNDER_REPLY_DELIVER=0` / 项目 denylist / canonical-founder 未解析 抑制 —— 见 R9 的通道-中断契约)。
2. **但它把批准钉死在「当时那个代码版本」上。** `selectCurrentBinding` 要求 `(questionId, prHeadSha)` **精确相等且唯一匹配**,查询用的是**当前** head:

   ```ts
   bindings.filter(b => b.questionId === questionId && b.prHeadSha === prHeadSha)
   return matches.length === 1 ? matches[0] : null;   // 否则 null
   ```
   代码注释原话:**「No binding → no reaction approval」**。

3. **代码一直在动 —— 而且是合法地动。** Tadashi 拉出 FLY-1188 的真实 commit:**3 张卡背后 6 个 commit,其中 4 个是真代码修复**(QA 抓到 founder TUI 是死的、每个 runner 漏进程 → 代码必须改)。
   👉 **head 漂移不是异常,是常态。**「审 → 修 → 再审」这个环本身就会动 head。

4. **于是:head 一动 → 系统重发一张新卡(能用)→ 但老卡还在、还能点 → 她点了,静默无效、不报错。**
   她的 thread 里躺着 **N 张能点的卡,只有最后一张是活的。**

> ### 🔑 一句话
> **逃生通道从来没坏 —— 它一直在挪位置,而没有人告诉她原来那张已经是尸体。**
> **而我们是在分支还在动的时候,就把卡递到她面前的。这等于让她在流沙上签字。**

**并且这解释了根因 #4:**「老卡尸体」和「一个 thread 多个 gate、分不清她答哪个」**是同一个 bug 的两张脸**。

**最阴的一条(无人按下按钮的漂移):**
runner 的 `progress` 工具**每调用一次就自动提交一个 commit**。没有人做这个决定 —— **是一个工具自己把 head 推走,把一道已经挣到的门作废掉**。FLY-1182 上 Codex 的批准就是这么没的。Tadashi 拦下时,差 5 分钟就把一个「点了会被拒」的 gate 递到 Annie 面前。

---

## 2. 病因 —— 🎭 替身冒充本体

「静默 no-op」是**症状**。病因是:**拿一个便宜的代理指标,去站真东西的位置 —— 然后在它不再等价的那一刻,一声不吭地失效。**

| 替身 | 冒充的本体 | 失效时 |
|---|---|---|
| `prHeadSha` 相等 | 「这还是同一份代码」 | 老卡成为能点的尸体 |
| 一段注释 | 一道 guard | 门上贴「已上锁」的纸条,门没锁 |
| 一个 sha | 「这段代码被审过了」 | FLY-827 荣誉制度:runner 自己声明自己的 Codex 结果 |
| 一个谓词 (`isThreeStagePhaseRole`) | 三个不同的问题 | implement 段拿到 QA 段的豁免 → 一条**零 QA 就能 ship** 的旁路 ¹ |
| `grep` 的调用点计数 | 「到底接没接上」 | 把 closure 注入误判成漏接(Tadashi 亲踩) |
| 「我查过一个相邻的东西」 | 「我查过这个东西」 | 我断言 sandbox Bridge 与 prod 共用 comm DB —— 实测是两个库(Honey Lemon 亲踩) |
| `env` 里写的 DB 路径 | 进程真正打开的那个库 | 沙箱 env 写 prod、fd 表显示 test-slot-1 —— 判据只有 fd 表(Cass 亲踩) |
| 「fail-closed」这个标签 | 「对不可逆的那一侧关上了」 | `auto-qa-config-source` 对 QA 关上、**对 ship 敞开** ² |
| localhost 上活着 | 「已入库」 | dashboard 只活在 /tmp,一次清理就没 |

> ¹ **精确形状:它生在 FLY-1204 的修复分支,死在 Codex 那道门上,从来没进过 main。**「我们的门在它离开分支之前抓住了它」。(Cass 逐个枚举 `origin/main` 6 个调用点复核:无一是 ship 豁免。)
> ² 一个 typo,静默豁免掉整个项目的 QA 要求,没人被告知。当前实际风险 ≈ 0(FLY-1206 已全局关 auto-QA),收进本 PRD 只为**让不变量站得住,别让它换个地方复活**。

> **每一个都是好心做的 —— 大家都在替 Annie 省事,然后把不可逆的那一侧敞开了。fail-open 从来不是懒,它总是伪装成体贴。(Aunt Cass)**

### 2.1 潜伏的洞(不是活证 —— 这条我最初写错了,原样留错在这里)

fd 表实测:一个沙箱 Bridge(FLY-1204)与生产 Bridge 同时握着两个生产库。**理论上**沙箱写一条 dedup → 生产真消息被判「重复」→ 静默丢掉。**但实测(Tadashi):两张表 `rows = 0`、一个多月没写 → 没有任何消息在被吞。**

> ⚠️ 我最初把它写成「活证」。那是假的 —— 洞真、机制通,但一个字节没写过。P1 潜伏,不是 P0 出血。**🎭 最恶劣的替身:「更好看的证据」冒充「真证据」,而我在这份骂这个病的文档里干的。⇒ 未实测的证据一律标 UNVERIFIED;宁可论点弱,不可证据假。**

### 2.2 🔴 三个人,两套错证据,同一个不可逆动作 —— 本 PRD 最贵的一课

那天我们三个差点一起把 Annie 的一个 live demo 杀掉。我给了三条「它是废弃的」证据 —— 全部落空(prod runner 列表里没有它 = 它 session 在沙箱登记册;TCP ESTABLISHED=0 = runner 走 comm DB 不走长连接;9 小时没 commit = parked 的东西本来就不动)。

> ## 🎭 「parked」和「abandoned」的外部 signature 一模一样。我读到「静止」,写下「废弃」—— 选了会致命的那个解读。
> ### 最该记住的(Cass):一个错误的不可逆动作,被两个人用两套完全不同的错误证据各推了一次 —— 那一刻它长得就像交叉验证。

**⇒ 硬规矩(每个不可逆动作,含 ship):① 动手前打开它看里面到底有什么(不是看外部信号);② 「静止」不是「废弃」的证据,要正面证明没人依赖它;③ 两条独立证据指向同一个不可逆动作 → 先怀疑结论先行。**

---

## 3. 🧭 北极星(硬性不变量)

> ### 授权链里不许有静默 no-op
> · **批准**必须**生效**,或**明说为何没生效**。 · **拦截**必须**拦住**,或**明说为何没拦住**。
>
> ### 授权守卫一律 fail-closed
> · 证明不了自己查过 hold + subject 的批准路径,**必须拒绝写入**。 · **任何标着 fail-closed 的地方,必须写明「对什么 fail-closed」;说不出来的,一律当 fail-OPEN 处理。**
>
> ### 安全方向由「不可逆的那一侧」定义 —— ship 不可逆 ⇒ 疑则不放。
>
> ### freeze_epoch 内,只有「决定」可以移动 head
> · **在一个 active 的 `freeze_epoch` 期间(readiness barrier 成功后进入、卡激活前,并持续到授权/ship 完成),任何「没有人按下按钮」的自动分支写入 = P0。**(不是「任何 open review gate 都冻」—— 审/修环合法地需要写;冻的是 readiness 之后那一段。见 R7。)

**在 ship 路径上「静默吞掉」= P0,不是打磨项。**

---

## 4. Users / Goals

**用户 = Annie(唯一的 ship 授权人)。** 次要 = Lead(今天被迫人肉中转)、engineers/QA runner。

**Goals**
1. Annie 的一次批准,**要么生效,要么当场告诉她为什么没生效** —— 永远不静默。
2. **同一个 gate epoch / 同一份未变的 subject,至多只有一张「活的、可授权」的卡**;她永远点不到能授权的尸体,且**每一次点击都有明确回应**(哪怕是「这张已过期」)。(「一张可见的卡」= 尽力 SLO,见 R1。)
3. 她**不会为同一份未变的内容被反复叫来批**。
4. **点完卡,除非「批准的内容(subject)变了」,否则不再需要她做任何决定。**(不是时间保证:main 可能再动、CI 可能再跑,但那些是机械的、有可见状态的;只有内容真变了才回头找她。见 R4 post-click 契约。)
5. **Lead 彻底退出授权链** —— 兜底不再是「找个人来绕过」。
6. 闸门**不写死认某一家(Codex)** —— 通用、政策可配、fail-closed。

**Non-goals**
- 不改 ShipGate 的存在(founder 批准才能 ship 这条红线不动)。
- 不追求「消灭 head 漂移」—— 合法漂移是常态,消灭不了。
- 不设计 DAG 引擎/花名册本身的机制(Tadashi 的 FLY-1020/1135/1140/1141)。
- **不覆盖非代码工作流的 ship-gate**(product 模板等 → §9 单独规格)。
- 不做 PM 验收(FLY-830)。

---

## 5. Requirements —— ship-gate 契约(单一权威版)

> Annie 2026-07-13 逐轮主导收敛,核心洞见:**根本不该有能授权的老卡。** 契约 scope = 可 merge 的代码仓库工作流;run-level barrier 在此 scope 内**段数无关**(一段 / 二段 / 四段 / 并行 / optional-skip / retry 都成立)。下文「三段式 / QA」仅为举例;「QA 节点」= 泛化为「该 workflow 里负责那件事的节点」。

### R1 · 至多一张「活的」卡,发在 readiness 之后
- **卡只在一个时间点进入 active:整个 workflow run 通过 readiness barrier(R2)—— 所有该审的审完、所有测试绿、subject 冻住 —— 之后。在那之前不发可授权的卡。**
- **硬不变量**:① **同一 workflow run / gate epoch,至多一张「活的、可授权」的卡**;② **每一次点击都有明确回应**:**active 卡 + 写入前的 live 授权检查(subject/hold,R8)都通过 → 记批准;否则返回明确的 blocked 原因**(如「hold 中」「这张已过期」),绝不静默吞。(「active」不等于「跳过授权检查」—— 见 R8。)
- **「一张可见的卡」= 尽力 SLO**,不是硬保证 —— 因为 Discord/DB 半失败下(现在的代码:先发卡、再 best-effort 写 binding,失败当非致命)会留下「可见但绑不上」的卡。安全性靠「活卡唯一 + 点击必回应」,不靠「可见卡唯一」。
- 合法漂移导致必须换卡时:**先 retire 老授权、再 active 新卡**,绝不叠两张能授权的。
- *(eng 机制 §12)* 耐久卡状态机 `posting→active→retiring→retired`,at-most-one-active 约束,binding 落定才 active,继续观测 retired message ID 以回应 stale 点击。

### R2 · Ship 闸 = workflow-RUN 级 readiness barrier(不是「一个节点」)
- **ready 判据**:`终点条件满足 ∧ 同一 workflow_run_id/generation 的每一个 required obligation 都对着 frozen subject 满足了 ∧ 没有 active hold`。
- 绑到「一个节点」会重新引入隐藏的 stage 假设(旧 retry 的迟到事件满足新 run;并行 producer 被漏)。barrier **汇齐这个 run 所有 required 输出,与图形状无关**,显式覆盖:并行分支 / optional-skip / retry generation / stale 事件。
- 发卡前的冻结检查含:该审全审完 + 测试全绿 + 已 rebase 到最新 main 且无冲突(缩小「发卡后 main 又变」窗口)。
- *(eng 机制 §12)* 持久化 `workflow_run_id`(或 root execution + generation)、node attempt identity、materialized policy/obligation snapshot。

### R3 · 每个产出代码的节点都被审;review = 一组 obligation
- **顺序**(三段式举例,其它同理):工程师写生产代码 → 审;**该 workflow 里负责测试的节点(三段式里是 QA)写真回归测试代码**(进 repo、CI/CD 长跑,挡新 feature 改坏老的)+ 跑;bug → 改生产代码 → 重审 → 再跑,**全在卡之前转完**;全绿 + 冻住 → barrier ready → 发卡。
- **测试代码 = 真代码 → 要过 review;报告 = 不审(非 ship-relevant)。**
- **review scope(说死,别自相矛盾)**:最后的 reviewer **可以看完整 integrated diff 作上下文,但只 attest「测试 delta」**;implementation review 仍绑在**未变的生产代码 manifest**(靠 R4 的 subject 保证没变,不靠 head 相等 —— 否则加测试挪了 head 会作废 impl review)。
- **对称原则**:每个产出「代码」的节点配一道 review(Design→Design Review · Implement→生产代码 review · 测试节点→测试代码 review),补上 QA 段现在缺的这道。
- *(eng 机制 §12)* review 建模成 obligation 集(每个 keyed by workflow-run / node-attempt / artifact scope / subject digest / author family / snapshotted policy);**一个可信 node registry(不是 runner)声明哪个节点产出可审代码**;run 中途改 policy 不得静默改本 run 的 obligation。

### R4 · 闸认「内容(canonical ship_subject)」,不认「raw sha」 【根治漂移】
- 闸门比的是**「要 ship 的那套」的内容变没变**,不是版本号变没变:
  - **只加报告 / 日志**(非 ship-relevant)→ 自动放行。
  - **干净 rebase**(无冲突、内容没变)→ 系统自 rebase + **在精确新 head 上重跑 CI** → 绿了直接 ship,**批准照样有效,不重审、不重发卡**。
  - **解冲突改了代码**(真新代码)→ **重审 + 重发一张卡**(合理、少见)。判断:解冲突最容易埋 bug,跳过审 = ship 没审过的代码 = 拿旧批准盖新代码(替身)。
  - **谁解冲突**:代码 owner 解(生产代码冲突 → implement;测试冲突 → 测试节点),解完按政策重审 + 重跑。角色派发 → 花名册 FLY-1141。
- **授权用的「内容」= 一个 canonical + versioned `ship_subject`,由 Bridge 从 Git 对象算出、fail-closed、绝不许 runner 自报**(自报 = 替身:自报冒充真相)。
  - subject 至少含:repo/workflow-run 身份、policy 版本、精确 paths、operations/renames、file modes、**每个 ship-relevant 改动的 before/after blob ID**。
  - **默认每个可 merge 文件都 ship-relevant**;豁免只能来自受信、snapshotted 的 allowlist,**绝不用 runner 分类**;`patch-id` 只当**诊断 hint**(它归一化空白 → 对 Python/YAML 不安全,不能当授权依据)。
  - **分开两件事:①「被审/被批的改动 manifest」(clean rebase 下可保持不变)· ②「required CI 实际跑在的候选 head」。** 在**卡激活 / 记批准前 / 任何 rebase 后 / merge 前**各重算并比对。最终 merge 要求:**批准 subject 未变 + required CI 在精确候选 head 上绿**。
- **merge/ship 必须走库的 CI/CD flow,不许绕过(Annie 2026-07-13):** 最终的 merge/ship **只能经由标准 ship flow**(`:cool` → CI/CD → 合)执行;**任何人(含 Lead)都不许用 `--admin` / 直接 merge 绕过 required CI**。**绕过 CI = 绕过 ship 闸 = 本 PRD 北极星禁止的那类静默 bypass** —— 它让「required CI 绿」这个授权前提变成一个可被 admin 抄近路的替身。**docs-only 也不例外**;若某类 PR(如 docs)走 `:cool` 有问题,那是**要修的 flow wrinkle**(接 FLY-972 / CI decouple),不是 admin 抄近路的借口。(实证:本 PRD 自己的 #573 被我用 `--admin` 抄了近路 ship —— 一个活的「绕过 ship 闸」反例;这条就是把它写死禁掉,让 PRD 自洽。)
- 数据支撑:实测 head-drift 里 4/6 是合法漂移 —— 内容锚把这大多数从「重审税」解放,只对真改生产代码的少数收税。
- *(eng 机制 §12)* subject 的序列化 / hash 算法 / schema / 迁移列 = Tadashi(范式 in-toto/SLSA subject digest)。

### R5 · 闸门通用 —— 认「required review 满足」,不钦定 Codex 【Annie 直令】
- **闸门只问:「这段代码,政策要求的 review 做了没、过了没?」不写死认某一家的记录。**「Codex 没参与」≠ 被卡;「政策要求的 review 没做」才卡。
- **现状精确版(Codex 核代码)**:*已 live* —— FLY-1188(`53364ac09`,main)给记录加了服务端盖章的 `reviewer_family/author_family` + `crossFamilyReviewSatisfied` 双侧硬拒同家族;两条 lane 活(Claude 写→Codex 审、非-Claude 写→Claude 审);schema 本身 vendor 无关。*还没到* —— ① `codex-gate.ts` 现只认 `main|implement`、**排除 `qa`**;② 反向 lane 永远选 Claude reviewer;③ 存储/API 仍 Codex 中心命名;④ FLY-1224 双向作者指引未进 main。**真正的活 = 任意-vendor 政策 + reviewer 选择 + 产出代码节点发现 + 泛化命名/迁移**(比「命名/政策」重)。1224 C10 = 「在 Codex-authored stage 启用反向 lane」的前置条件。

### R6 · 审查政策:默认跨公司审;豁免的权限与「无合格审稿」行为
- **默认政策 = 跨公司审**(reviewer ≠ doer 的 vendor):自己审自己 = 假审(替身)。复杂度是**一条规则**(系统按「≠ doer vendor」自动选,想指定才 override),不是组合表。reviewer 不常驻,每段一双新的独立眼睛。
- **安全默认 = 要审**。**豁免的权限(Codex round-2 #4)**:只能来自**受信的 canonical policy** 或**显式授权的 founder/governance override**;snapshotted 到 run、scoped、在卡/审计上可见;**绝不能从「没有合格 reviewer」推断出豁免**。
- **「没有合格的跨家族 reviewer」→ 顶住 barrier + 给出明确运营原因,绝不 auto-exempt**(否则 fail-closed 不变量破)。

### R7 · freeze_epoch —— 无人按钮不许动 head(让「一张卡」成立)
- 定义一个明确的 **`freeze_epoch`**:**只在 readiness barrier(R2)成功后、founder 卡激活前进入**。这个 epoch 内:所有第一方分支 writer 必须**取 server-owned mutation lease + fail-closed**;`progress` 要么在 freeze 前提交、要么把 ledger 持久化到 ship 分支之外(**不全局删 `progress` 自动 commit** —— 那会回退 FLY-795 recovery ledger;且 `progress` 现已「session 非 running 就拒绝」);**任何观测到的外部改动 → 原子作废 epoch/卡 + 明确原因**。最终 merge 检查兜底。

### R8 · 一个强制的 approval authority + fail-closed 【FLY-1221】
- **精确事实**:hold guard 已注入 founder 三条通道(文字/✅/voice);漏的是程序化入口 `approveExecution`(写 `approved:true` 时零 hold 检查)。当前风险 = P1(`FLYWHEEL_ATTRIBUTION_HOLD_ALIGN` 活进程全未设 → HOLD 现在真生效),不是 P0。
- **要求:一个强制的、服务端的 approval-authority 操作,reaction / text / voice / router / `approveExecution` 全部走它。** 它:区分「批准」与「反馈」;写入前**立即重读**当前 run/gate/epoch/subject + hold;任何读失败/错误 **fail-closed**;返回 **founder 可见的原因**;response + transition 幂等。最终 merge 再校 subject + hold(纵深防御)。
- **`FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` 那个静默旁路 → 删掉,或定义成「响亮、founder 授权、带身份/原因/过期/审计 + 明确 blocked-card 状态」的紧急动作。** 静默 env 旁路与 fail-closed 不变量矛盾。

### R9 · 兜底 = 回头问她;通道中断时不许指向死卡
- 文字表达批准、但当前有 active 卡:**回她一句直接指向那张 active 卡**「请点这张卡的 ✅」。
- **通道中断契约(Codex round-2 #3)**:卡只能在**其批准通道可用时**为 active;关掉 reaction 摄取 / 抑制通道 → **必须 retire/block active 授权,并把这个状态做成可见 + 可告警**;若**没有 active 卡**,明说「批准暂不可用 / 正在重建」,**绝不叫她点一张授权不了的卡,也绝不路由给 Lead 授权**;通道中断期间观测到的点击,恢复时**要么 reconcile、要么明确告知未被接受**。
- **今天的 fallback(转 Tadashi 人肉中转)删除** —— Lead 退出授权链(Lead 仍可收运营告警)。

---

## 6. Success metrics(与 §11 对齐)

**主指标 = 「每个未变的 ship subject,只找 Annie 授权一次」** —— 不是「每个 issue 一条可见消息」。
- **测量窗口 + 分母**:滚动 30 天内所有「激活过 founder 卡」的 workflow run;**改了 subject 的 run 算一次新的 subject attempt**(不计入「反复批同一份」)。
- **一次成功** = 一次被接受的 founder 授权 → ship,或一个明确的 non-authorization 终局;且 **subject 不变期间没有第二次 founder 请求**。

| 指标 | 现状 | 目标 |
|---|---|---|
| 每份未变 subject 的 founder 授权请求次数 | 反复(1188 一次 ship 4 张卡) | **1 次** |
| 需 Lead 人肉中转才 ship | 每次(≈0 自动) | **0(≥95% 自动一次成功)** |
| Lead 参与授权 | 每次 ship | **0** |
| **能授权的 retired/stale 卡**(硬安全,恒为 0) | N-1 张能点的尸体 | **0** |
| **stale 点击无明确回应**(硬安全,恒为 0) | 静默吞 | **0** |
| **held 时记录了批准 / merge subject ≠ 批准 subject / merge 缺 snapshotted obligation / active 卡无 binding**(硬安全,恒为 0) | 有洞 | **0** |
| 闸门认的 vendor | cross-family 判定 live,但仍认 `main\|implement`、Codex 中心命名 | **任意 vendor 政策可配 + 产出代码节点都可审** |

---

## 7. ✅ 主通道 —— Annie 定了 A(2026-07-13)

- **主通道(A):** 她**点最新那张 active 卡的 ✅** —— 确定性、不靠 AI 猜。
- **保留(B):** 打字「合」也行,**但绝不静默** —— 有 active 卡就指向它;没有就明说为何不可用(R9),绝不悄悄找人中转。

---

## 8. 工程可行性 —— Tadashi 已核(2026-07-13,现状部分)

- **现在那道闸查什么**:一条绑 `(execution_id, PR head sha)` 的 APPROVED 审查记录,sha == 门检时真实 head(漂移即作废);1188 后带服务端盖章 reviewerFamily + 双侧 crossFamilyReviewSatisfied。
- **三个核心机制方向可行**:policy-driven 任意 vendor 闸 · 内容锚(in-toto/SLSA subject digest 范式)· QA 段补 review / ship 闸=run barrier / 冲突归属→1141 —— Tadashi 都赞成进 PRD。
- ⚠️ **v5 相对 Tadashi 首轮 read 扩大了 scope**(Codex round-1/2 加的:run-barrier / obligation 集 / canonical ship_subject / 卡状态机 / freeze_epoch / 单一 authority)。**这些是新的 eng-design 输入(§12),待 co-design** —— 不是「命名/政策就完」(那是早前的过头说法,已修正)。
- **仍 open**:「静默/冻结/内容相等」判定一律 **Bridge 侧客观计算,不许 runner 自报**。

> 📎 弹药:1135 的 ChatGPT DR 报告《Workflow-Orchestration Patterns for a Multi-Agent Coding System》(21 引用)有整章 —— GitHub required-checks 按最新 sha + stale-approval 自动作废、Temporal task-token 短时效 claim、in-toto digest 绑定。`/tmp/fly1135-dr-report.md`。

---

## 9. 范围 & 接缝

- **本 PRD 拥有(scope = 可 merge 的代码工作流)**:卡何时 active(R1)· run-barrier(R2)· review obligation(R3)· 闸认什么(R4/R5)· review 政策 + 豁免权限(R6)· freeze_epoch(R7)· 单一 authority(R8)· 通道中断兜底(R9)· 北极星。
- **非代码工作流(product 模板「出 PRD → founder 批 → 入库」等)= 单独规格,不在本 PRD。** 它**复用**同一个 run-barrier + 单一-authority + 不静默 原则,但更简单(无 CI/测试);其 artifact 身份 / content subject / founder-批准动作 / 成功终局要在那份规格里定。*(⚠️ Annie:早前我拿 product 模板当「段数无关」的活证 —— Codex 指出那把「代码 ship」和「非代码 artifact」混了;v5 把 1211 收敛到代码工作流,run-barrier 在此 scope 段数无关;product 模板那条留作 §9 的后续规格,设计原则不变。)*
- **接 Tadashi 的 DAG 程序**:闸位置随 DAG(R2 → FLY-1135 模板做成数据)· 谁演角色/谁解冲突(→ 花名册 FLY-1141)· DAG 引擎(1020/1140)。
- FLY-827 荣誉制度(`codex_thread_id` 永远 NULL)被 R5/R8 一并根治(闸认真实 review 记录 + 单一 server-authority,不认自报的 sha)。

---

## 10. Build 顺序 —— 按依赖切片,不是 R1–R9 一对一

⚠️ **不要一对一拆单。** 它们混了「即时 founder-绑定安全修复」和「workflow-DAG 平台化」,有真实 authority 依赖。切片:

1. **即时安全补丁(先止血,不等平台化)** —— R8 单一 approval authority · R9 明确歧义/通道中断回应 · binding 失败耐久升级 · stale-card 拒绝并回应。**先修掉当前的「静默卡 / hold 后门」bug。**
2. **Authority 底座** —— materialized `workflow_run_id`/generation + policy snapshot · 泛化 gate/review accessor(view 包旧表)· versioned `ship_subject` service · gate epoch / 卡状态 存储。
3. **证据生产者** —— R3/R5/R6 per-node review obligation + 两个 author-family 发起路径(含 QA-authored 代码)。
4. **终点 barrier + 冻结** —— R2 run-level 汇聚 · R7 mutation lease/invalidation · 然后 R1 单一 active 卡。
5. **携带 + 自动 ship** —— R4 rebase/内容携带/CI/merge-queue 状态机;**先 shadow-compare 现有 exact-head predicate 再启用,迁移期 dual-write,最后拆旧 rebind + 人肉授权 fallback。不把旧 head 批准 backfill 到 content subject;迁移要全新 gate epoch。**

> 最终契约留 FLY-1211;按依赖切片给 Tadashi 队列(`Flywheel` 标签)。**PM 验收 = 未来 FLY-830,现在不做。**

---

## 11. 验收 —— 对抗用例矩阵(每行都要写明「期望结果」)

已知 bug 由**竞态 + 半失败**产生 → happy-path 测试会绿而静默 no-op 仍在。契约测试至少含(每行标明期望的 invariant/状态转移):
- **DAG 形状**:一/二/四节点线性 · diamond/并行 · optional-skip · retry generation 带迟到 stale 事件 → *期望:barrier 只在同 generation 全 obligation 满足才 ready;stale 事件不满足新 run*。
- **半失败**:Discord 发成功但 binding 写失败 · binding 成功但激活失败 · 重复投递 · 每个卡状态下 Bridge 重启 · active/retired 卡上的反应 · 反应摄取关掉但卡还在 → *期望:无「active 无 binding」卡;retired/中断态点击都有明确回应;never 静默*。
- **hold/授权**:hold 在写入前 / response↔transition↔merge 之间出现 · StateStore/CommDB 读不出 · **每个批准入口(含 `approveExecution`)** → *期望:全部 fail-closed,held 时不记录批准*。
- **内容**:report-only · 精确内容变 · Python 缩进/空白变 · rename/mode/binary/config/migration 变 · clean rebase · 重叠 base 变 · 解冲突 · CI 失败 · CI↔merge 之间 main 动 → *期望:仅 non-ship-relevant/clean-rebase 携带批准;任何 ship-relevant 内容变 → 对应 review obligation + founder subject 必须刷新(强制重审);merge subject 必等于批准 subject*。
- **多审**:多个产出代码节点 · 同家族审被拒 · 显式豁免 · run 中途改 policy · 测试代码 review 汇聚 · **无合格 reviewer** → *期望:barrier 汇齐所有 obligation;无合格 reviewer 顶住不 auto-exempt*。

**硬安全计数器**(见 §6,必须恒为 0):active-卡-无-binding · stale-点击-无-回应 · held 时记录批准 · merge subject ≠ 批准 subject · merge 缺任一 snapshotted obligation。

---

## 12. Eng-design 输入 → Tadashi(机制层,= 他的设计空间)

本 PRD 定**契约 / 不变量 / 失败可观测结果**;下列**机制实现**属 gate/DAG 引擎域,由 Tadashi 设计(满足上面契约即可),再一起过 Codex:
- **workflow-run barrier + obligation 模型**(R2/R3)—— 覆盖并行/optional/retry。
- **canonical versioned `ship_subject`**(R4)—— 序列化 / hash / schema / 迁移列。
- **耐久卡状态机**(R1)—— 存储 / 唯一性 enforcement / outbox-transaction 边界 / Discord edit-delete 策略 / 重启 reconcile。
- **`freeze_epoch` + mutation lease**(R7)—— lease 协议 / 外部写检测 / progress ledger 落哪。
- **单一强制 approval authority**(R8)—— 跨 store 原子性 / reconciliation。
- **reviewer 选择算法 + 泛化存储迁移**(R5/R6)—— 满足 authority/policy 契约即可。
- **post-click 状态机 + merge-queue/compare-and-swap**(Goal 4)—— retry 次数/超时 / 运营告警路由。
- **late-hold 卡转移**(Codex round-3 #1)—— hold 在卡激活后出现时,卡原子转 `blocked`/`retiring` 还是保持 current 但拒点并回 hold 原因;两种都要:不记批准 · 点击有回应 · hold 可见 · 除非 subject 变否则不需二次 founder 决定。
- **指标终局枚举**(Codex round-3 #3,telemetry design)—— 「明确 non-authorization 终局」定成一个封闭 enum;**timeout / 丢监控 / 未解决的 infra 失败 / 人肉 Lead 干预 一律不算成功**,保留 §6 的分母与 subject-attempt 规则。

Codex 全文:round-1 `/tmp/codex-rescue-design-feedback-fly1211-prd-round1.md` · round-2 `/tmp/codex-rescue-design-feedback-fly1211-prd-round2.md`。

---

## 附:这份 PRD 是怎么来的

一天之内三个人各自推翻自己的第一版(我 4+ 次、Tadashi 3 次、Cass 靠先读代码后说话 = 0 次);Annie 读了一版可视化后把设计从「修老卡」重构成「根本不该有能授权的老卡」;Codex 两轮把产品契约磨成了真正能防竞态/半失败的 ship-安全契约,并帮我把「新旧并存的自相矛盾」收敛成一份权威契约。

> **没有一个人的第一版是对的 —— 但没有一个人把第一版发给 Annie。**
> 这条纪律本身,可能比这份 PRD 更值钱。
