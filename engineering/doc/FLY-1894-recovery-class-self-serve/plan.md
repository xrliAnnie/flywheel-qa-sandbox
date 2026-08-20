# FLY-1894 恢复类 run 状态**分类框架**(FLY-1895 前置件)— 实施计划

> 文件夹 slug 仍是 `recovery-class-self-serve`,是**历史名**:改名会打断 design 门绑定的路径
> 与 progress 台账。以本标题为准 —— 本单**不交付**自决能力。

Issue: FLY-1894 (https://linear.app/geoforge3d/issue/FLY-1894/规矩机制-恢复类-run-状态操作-lead-自决-固化进-lead-rules-basefounder-only-authority-新增)
日期: 2026-08-19
基于: research.md;Codex design review 第 1 轮(5H+4M)、第 2 轮(6H+1M+1L)已逐条折入,见 §10
范围裁定: 2026-08-19 Tadashi 拍 **方案 B**(见 §0)

## 0. 范围裁定(2026-08-19,Tadashi)

第 2 轮 review 挖出一个**当场存在**的自相矛盾,经我逐字核实:rework 请求在数据库里把
`authority` 列**硬编码写成 `'founder'`**,并把**发起方 Lead 写的文本**存进
`founder_feedback_verbatim`,该文本随后作为 `founderFeedback` 交给替代 Runner ——
而调用方 principal 只是 `"master"`。⇒ R5 若把这条路列为可自决机制,就会**一边禁止制造
authority truth、一边强制制造它**。

Tadashi 裁定 **方案 B**,四点:

1. 本版 R5 只固化:**分类判据 + 报备与留证纪律 + 禁止清单**(**不含**自决执行姿态);
   明确写明**尚无任何状态手术机制被授权**,等 FLY-1895。
2. 死角⑮四步配方**留作形状示例**,但硬标注三件事:未授权 / 伪造权威缺陷 /
   `pr_head_sha` 栅栏。教学价值保留,照抄风险用标注挡。
3. FLY-1895 由 Lead 扩 scope 升级:在原「consent 分级」之上,加
   **「rework 归属真实化 —— Lead 发起记 Lead,feedback 字段不得冒 founder 逐字」**,
   升为 Annie 放权落地的**前置件**,优先级 High。
4. **过渡期 detective provenance disclosure**(写进 R5):在 FLY-1895 落地前,走受影响的
   operator rework 路径时,必须在 issue thread 公开分项声明真实来源(见 §3.5)。
   ⚠️ 定性:它**只留下 provenance 线索**,**不修数据库、不阻止替代 Runner 收到错误 attribution**
   —— 因此**不是** compensating control,也**抵消不了**伪造(第 4 轮 MED-2 统一措辞)。

> **更正(第 3 轮 review 推翻了我自己做的一处改动)。** 我曾把第 4 点从「自助 rework」
> 扩大成「只要发生恢复类 rework」,理由是「误标是机制属性、与谁批准无关」。
> **这个理由不成立**,逐字实测三条 rework 的 INSERT:
> - engine 路径(`StateStore.ts:30117`):`VALUES (?, ?, ?, 'engine', …, NULL, ?)`
>   —— 记 `engine`,且 founder 逐字字段直接是 `NULL`;
> - operator 路径(`:30721`):`VALUES (?, ?, ?, 'founder', …, ?, ?)` —— 硬编码 + 存 Lead 文本;
> - 第三条(`:36708`):authority 是**参数**,用真实值。
>
> - 第四条(`:37971`,founder-feedback-source 路径):字面量 `'founder'`,但该路径本就校验
>   founder feedback 载荷 ⇒ **归属正确**(第 5 轮 LOW 要求补全 census;详见 §10)。
>
> ⇒ 缺陷**只在 operator 这一条路**上。Tadashi 的原始限定比我的扩大更接近事实,
> 我的外推是没核就下的结论,已作废。第 4 点按 §3.5 的新形状落地。

**这缩小了本单原本承诺的交付**(原 issue 要求把四步配方作为可自决机制固化)。
缩范围是 Lead 的决定,不是执行者的。

## 1. 目标(一句话)

在 `lead-rules-base` 里建立**恢复类 run 状态操作的分类框架与空授权注册表**,
**意图**覆盖所有加载这份治理合同、且能管理 Runner 的 engineering Lead
(⚠️ **意图,不是已达成的保证** —— 装载顺序目前让项目层可以机械覆盖中央合同,见 §3.9e / FLY-1910)(cos + 部门 Lead,
Claude 与 Codex 后端皆然),并作为 **FLY-1895 的前置件**。

Annie 的原始诉求是「恢复类 Lead 自决、做完报备」。**本单不交付它** ——
授权清单为空,恢复类状态操作仍须 founder 授权。

⚠️ **本单交付的不是「自决能力」,而是 recovery classification framework + FLY-1895 前置件**
(第 4 轮 MED-5)。上面那句「Lead 自决、做完报备」是 Annie 的**原始诉求**,
**本版没有交付它** —— 授权清单为空,恢复类状态操作仍须 founder 授权。

本版真正交付的:分类词汇 / 闭合授权注册表(空)/ 披露纪律 / R2 标题修复 / roadmap 清理。
变的是**你怎么带它去找 founder**(带分类结论与建议,不是带一个开放问题),不是**你可以不去找**。
PR 与结单口径必须照此写,**不得**把 FLY-1894 描述成自决能力已落地。
companion(Mufasa / Belle)与 external(Anna)**明确不在覆盖面**,它们本就跳过这个文件。

> 措辞注:issue 标题里的「全项目全 Lead」是意图表达。真实覆盖面按上一段,正文用后者。

## 2. 改动清单

纯文档。**零代码、零测试代码、零配置。**

| # | 文件 | 改动 | 行数量级 |
|---|---|---|---|
| 1 | `packages/teamlead/lead-rules-base/founder-only-authority.md` | 新增 `## R5 — Recovery-Class Run-State Operations`(R4 之后 / `Order of precedence` 之前) | +~110 |
| 2 | 同上 | 补 `## R2 — Runner Lifecycle Authorization` 标题(**正式在 scope**,见 §4) | +2 |
| 3 | 同上 | **自洽性扫描**:Current contract / Track 2 / roadmap 导言+当前段+尾段 / TL;DR / R3 边界句(见 §5) | ~+25/-8 |
| 4 | `packages/teamlead/lead-rules-base/stuck-runner-remanage.md` | 加指针,并**修正一处错误措辞**(见 §6) | +6/-1 |
| 5 | `packages/teamlead/lead-rules-base/runner-messaging-rules.md` | 删/改那句「Bridge 在写 gate response 前已验证 founder 已授权」—— 生产 `audit_only` 下是**虚假防线**;改为指向 AUTH-CANON | +3/-2 |
| 6 | `packages/teamlead/lead-rules-base/runner-patrol-rules.md` | **第 10 轮 HIGH-1**:第 65-66 行对 parked-alive / dead 直接指示「wrap up + 关闭」,且只要求核对 founder/QA acceptance —— 而 R2 明写 acceptance **不构成**绑定该 session 的关闭授权 | +3/-2 |
| 7 | `packages/teamlead/lead-rules-base/department-lead-rules.md` | **第 10 轮 HIGH-1**:第 491 行直接指示按常规方式关闭 Runner(该动作会终结 Runner 并删除 worktree) | +2/-1 |
| 8 | `packages/teamlead/lead-rules-base/auto-qa-pipeline.md` | **第 11 轮 HIGH-3**:第 55 行(实测)对卡住的 QA 指示「re-dispatch as needed」且 founder stays out —— 无约束的重派 | +2/-1 |
| 9 | `packages/teamlead/lead-rules-base/department-lead-rules.md` §Order of precedence | **文档层的一半**(第 12 轮 HIGH-2 / Lead 裁定 a):改为意图 invariant + 当前机械现实 + 指针引 FLY-1910 的三段式。**不得**写成已达成的保证 | +6/-2 |
| 10 | `packages/teamlead/lead-rules-base/runner-reengage-rules.md` | abandon 路径「founder-consent-gated」同上,改为指向 AUTH-CANON | +2/-1 |
| — | ~~`lead-rules-base/README.md`~~ | **follow-up**(Lead 裁定,记台账) | — |
| — | ~~`scripts/hooks/flywheel-restart-guard.py`~~ | **follow-up → FLY-1895** | — |
| 11 | `engineering/doc/FLY-1894-recovery-class-self-serve/` | exploration / research / plan / progress(progress 内容 PR 前清理) | 随 PR |

## 3. R5 正文设计(方案 B,已折入第 3 轮 HIGH-1 / HIGH-2)

### 3.0 标题与定位(第 3 轮 HIGH-1)

第 3 轮指出:清单为空是安全的,**但被别的条款重新打开了** —— R5 标题还叫
`Lead self-serve`、TL;DR 还要给 R5 加例外、evidence 段还写「先声明这是报备不是请示,
然后执行」。一个 Lead 从标题或 TL;DR 进来,会**合理地**读成「三判据满足就能先报备再动手」。
**他说得对。** 所以:

- 标题改为 **`## R5 — Recovery-Class Run-State Operations (classification framework;
  no mechanism authorized yet)`** —— 不再出现 self-serve 字样。
- 正文开头即写明:**当前唯一生效的 carve-out 是 R3;R5 尚未授权任何机制。**
- 「报备不是请示」这句**只适用于将来进入清单的机制**;本版**不得**出现任何无条件执行指令。

### 3.1 结构

```
## R5 — Recovery-Class Run-State Operations (classification framework; none authorized yet)
   ├─ 这条现在是什么 / 不是什么(先说 R3 才是唯一生效 carve-out)
   ├─ Who this applies to
   ├─ Step 1 — The classification test (all three must hold)
   ├─ Step 2 — Classification is not authorization
   ├─ Authorized mechanisms —— **空**,并写明为什么空 + 空≠可自行发明
   ├─ 清单为空期间你该怎么做(仍走 founder,但带分类结论与建议)
   ├─ Disclosure requirement for the affected operator rework route
   ├─ Absolute prohibitions
   ├─ Evidence discipline
   ├─ Illustrative shape(死角⑮,三重硬标注)
   └─ Boundary — R1/R2 unchanged + 服务端可能拒绝
```

### 3.2 Step 0 — 硬排除(先于三判据,第 9 轮 MED-6)

三判据的文字仍可能把破坏性动作分类成 recovery(「已 push commit」不证明没有未提交工作、
活 tmux 上下文、transcript 或 forensic evidence;删除与 terminate **本身也可以是幂等的**)。
⇒ 在跑三判据**之前**先做硬排除,命中任一条**直接不属于 recovery-class,不必再跑判据**:

- 任何 R1 / R2 动作;
- **创建、伪造、转移、扩大或放松** authority 的动作,以及**由 Lead 直接写** gate / claim 行
  —— **永久排除**;
  ⚠️ 但**不排除**「服务端在获权后自己执行的**单调收紧 / 失效**动作」(例如撤销一个已过期的
  批准)。第 10 轮 MED-1 指出:我原写「任何 authority / gate mutation」一刀切,会让
  `workflow_rework` **即使 FLY-1895 全部修完也永远过不了 Step 0** —— 而 §3.7 又明确允许
  服务端的这类安全失效。二者字面冲突。判据是:**它是否产生或转移了新权限**;
  只收紧、不产生新权限的,可由将来的闭合条目逐项列举。
- 任何会 close 一个 Runner 的动作(**含间接触发**);
- 任何导致证据或**活执行上下文**丢失的动作。

### 3.2 Step 1 — 分类判据(三条全满足)

1. **Zero work loss** —— 覆盖面**不止已推送的 commit 与产物**(第 9 轮 MED-6):
   还包括**未提交的工作状态**、**活着的执行上下文**(tmux / session)、
   **transcript** 与 **forensic / provenance 证据**。任一项会丢 = 不满足。
2. **Direction is back onto the engine's own normal track** —— 之后由**引擎**接管自动推进。
   若结果是只有人能推动的状态,不满足;**跳过必须的 QA / 审批**去让引擎往前走,也不满足。
3. **Reversible or idempotent** —— 能退回去,或重做一遍等于做一遍。

任何一条拿不准 = 不满足。

### 3.3 Step 2 — 分类不是授权

通过 Step 1 只说明它**属于**恢复类,**不**授权你去做它。
只有 §3.4 清单里**逐项点名**的机制才可自决执行;**没有任何 generic 入口**
(不接受「任何 canonical API」「任何标准 runbook」——第 2 轮 HIGH-1)。
项目层**不得**添加条目(按 precedence 只能收紧)。

### 3.4 Authorized mechanisms —— 本版为空

正文写明清单为空**并给出理由**:原本要授权的那条路(直接修状态 + 发 operator rework),
在当前实现下会把 authority 记成 founder、把请求里的文字存进 founder 逐字字段,
再交给替代 Runner 当作 founder 的反馈。授权它 = 这条规矩自己一边禁止伪造权威、一边强制伪造。

必须同时写两句防误读:

- **空清单不是让你自己发明一条的邀请。**
- **founder 说过的一句产品级直令,也不等于清单已被填上。** 直令授权的是「去改中央合同」,
  不是「现在可以直接做」。
- **你自己把条目写进这份文件,也不等于它生效** —— 激活条件**只在 AUTH-CANON(B) 定义**,
  本节不复述(第 10 轮 HIGH-2)。
- 清单为空期间,R5 候选机制**只能**走 **AUTH-CANON(A)**,并额外满足 R5 自己的 fence:
  **同时绑定本次 run + 本机制 + 当前状态**。
- **空清单期间,恢复类状态操作仍须 founder 授权。** 变的是你**怎么带它去**:
  带「这属于恢复类,依据如下,我建议 X」,而不是一个开放问题。这就是本版交付的改变。

### 3.5 Disclosure requirement(Tadashi 第 4 点,按第 3 轮 HIGH-2 重塑)

第 3 轮指出原模板「机器误标 founder,实际决策人是 Lead X」**在空清单下没有合法场景**:
founder 批准时这句是**假**的(决策人就是 founder);Lead 自决时该操作**未被授权**。
并且 thread 里一句话既不修数据库、也不阻止替代 Runner 读到错标签 —— 它是**事后披露**,
不是能「抵消伪造」的补偿控制。**两点都对。**

⇒ 重塑为:

⚠️ **第 11 轮 HIGH-1 收紧了它的前提。** 实测该路径的**实际调用面比我写的 fence 宽得多**:
API 接受任意 `targetNodeId` 与任意 `feedback`,而 consent 调用只拿到 `requestedReason`
(**没有绑定目标节点**);DB 无条件写 `authority='founder'`;successor 收到的标题是
「Founder feedback for this revision」;同一路径仍可能进入 `closeActorForReworkSupersession`。
⇒ 攻击形状:拿到一句「可以 rework」,Lead 自己选目标节点、失效范围与反馈文本,
最后这些文字**以 founder feedback 的身份驱动 successor**。
thread 披露只是告诉人「机器撒了谎」,**并不约束 Runner 看到的权威输入**。

⇒ 因此本版明确:

- **operator rework 命中 §3.2 Step 0,不得被称为 recovery-class** —— 而且有**两条**独立理由
  (第 12 轮 HIGH-1 补上第二条):
  1. close 分支(`closeActorForReworkSupersession`)仍可达;
  2. **还有一条与 close 无关的 replacement 路径**:`reentry.kind === "replace"` 把 delivery
     置为 `replacement_pending` → dispatcher 铸**新 execution ID** → StateStore 把目标
     execution 从旧 actor 指向**新 actor**。这正命中本版新写的 R2 catch-all
     「**结束、替换、finalize 或删除** Runner 的身份 / 上下文 / 工作树」。
  ⇒ **FLY-1895 只栅栏 close 分支不够**,必须连 replacement 分支一起栅栏,
  或者收窄 catch-all 并给出可执行的 exact-actor liveness、evidence-preservation 与
  mutation-time fence。
  ⚠️ **不能拿 quiescence evidence 当证据**,而且**不能提议把它恢复**:
  `validateRunQuiescenceEvidenceTx` 已被 **Annie 的直令停用**
  (源码注释:FLY-1434 quiescence gate NEUTRALIZED,founder directive,2026-07-24 事故复盘),
  三个参数全部下划线前缀、恒返回 ok。停用理由是「要求 run 里**每个** attributed session
  都死透才准入,与 DAG 相悖」。
  ⇒ 它今天证明不了「不会替换掉仍有价值的 actor / 上下文」;
  ⇒ **更不能把「恢复这道门」写进本单或 FLY-1895 的方案** —— 那是 founder 明确否掉过的东西,
  提出它等于绕过她已经做过的决定。栅栏要另找形状。
- 若仍要走 founder 的 per-instance 调用,授权**至少**要绑定:run、**target node / attempt**、
  当前状态与版本、base/head、**完整 feedback digest 及其来源**、允许的 invalidation scope 与副作用;
  **close 分支仍可达时**,还必须额外绑定**可能被关闭的 exact execution / session**
  —— 事先确定不了就**不得调用**。
- **当前正常路径只能传 founder 原话逐字。** Lead 自写或转述**只能作为事故记录**,
  **不得**继续送进 `founder_feedback_verbatim`。

**适用范围**:**仅** operator rework 这一条路(唯一有该缺陷的路;engine 路径记 `engine`
且 founder 逐字字段为 `NULL`,第三条用真实 authority 参数,第四条 founder-feedback-source
路径归属正确)。

**触发场景(空清单下唯一合法的那个)**:**founder 批准、Lead 提交**的 operator rework。
本版合法流程**写死为 fail-closed 顺序**(第 4 轮 MED-3):

```
分类 + 建议  →  等待明确的 founder 授权  →  提交前分项披露 provenance  →  调用  →  报 receipt
```

⚠️ **本版合法场景里的决策人只能是 founder。** 下表「决策人」一栏之所以还留 Lead 这一档,
是为了覆盖**违规事故的事后如实记录**与**将来清单非空后的机制** —— 它**不是**当前正常流程的
一个分支,不得据此把 Lead 决策混进来。

**声明必须分开写四项,不用统一模板**:

| 项 | 内容 |
|---|---|
| 决策人 | founder,还是 Lead 某某 |
| 提交人 | Lead 某某 |
| feedback 来源 | founder 原话逐字转贴 / Lead 自己写的 / 转述 |
| 机器记录的失真 | 哪些字段会把上面三件事混同,替代 Runner 会把它读成什么 |

**定性诚实**:正文写明这是 **detective disclosure(事后可追溯)**,
**不是** compensating control,**更不是**自决授权的依据。根治 = FLY-1895。

### 3.6 Evidence discipline

- **先跑 §3.2 Step 0。命中硬排除 ⇒ 不跑三判据**,thread 里如实写成:
  「Step 0 已排除;不属于 recovery-class;以下按 R2 / founder per-instance 路径处理。」
  (第 12 轮 MED-1:我原文一律要求先逐条报三判据,与 Step 0 的 fail-closed 顺序打架。)
- **通过 Step 0 之后**,再在 thread 发:逐条对三判据的分类结论 + 建议动作。**然后等 founder 明确授权**
  ——本版清单为空,这一步不可跳过。获授权后、**调用前**再发 §3.5 的四项 provenance 声明。
  **本版不写「这是报备不是请示」** —— 该措辞会被读成可以直接动手。
- **做完**发结果:前后值、影响行数、receipt、后置状态、引擎接下来会做什么。
- 之所以**前后都要发**:只在事后发有崩溃缺口 —— Lead 若中途死了,连 thread 都没有。

### 3.7 绝对禁止(不因三判据满足而解锁)

- 手工制造 **progress / output / claim / credential / review / approval / gate / audit /
  任何 authority truth**。
- **由 Lead 直接写入、伪造或绕过** approval / claim / gate 行。
  ⚠️ 边界澄清(第 5 轮 MED-3):经**明确 founder 授权**调用的**服务端机制**,
  其自身为保证安全而执行的失效动作(例如 operator rework 会撤销 `founder_approved` claims、
  supersede gate holder 与 ship binding)**不属于「手工制造」** ——
  否则 Lead 无法同时遵守 §3.5 与本节。禁止的是**你自己去写那些行**。
- 写 `pr_head_sha`。**它不是缓存字段**(第 1 轮 HIGH-4,已实测:
  `write-gate-response.ts` 的 `approvedHead: liveSession.pr_head_sha.toLowerCase()`)
  —— 它决定审批绑到哪个 head,任意值可能**静默改掉审批绑定**。
  「是全 40 位」只证明格式,不证明真值。
- terminate / reject / defer / shelve / abandon —— 终结,归 R2。**恢复 ≠ 终结**。
- 丢弃已产出工作或证据:强推重写分支、删未推送产物、清 forensic 证据、
  `retry` 的 forcePreserved 杀 crash_preserve 死体。
- merge / ship / 任何让 PR 进 `main` 的路径 —— 归 R1,无条件。

### 3.9 唯一权威授权条款(结构性解法 —— 第 5~8 轮的病根)

第 5、6、7、8 四轮,每一轮我修好一个授权来源,**新写的那句话又开了一扇门**:
「或 founder 产品级直令」→「条目写进清单即生效」→「不是**唯一**途径」→
roadmap 尾段「第二条来源」。逐句打补丁在**制造**漏洞,不是在堵。

⇒ 结构性解法:**授权规则在本文件只定义一次,其它所有位置一律指向它,不得重述。**

R5 正文写一个带锚点的权威条款(下称 **AUTH-CANON**)。

⚠️ **第 9 轮 HIGH-1 推翻了我第一版的写法。** 我原把唯一形态写成「绑定 run + 机制 + 当前状态」
—— 那是 **R5 专属**的绑定,**当成全局定义会毁掉 R1/R2 现有的真实约束**:
R1 绑的是 issue + PR + **当前 QA-verified head**(且 head/scope 变了旧批准即失效),
R2 绑的是**具体 execution / session**,R4 **根本没有单一 run**。
我还写了「standing entry 将来才有」—— **也错**,**R3 现在就是一条已生效的 standing carve-out**。

⇒ AUTH-CANON 只定义**两个合法授权来源类别**,**不统一各自的绑定**:

> **What counts as authorization — 只有这两类**
>
> **(A) Per-instance founder authorization** —— 一条 founder 的明确授权,绑定
> **目标对象** + **精确动作** + **该动作专属的 authorization fence**。
> 各条规则保留自己的领域绑定。**AUTH-CANON 只写指针,不复述、不概括任何一条的 fence**
> (第 11 轮 HIGH-4:我原来概括 R1 为「head/scope 变化即失效」——**错且危险**,
> 合同本身保留了一个**受控 carryover 例外**:QA-evidence commit 移动 head 后,
> Bridge 会自动把 gate rebind 到新 head。我那句概括会把这条合法生产链判成违规,
> 也违反本单「不改 R1」的 scope。**概括别人的规则,本身就是在改那条规则。**):
> **R1 的对象、head 新鲜度、失效与受控 carryover 规则,只由 R1 定义。**
> R2 / R4 同理,各自定义。R5 自己的 fence 见 §3.4。
>
> **(B) 已激活的 standing carve-out** —— **今天是 R3**(它已生效),
> 将来加上 R5 清单里逐项激活的条目。一条机制成为 standing carve-out 需要**全部**满足:
> ① **该确切条目**获得 founder 明确批准(宽泛产品方向不算);
> ② 已合入权威中央合同的**确切 commit**;
> ③ **attribution / enforcement 对齐已完成**,并留存**一份 canonical activation manifest**
>    —— 第 12 轮 MED-2:六项证据若只是并列存在,攻击者可以**拼接**
>    「窄批准 + 宽合同条目 + 无关部署 receipt」。因此它们必须**共同绑定同一个
>    exact normalized entry digest、机制版本与部署版本**,构成一份不可拼接的 receipt,
>    内含下列**全部六项**
>    (第 10 轮 HIGH-2:这六项必须住在 AUTH-CANON 里,不能另立一节 —— 否则攻击者会挑
>    条件最少的那个版本宣布激活):
>    批准内容 / hash · 合同 landed commit · 相关代码 **deployed** commit ·
>    enforcement / attribution 验证 receipt · **live bundle receipt**(当前 Lead 确实加载了) ·
>    **独立确认角色**。
> **添加者 / 实施者不得自证以上任何一项**,独立确认角色**不得是添加者本人**。
> 
> **唯一例外(写在这里,不另立一节 —— 第 13 轮 MED-1)**:**仅 R3**,**仅凭写进 R3 的
> exact FLY-871 founder 批准**,作为本门建立之前的 grandfathered activation。
> **不可外推、不可援引为先例。** 本门建立之后的**所有**条目,一律走完整 manifest。
>
> **以下一律不构成授权**(非穷举):founder 的产品级方向或直令本身;audit 数据或
> calibration corpus;Track 2 的任何配置、阈值、label、bypass;evaluator 返回 ALLOW;
> 没有收到 403;请求成功;脚本执行成功;founder「已知情 / 已被通知」;沉默;
> 项目层写下的任何措辞。

**其它位置的处理方式**:凡是原本要重述「什么算授权」的地方(R1、R2、R3、R4、
Order of precedence、Track 2 段、roadmap、TL;DR、文件抬头 —— **不含 README,Lead 已裁定它是 follow-up**),
**一律改成一句指向 AUTH-CANON 的话**,不再各写各的版本。

⚠️ **收益必须如实说**(第 9 轮 HIGH-2 指出我上一版「攻击面从 N 收敛为 1」**不成立**):
只要 §3.4、§5 各行、`stuck-runner-remanage.md` 新段仍各自重述,它就没收敛。
⇒ 实施时必须先做一次**完整 phrase census**,把**整个 bundle**(不只本文件)里每一处
关于「什么算授权」的表述逐条标成四类之一:

| 类别 | 处置 |
|---|---|
| 唯一来源定义 | 只保留 AUTH-CANON 一处 |
| action-specific binding / fence | **保留**(这是各规则的领域约束,不能压平) |
| 纯负面限制 | 保留 |
| 重复的来源定义 | **删除或改成指针** |

**census 必须覆盖同 bundle 的其它文件**(第 9 轮 HIGH-2 抓到我漏扫的):
- `runner-messaging-rules.md`:称 Bridge 在写 gate response 前「验证 founder 已授权」
  —— 在 `audit_only` 下是**虚假防线**;另有 consent/bypass path 表述。
- `runner-reengage-rules.md`:称 abandon 路径是 founder-consent-gated。
- `stuck-runner-remanage.md` 的新段本身也是一处重述。

并且必须验证 AUTH-CANON 之外**不存在**任何肯定式授权来源或「请求成功即证明获权」的虚假防线
—— **正向 sentinel 做不到这件事**(它只证明句子存在,证明不了别处没有相反句子),
所以这一条要用**否定式扫描**(grep 反模式清单)来做。

### 3.9b Bundle 授权表述扫描(**词法扫描已执行;完整 census 尚待实施阶段**)

Lead 定的硬步骤:**宣布收敛前必须先列出普查清单。**

⚠️ **诚实定性(第 12 轮 MED-4)**:下面这一份只能叫 **authorization-word 词法扫描**,
**不能叫完整 census** —— 它的分类正则没过阳性对照(见本节末),
而 15 个文件的**人工全文分类**留在实施阶段。
**完成条件 = 一份逐文件 disposition 的人工台账**,不是这张表。

**全集** = `packages/teamlead/lead-rules-base/*.md`,共 **20** 个文件。
**扫描式** = 授权相关反模式(`founder.{0,20}(authoriz|approv|consent)` / `consent-gated` /
`verifies? that` / 已验证 / 授权),**不加任何目录或 test 过滤器**。

| 文件 | 命中 | 分类 | 处置 |
|---|---|---|---|
| `founder-only-authority.md` | 13 | 唯一来源定义 + 多处重复定义 | AUTH-CANON 保留一处,其余改指针(§5) |
| `runner-messaging-rules.md` | 3 | **虚假防线** —— 称 Bridge 写 gate response 前已验证 founder 授权,而生产跑 `audit_only` | **必修**(Lead 判定「主动有害」) |
| `runner-reengage-rules.md` | 1 | 重复来源定义(abandon = founder-consent-gated) | 改指针 |
| `README.md` | 2 | 项目层可 override base(与「只能收紧」冲突) | **follow-up**(Lead 裁定) |
| `auto-qa-pipeline.md` | 1 | 机制描述(QA 期间挂起 approve/ship 门) | ✅ 不改 —— 不是授权来源 |
| `default-enable-policy.md` | 2 | flag 默认策略(founder_consent 免于默认开启,须先 `audit_only`) | ✅ 不改 —— 与本合同立场**一致** |
| `xiaohongshu-memory-rules.md` | 1 | **纯负面限定**(记录学习不是 reserved action) | ✅ 不改 —— 按普查分类法,负面限制保留 |
| 其余 13 个文件 | 0 | — | — |

⚠️ **这次普查抓到 review 自己的清单也不完整**:Codex 点名了 4 个文件
(`founder-only-authority` / `runner-messaging-rules` / `runner-reengage-rules` / `README`),
而全量扫描另有 **3 个**文件命中(`auto-qa-pipeline` / `default-enable-policy` /
`xiaohongshu-memory-rules`)。逐一读过,三者**都不是**虚假防线或授权来源 ——
**但这个结论现在有清单支撑,不是抽样。**

### ⚠️ 第 10 轮 HIGH-1:上面这份 census **仍然不够** —— 我第四次栽在 census 上

**文件全集完整 ≠ 语义匹配全集完整。** 我扫的是含 `founder / authoriz / approv / consent`
的句子;而**祈使句形态的动作指令里一个授权词都没有**,整类漏掉。实测漏掉的两处
**都在 dept bundle 里**(`lead-rules-bundle.sh:365` / `:349`、`claude-lead.sh:2502`)——
**这是每天被每个部门 Lead 读到的正面冲突,不是历史噪声。**

⇒ census 必须改成对**两个空间**逐项分类:

| 空间 | 内容 |
|---|---|
| 授权词空间 | founder / authoriz / approv / consent / consent-gated / verifies that … |
| **动作动词空间**(漏掉的那个) | **全部 reserved-action 动词**及其**祈使句与「你的动作」表格形态** |

⚠️ **第 11 轮 HIGH-3:动词表本身仍不是语义全集。** 还漏了**效果同义形状**,实测三处:

- `runner-messaging-rules.md:86`(**实测行号**,review 报的 :80 有偏差)教 Lead「Ask Runner to abort → SendMessage(Runner 协作停止)」
  —— 这是**用自然语言终结 Runner** 的 R2 路径,里面没有任何保留动词;
- `auto-qa-pipeline.md:55`(**实测**)对卡住的 QA 指示「re-dispatch as needed」,同时说 founder stays out
  ⇒ **该文件也要进改动清单**;
- **R2 catch-all 自身的判据与本单新写法冲突**:它(`:238` 实测)写「是否**结束一个 live Runner session**」,
  而本版新增「**进程已死也不构成关闭授权**」。攻击者可说:dead Runner 已无 live session,
  所以 cleanup helper 不受 catch-all 约束。
  ⇒ R2 catch-all 判据要改成基于**「结束、替换、finalize 或删除 Runner 的身份 / 上下文 / 工作树」**,
  **不得要求进程仍 live**。

⇒ 因此 §7 的做法再改:**人工通读 loaded 文件全文**(不是只读匹配行),
并按**效果**搜索同义形状:`abort / stop / replace / re-dispatch / reclaim / finalize /
cleanup / remove-worktree` 等。**重跑同一条窄正则不构成否定证明。**
⇒ census 结论的适用范围要写清:只覆盖**会被装载的 base rule 文件的运行时授权表述**,
**不覆盖**未加载的 `README.md` 与项目层文件。

### 加宽后的 census 已执行,并且**它的过滤器被我自己的阳性对照否掉了**

按第 10 轮 HIGH-1 的要求,动作动词空间的普查已跑:
**全集 20 个文件,15 个带 reserved-action 动词。**

随后我想用一条正则把「祈使式地叫 Lead 去做保留动作」从「负面限定 / 描述 / 错误表」里分出来,
它报出 10 条正向祈使。**但我拿已知为真的那条做阳性对照,它没被捞出来** ——
`runner-patrol-rules.md:65-66` 的指令躲在**表格数据行的单元格**里,
而「Your move」这个提示词在**表头行**,不在同一行;我的正则要求动词靠近行首或与提示词同行,
于是假阴性。

⇒ **结论:这把过滤器不可信,不能用它宣布「正向祈使只有 10 条」。**
⇒ 实施时的做法改为:**对那 15 个文件的命中逐条人读分类**,不接受正则判决;
   并且**先用已知真例(patrol / dept 两处)验尺子**,验不过就不用它的输出。

这一条本身也是方法论:**判别式的过滤器必须先过已知真例**,
否则它给出的「只有 N 条」和真的只有 N 条长得一模一样。

### 我这一单第四次 census 病(记录在案)

① 数 3 条 writer 就写「唯一」(实际 4 条);② 只 glob `__tests__/` 就写「没有内容级测试」;
③ 没做普查就宣布「攻击面收敛为 1」;④ **普查了文件全集,却漏了整个动作动词空间**。

递进的教训:**普查要问「全集是什么」—— 而全集有两个维度:范围(哪些文件)与语义(哪些表述)。
我每次只补上一次被抓的那个维度。**

### 3.10a 激活证据 → 见 AUTH-CANON(B)

第 9 轮 MED-5 要求的六项可操作激活证据,**已并入 §3.9 的 AUTH-CANON(B) 本体**
(第 10 轮 HIGH-2:它原本单独成节,等于给了 standing 激活**第二个、条件更多的定义**;
而 §3.4 又有一个**只列三项**的版本 —— 攻击者会挑最短的那个)。
**本节不再复述,只指向 AUTH-CANON(B)。**

### 3.9c Lead 发起的关闭 vs 引擎自有的生命周期级联(Lead 补充,防把现实修死)

修 `runner-patrol-rules` / `department-lead-rules` 那两处时,**必须区分两件事**,
否则会把现在正常运转的生产行为一起判成违规:

| # | 类别 | 授权从哪来 | 本单怎么写 |
|---|---|---|---|
| ① | **Lead 发起的、或 Lead 可调用的** lifecycle 操作 | **必须有绑定 exact execution / session 的 R2 授权**。Done / QA PASS / founder acceptance / 进程已死,**都不单独构成**授权 | 按此公式改写 patrol / dept 两处 |
| ② | **真·全自动、Lead 无法单独调用**的引擎 housekeeping(QA verdict 后回收、周期 reaper 按状态谓词清理) | **不适用「继承授权」** —— 它**在 Lead 行为合同的辖域之外** | 写明理由是「**不是 Lead 能发起的动作**」。⚠️ **辖域外 ≠ 无监管**:必须同时给一个**指向引擎侧栅栏要求的指针**(引擎自备状态 / 身份 / 因果 / TOCTOU 栅栏),**免得被读成对引擎任意行为的背书** |
| ③ | **手工调用 / 补跑 / repair / fallback / redrive** —— Lead 去碰 ② 里任何一条 | **一律重新进 ①(R2)** | 显式写死 |
| ④ | **post-ship 清理链**(唯一可写成触发动作内置部分的那类) | 属于**该次 R1 ship 动作本身**;provenance / target / causality 三栅栏钉**来源**,**另需闭合副作用清单**钉**范围**(见下) | 写成「该动作的**内置延伸**」,**不泛化成通则** |

### 判别器(第 13 轮 HIGH-1 修正:判**这一次调用**,不判**这个函数**)

第一版写成「**是否存在**任何 Lead 可达的调用面」。**它不可机械判定**,两头都错:

- **按机制 / 最终 sink 判**:自动 self-ship 与手工 restart **共用 transport**(本单已实测),
  只要手工入口存在,**合法的 ④ 会全部被判成 ①**;
- **按内部 state transition 判**:Lead 能经 API / CLI / MCP / 直接 SQL / 配置 / 消息 /
  建 job **间接制造** transition,于是**破坏性动作会被误判成 ②**;
- 而且「**不存在** Lead 入口」是一个**完整负面**,只读规则文件的 Lead 无法证明它。

⇒ 改判**本次 exact invocation 的 causal ingress**:

> **这一次触发,Lead 能否直接或间接控制?**
>
> - 判的是**这次因果入口**,不是「这个函数有没有入口」——
>   **同一个 sink 的自动 ingress 与手工 ingress 可以归不同类别**;
> - state transition **只有携带不可伪造的 engine-origin receipt** 才允许进 **②**;
> - **④ 必须由 exact post-ship provenance receipt 单独识别**,不靠这条二选一判别器;
> - **未知 / 混合 / 来源无法证明 ⇒ 一律进 ①(R2)** —— fail-closed 是默认。

判据的价值仍是**不依赖意图判断**,但**判定单位必须是「这次事件」而不是「这段代码」** ——
按代码路径判会同时产生假阳与假阴。

### ④ 有 founder 的直接语料背书(2026-08-19 11:17 PT,FLY-1877 ship 后清理实况)

Annie 原话:

> 「不需要我的确认啊。一般我点 approve to ship 之后,后面就一条龙,你自己去做就行了。
> 该清理的清理,该 ship 的 ship,该 archive 的 archive,不用问我任何东西,
> 你就默默地去把所有东西都做好就行了。只有出现任何问题的时候,才需要跟我讲?」

⇒ **post-approve 的 close / cleanup / archive 链属于 ship 动作的授权范围,不是独立的 R2 动作,
不需要 per-session founder 确认。** 这不是我推出来的,是她说的 —— ④ 因此是**四类里唯一
有 founder 直接语料**的一类。

⇒ 末句「只有出现任何问题的时候,才需要跟我讲」= **fail-loud-only 的 founder 面报告契约**,
写成 ④ 的行为注脚:**顺利就默默做完,只有出问题才上报。**

### ④ 还必须闭合**副作用集合**(第 13 轮 HIGH-2)

三栅栏只能证明「**为什么触发、对应哪次 ship**」,**证明不了「允许删除什么」**。
实测 post-ship bundle 已包含:remote branch CAS 清理、issue 级 closeout、
**全项目 trailing sweep**,会关闭 tmux / 其它 phase、删除 worktree 与远端分支;
composition root 还明确要求**未来每一个新增 deleter** 都挂到既有 autoclean seam。

⇒ 照现在的写法,攻击者只要把一个**新 deleter** 接进 post-ship,
并且仍属同一次 ship / 同一 commit / 同一因果链,
就能把**删除 forensic 证据、兄弟 session 或无关分支**包装成「内置 cleanup」。

⚠️ **Annie 的原话授权的是「预期中的那条龙清理」,不是给未来任意新增的破坏性副作用
开一个开放类别。** 引用她的话不能超出她说的范围。

⇒ ④ 必须同时钉死:

1. **闭合且可版本化的允许副作用清单** —— **本单直接给出初始清单,不留给实施者临场定**
   (第 14 轮 HIGH-2:只写「实施时提供清单或 digest」等于把授权半径交出去)。
   基于本单实测的当前链,初始允许项:

   | # | 允许的副作用 | 对象推导必须钉死 |
   |---|---|---|
   | 1 | 关闭该次 ship 对应 issue 的 **tmux / phase** | 只限该 issue 的 execution,**兄弟 session 不在内** |
   | 2 | 删除该次 ship 对应的 **worktree** | 路径由该 execution **推导**,不接受传入路径 |
   | 3 | 该次 ship 的 **remote branch CAS 清理** | 只限该 PR 的 head branch,CAS 到冻结的 merge commit |
   | 4 | 该 issue 的 **issue-level closeout** | 只限该 issue |

   ⚠️ **`postShipSweep`(全项目 trailing sweep)不得作为一个允许项列入** ——
   **它本身就是一个开放类别**,列进来等于把开放性原样搬进清单。
   其成员必须**逐项单列**才可能进表;在此之前它**不在 ④ 的授权半径内**。
2. **每一项副作用的精确对象推导 + 身份栅栏 + mutation-time 重读**;
3. **明确禁止的副作用**(至少:删除 forensic 证据、动兄弟 session、动无关分支);
4. **新增 deleter 必须重新修改并重新批准合同** ——
   **接进 autoclean seam 不自动继承授权**。

**为什么要拆成四类,而不是一句「引擎级联继承触发动作的授权」**(第 11 轮 HIGH-2):

那个概括**对 post-ship 成立、对另外两类不成立**,实测:
- **QA PASS 是 QA verdict,不是 founder 授权** —— 它不属于 AUTH-CANON 的任何一类,谈不上「继承」;
- 更硬的一条:`HeartbeatService` 里的 **GEO-270 周期 reaper** 按状态谓词
  (completed / failed / blocked 而 tmux 仍活)自动关闭 ——
  **这里压根不存在某个 per-instance 已批准动作可供继承**。

⇒ 若照「继承」写,要么与「授权只有 A/B 两类、R3 是唯一 live carve-out」自相矛盾,
要么给 Lead 开一扇门:**把任意破坏性副作用包装成「引擎级联」**。
⇒ 正确机制不是「继承」,是**辖域** —— 那些动作 Lead 根本发不起,所以不在 Lead 合同里。

**Lead 判断的内核完全保住**(别把引擎级联写成要 per-session 授权,否则跟生产打架),
变的只是**用什么机制保住它**。

**记录**:这是我第三次在「收紧」时忘了问 **「现在有谁正在合法地穿过这扇门」** ——
① R4 的 self-ship 链(Lead 补)② 引擎级联(Lead 补)③ R1 的受控 head carryover(Codex 补)。

### 3.9d R3 祖父条款 —— **只有解释与指针**(规范本体在 AUTH-CANON(B))

**规范内容不在本节。** R3 的唯一例外、适用范围与激活条件,**全部只在 AUTH-CANON(B) 定义**;
本节复述任何一条都会重新造出第二个肯定式授权来源(第 14 轮 MEDIUM —— 我上一版没做干净)。

**非规范性理由**(为什么保留祖父化,而不是让 R3 事后补证):让 R3 事后补齐激活证据,
等于**由实施者自证** —— 那正是这道门要堵的东西;而删掉「R3 已激活」又与生产事实打架。

**指针**:见 §3.9 AUTH-CANON(B) 的「唯一例外」段。

### 3.10 将来清单条目的最小形状(第 8 轮 MED-4)

清单将来非空时,**一个条目不能只写机制名**(否则「operator rework」会连带授权
一个宽得多的调用面)。每个条目必须像 R3 那样钉死:

调用面 / 合法 actor / 精确前态 / mutation-time 重读与 CAS / **允许**的副作用 /
**禁止**的副作用 / 崩溃与重试语义 / attribution / audit 与 receipt /
该条目的 founder 批准证据。

### 3.8 实例段(形状示例,三重硬标注)

死角⑮四步配方保留,但**不写成可照抄的 runbook**,以「形状」叙述并硬标注:
**未授权**(不在 §3.4 清单里)/ **伪造权威缺陷**(最后一步,FLY-1895 修)/
**`pr_head_sha` 栅栏**(其中一步会写它,而它参与审批绑定推导)。
并写明:**判据可迁移;配方不可迁移。**

## 4. R2 缺标题 —— 正式纳入 scope(Codex MEDIUM,已采纳)

**事实**:`grep -n '^## '` 显示 `## R1` 之后直接跳到 `## R3`;R2 内容(191 行起)在 markdown
结构上嵌在 R1 底下,没有自己的标题,而全文反复引用「R1/R2」。

第 1 轮我把它写成「越界一行、随时可 revert」。Codex 指出这个定性不对:它修的是**真实的
markdown 层级错误**,而且**让 R5 的边界可被定位**。⇒ 正式纳入 scope,不再自称越界,
也不再预备随时 revert。(Lead 已于 2026-08-19 批准这处修正。)

## 5. 自洽性扫描(Codex HIGH-5,两轮)

第 1 轮指出只改 roadmap 一句不够;第 2 轮进一步指出**roadmap 本身已经过期**:仓库是
`v1.55.0`,而合同仍写 `v1.29.x — now` / `v1.3x — future`,且所谓 v1.3x 的 per-action
threshold、bypass label、single-issue bypass **在 founder-consent config 里已经存在**。

⇒ roadmap **去版本化**,改成无版本的 phase/status 三分模型:

- **已有机制**(代码里已存在的能力)
- **当前实际启用状态**(**不写进本文件** —— 易过期,必须操作时核验)
- **尚未授权的未来方向**

要同步改的位点:

| 位点 | 现状问题 | 处置 |
|---|---|---|
| 文件抬头 `Loaded by **every** Lead role` | **错误的覆盖声明** —— companion/external 明确跳过(第 2 轮漏点) | 改为 every **engineering** Lead role,并点明 companion/external 不加载本文件 |
| `Current contract` 导言 | 自称 v1.29.x 校准窗;只提两类保留动作 | 去掉写死的小版本;写明**唯一生效的 carve-out 是 R3**,R5 是分类框架、尚未授权任何机制(第 3 轮 HIGH-1) |
| `Relationship to Track 2` | 称 Track 2「in design」 | 改为:Track 2 已落地,支持 off / audit_only / enforce 三模式;**实际模式操作时核验**。措辞须无歧义(第 7 轮 HIGH-1 —— 我原写「不是**唯一**途径」等于承认它是途径之一):**Track 2 本身不是授权来源**;它只能**执行、审计或收紧**一个**已经存在**的授权。**evaluator 返回 ALLOW、没有收到 403、或请求成功,都不创造授权。** 任何进入 R5 清单的条目仍须与服务端 enforcement 一致、保持真实 attribution,**服务端拒绝时不得绕过** |
| **R1「清单随 calibration data 积累而收缩」**(`:62`) | 把**数据**写成了授权来源(第 6 轮 MED) | 统一为:数据只能**支持**授权决策,不能创造权限 |
| **「Track 2 corpus 让风险判断毕业为 Lead 自决」**(`:115`) | 同上 | 同上 |
| **「Track 2 gate 可直接 auto-clear close」**(`:259`) | 把**配置**写成了授权来源 | 统一为:配置只能执行 / 审计 / 收紧**已存在**的授权 |
| **「Track 2 gate 未来可 without re-asking」**(`:310`) | 同上 | 同上 |
| **TL;DR「合同只随 Track 2 corpus 收窄」**(`:509`) | 同上 | 同上 |
| **「Track 2 + auto-approve label 可放松授权」**(`:95-97`) | 未说明 **label 本身不能创造权限**(第 7 轮 MED-3) | 加限定:label 只能让**已批准的中央条目**被执行,自身不创造权限 |
| **「基于 evidence 的 per-project tone auto-close」**(`:267-268`) | 明确描述「数据 + 配置自动产生 close 权限」 | **删除**,或改为:只有**已批准、逐项列举**的中央条目才能让配置去执行该授权 |
| roadmap 「双路径」 | 会把 audit data 读成授权来源 | audit data 只是**决策证据**,不是授权来源 |
| roadmap 导言「None of the relaxations below are active today」 | 与 R3 冲突 | 限定为「**本节列出的**放松尚未生效」,并写明:**R3 是已生效的 founder 直令放权;R5 目前不是 relaxation,只是一个空的授权注册框架**(第 5 轮 MED-4:不能把 R5 与 R3 并列成两条已生效放松) |
| roadmap 各版本段 | 版本号已过期,且 v1.3x 的能力其实已存在 | 整体改 phase/status 模型,不再钉版本号 |
| **roadmap 尾段** | 我原拟「存在第二条来源(founder 直令),两条并行」——**第 8 轮 HIGH-2:这把第 6 轮堵掉的洞又开了**,攻击者正好拿 Annie 的产品级直令声称命中「第二来源」 | 改为:audit 证据与 founder 产品方向**都只是「提出中央合同变更」的输入**,**两者都不是运行时授权**;standing carve-out 仍须走 AUTH-CANON 的统一激活门 |
| **R4 整节(第 8 轮 HIGH-1,之前完全漏扫)** | R4 只说 `request-restart.sh` 是唯一 sanctioned path,紧急路径甚至只要求 founder「explicitly aware」⇒ 攻击式读法:Lead 自己决定重启,先通知让 founder「aware」,然后执行。而 FLY-1671 原合同要求**触发前 founder 拍板** | **已由 Lead 拍板(2026-08-19):Lead 不得自主发起全舰重启。** ⇒ **R4 只规定拿到授权之后的 transport**(`request-restart.sh` 是唯一通道),**不授予发起权**;正常与紧急路径都要 per-instance founder 授权(指向 AUTH-CANON);「已知情 / 已通知 / 脚本成功」都不是批准。**R4 因此不是 carve-out,三处「R3 唯一」维持不变。**<br>⚠️ **显式豁免(Lead 补充)+ 可判定栅栏(第 10 轮 HIGH-3)**:Lead 的裁定保留 —— 标准 self-ship 自动链不算 Lead 发起。**但「走 updater 队列」不是栅栏**:实测手工入口与自动链**共用同一 transport**(`request-restart.sh` 把 handoff 指向并调用 `self-ship-restart.sh`),攻击式读法是「任意一次 ship 获批后手工调一下,再称它是 post-ship chain」。⇒ 豁免必须钉死三项:**provenance** = 只能是 canonical Runner 的 post-merge self-ship handoff;**target** = 必须是该次 R1 授权对应的 canonical merge commit;**causality** = 必须是该 exact ship 的产品内置自动后果。**Lead 手工调用、补跑、修复、fallback、emergency path 一律不继承 ship 授权**,仍需独立的 per-instance 授权。最好把它写成**「该次 R1 ship 动作的内置副作用」,而不是第三种授权来源** |
| **文件抬头「project-local authorization phrases」** | 项目层可添加「项目本地的授权措辞」⇒ Lead 可声称项目层把某个宽泛直令定义成了运行时批准(第 8 轮 MED-3) | 限定为:项目层只能提供**解释「当前的、精确绑定的 founder 消息」的别名或示例**;**不得**创造、扩大或转移授权,不得把沉默 / label / ALLOW / 产品方向 / 历史措辞变成批准,**不得**新增 R5 条目 |
| `TL;DR` | 「route **every** R1/R2 reserved action through the founder」 | except 子句**只指向 R3**;R5 处写明它当前不授权任何机制(第 3 轮 HIGH-1:给 R5 加例外会把空清单重新打开) |
| **R2 catch-all 的「Track 2 hard gate enforces this server-side」** | **危险的虚假防线**(第 4 轮 HIGH-1):Track 2 只拦 `RESERVED_ENDPOINTS` 里枚举的 HTTP / Surface B 路径;**直接 SQL、其它 CLI / helper 不会被拦** —— 死角⑮前三步就是现成反例 | 改为:Track 2 只保护**明确接线**的端点,prompt 侧 catch-all 比它宽;**没有收到 403、或请求成功,都不等于获得授权** |
| **R1「审计表捕获 founder 最终如何解决」** | **过 claim**(第 4 轮 HIGH-1):schema 虽留了 subsequent-ack / human-label 列,但**当前没有生产 writer** | 改为:audit row 记录的是 **evaluator 当时的判断**,不声称已记录最终的人工结果 |
| **`Order of precedence` 的「Loosening … happens centrally via … the Track 2 configuration knobs, and version bumps」** | **危险的虚假授权来源**(第 5 轮 HIGH):Lead 可合理推出「调低 threshold / 配好 bypass / 请求成功 = 获得授权」 | 改为**纯指针**(第 10 轮 HIGH-2:我前一版在这里内联复述了三项激活条件,那正是攻击者会挑的「条件最少的第三套定义」):本段只写一句 —— **「什么算授权」只由 AUTH-CANON 定义,本节不复述;放权只能经 AUTH-CANON(B) 的激活门。**另加两句纯负面限定:**Track 2 的任何配置都不创造授权**;**founder 的产品级直令授权的是「去改中央合同」,不是「现在可以做」。**Current-contract 两处绝对说法同步改掉 |
| **R2「No auto-close exception you can act on」** | 与 R3 冲突(第 5 轮 MED):R3 的 runner rescue 明确执行 terminate-for-rescue → close dead tmux → dispatch successor | 限定为:**只有完整的 R3 runner rescue** 是例外,此外不存在独立的 close 权限。**这一段不得提 R5**(第 6 轮 MED-3:否则将来的 R5 条目会被误读成可以含 close,与 §6「R5 从不授权 close」正面冲突) |
| **R3 开头「everything outside it stays founder-routed」** | 会否定将来非空的 R5 清单(第 5 轮 MED) | 同上限定 |
| R3 结尾「Anything beyond this exact action … remains reserved under R1/R2」 | 字面否定同级的 R5 | 改为「超出 R3 的部分回到 R1/R2,**除非命中 R5 清单中明确列举的授权机制**」——必须是**命中已授权机制**,不能只是「按 R5 分类」(第 3 轮 HIGH-1) |

⚠️ 消除我自己引入的矛盾:§3 说易过期的 mode 值不进正文,那本节就**不能**让正文写
「生产以非阻断模式运行」。正文只说门支持三种模式,当前值操作时核。

## 6. `stuck-runner-remanage.md`(两轮 review 各抓出我一个错)

第 4 条现文:「Treat restart, kill, ship, and close as founder-only actions.」

- **第 1 轮**指出我说「这句仍然对,那四个都是终结类」是**错的** —— R3 恰恰授权了一种
  restart-in-place。
- **第 2 轮**指出我据此拟的补救措辞**更糟**:
  「restart / kill / ship / close stay founder-routed **except for two carve-outs: R3 and R5**」
  —— 字面会被读成 **R5 也是 kill / ship / close 的例外**,那是**反向放宽**。

⇒ 采用 Codex 给的精确措辞,原第 4 条不动,其后加:

> R3 is the **only live exception**, and it authorizes only its complete,
> enumerated rescue-retry. Where that recovery closes a dead session, the close is
> **part of that one complete, enumerated authorization unit** — never a standalone
> kill or close authority. (That unit is a procedure, **not** a transaction: it is
> not atomic and not crash-safe.)
> R5 is a classification framework for run-state recovery and **currently
> authorizes no mechanism at all**; it never authorizes restart, kill, ship, or close.

- 第 3 轮 HIGH-1:原拟稿 "provides separate mechanisms" 会暗示 R5 已有可用机制。
- 第 6 轮 MED-4:我拟的「one atomic action」是**虚假防线** —— 实测 `rescue-runtime.ts`
  依次执行 terminate → close → dispatch successor 且逐步早退,successor 起失败时
  旧 Runner **已经被终结并关闭**。改为「one complete, enumerated authorization unit」,
  并显式声明它不是事务、不 crash-safe。
- 第 4 轮 MED-4:我说「R3 只是 restart 的例外」**不准确** —— R3 的 runner 分支明确包含
  「close dead session + dispatch successor」。只豁免 restart 会让两个文件互相打架。

## 7. 验证方式(两轮各抓出一处过 claim,均已实测确认)

**第 1 轮删掉的过 claim**:「`pnpm lint` 确认 md 改动不打红」。**实测证伪且带阳性对照**:
`pnpm lint` = `biome check`;`.ts` 目录报 `Checked 83 files`,而**纯 md 目录(20 个文件)
exit 1 且完全没有 `Checked` 行**;`biome.json` 的 `files.includes` 还显式排除
`engineering/doc/**`。⇒ 对本次改动**零信号**,那个绿证明不了任何事。

**第 1 轮第二处**:所列 shell 测试在 `dist` 缺失时 `exit 0` 报 SKIP
(实测 `fly231-companion-launch-plan.test.sh:26-29`)—— 空过绿。

做法:

1. **先 build**(`pnpm -C packages/teamlead build`),**SKIP 当失败**,不接受空过绿。
2. 对**真正 materialize 出来的 bundle** 断言(不是断言 basename):
   R5 sentinel 在 dept / cos / 适用 Codex bundle 中**恰好 1 次**;
   在 companion / external bundle 中**0 次**。
3. 结构自证:`grep -n '^## '` 里 R1→R2→R3→R4→R5 齐全;TL;DR 的 except 子句**只提 R3**;
   R5 标题不含 self-serve 字样;抬头覆盖声明已改。
4. 跑受影响的装载链测试:`lead-rules-bundle.test.ts`、`rules-bundle-truth.test.ts`、
   `fly350-fullaccess-deploy.test.ts`、`fly1402-single-bundle.test.sh`。
5. **必跑 `packages/teamlead/scripts/test-fly26-rules-split.sh`**(第 5 轮 LOW 纠正了我
   「没有内容级测试」的错误断言 —— 它**是**内容级的)。
   ⇒ **实施硬约束**:改动不得动到它钉的那些端点关键词,不得改掉 `# Founder-Only Authority` H1。

   ⚠️ **但它的证明力我上一版又夸大了**(第 8 轮 MED-5):它钉的只是**旧的 R1/R2 anchors**,
   **并不覆盖** `POST /api/runs/:runId/rework` —— 而该机制在 supersession 里确实会关闭旧
   actor。所以**不能**说它「列全所有能终结 Runner 的端点」。本单不改测试代码,因此改为:
   - 该 claim 降级为「**钉住旧 R1/R2 anchors**」;
   - 由实施验证显式断言 **rework endpoint 被标为未授权**;
   - 断言 **operator-only 的 attribution 缺陷**,以及**「founder 授权必须先于调用」的顺序**;
   - **承认正向 sentinel 只能证明安全句子存在,证明不了全文没有相反的句子**
     —— 这正是第 5~8 轮反复抓到的那类问题(全文别处有相反表述)。

> 我当初说「没有内容级测试、全部只按 basename 断言」是**假的**,原因是**扫描范围**:
> 我只 glob 了 `__tests__/` 目录,而这个文件直接躺在 `packages/teamlead/scripts/` 下。
> **零命中只说明「我扫的范围里没有」。**

6. **新增精确静态断言,证明 R5 的安全合同真的被写进去了**(第 6 轮 MED-6)。
   Test 6.12 只查 H1 与旧端点关键词,§7 前几项只查标题、顺序与 TL;DR ——
   **都证明不了 R5 的语义**。至少逐条断言以下七点在 materialized bundle 里存在:

   | # | 必须断言的语义 |
   |---|---|
   | 1 | classification ≠ authorization |
   | 2 | 授权清单**为空** |
   | 3 | **无 generic 入口**(不接受「任何 canonical API / runbook」) |
   | 4 | 清单为空期间**仍须 founder 授权** |
   | 5 | **禁止写 `pr_head_sha`** |
   | 6 | **服务端未拒绝 / 请求成功 ≠ 获得授权** |
   | 7 | **R5 不授权 close / ship / kill / restart** |
   | 8 | **组合断言(第 7 轮 MED-4)**:①产品级直令本身**不是**运行时授权;②**仅就空清单期间的 R5 candidate per-instance 路径而言**,授权必须同时绑定 run + 机制 + 当前状态(第 12 轮 HIGH-3:我原写成无条件通用要求,**等于把第 11 轮刚删掉的全局概括从验证侧塞了回去** —— 正确的 R4 授权会过不了这条断言,R1/R2 的真实 fence 也会被压平);③standing 条目需 **AUTH-CANON(B) 的完整六项证据 + 独立确认人**(不得缩写成三项);④**添加者 / 实施者不得自证批准或对齐完成**(第 8 轮 MED-4 补③④两项 —— 删掉这两道门,八条断言仍会全绿) |
   | 9 | **operator rework 的绑定面**:exact target node/attempt、feedback digest 及来源、base/head、允许的 invalidation scope 与副作用、以及 close 分支可达时**可能被关闭的 exact session**(第 11 轮 MED-2:第 8 条只钉 `run + mechanism + state`,正好把 HIGH-1 的弱 fence 固化成绿) |
   | 10 | **旧句精确为零**:无约束的 `abort` 教学、无约束的 `re-dispatch as needed`、以及 R2 catch-all 里要求「进程仍 live」的旧判据 |
   | 11 | **引擎 housekeeping 未被写成泛化的授权继承**(只有 post-ship 一条被写成触发动作的内置副作用) |
   | 12 | **post-ship 三栅栏存在**:provenance / target / causality |
   | 13 | **R1 受控 carryover —— 正反两条都要**(第 12 轮 MED-3:只有反向断言时,实施者**直接删掉**那条规则仍然全绿):**反向** = 不得出现「任何 head 变化即失效」这类概括;**正向** = QA-evidence commit 移动 head 时 Bridge 对 gate 的 rebind 例外**必须仍明确存在** |
   | 14 | **R3 的 grandfathered activation 说明可解析**,且明确不可被新条目援引 |
   | 16 | **反例断言(第 13 轮 MED-2 —— 断言 12/15 只查「在位」,把有缺陷的文字原样写进去也会全绿)**:①同一 sink 同时有自动与手工入口时,**手工调用必须归 ①**;②Lead **间接**制造的 state transition 必须归 ①;③来源或 reachability 不明必须归 ①;④ship commit 正确但**清理对象不在闭合集合内**必须拒绝;⑤**新接入、未列入允许副作用清单的 deleter** 必须拒绝;⑥**逐项 identity fence 与 mutation-time re-read 存在**(第 14 轮:断言只查清单在不在,不查每项有没有栅栏);⑦**`postShipSweep` 未被作为单一允许项列入** |
   | 15 | **四分法与判别器在位**:①/②/③/④ 四类齐全;**判别器是 R13 修正后的形态** —— 判**本次 exact invocation 的 causal ingress**(⚠️ **不得**出现「是否存在 Lead 可达的调用面」这条已被 R13 否决的旧措辞:它会误判共享 sink,且要求证明完整负面);同 sink 自动/手工可分属不同类;未知 / 混合 / 无法证明来源 **fail-closed 归 ①**;②**同时带「辖域外≠无监管」的引擎侧栅栏指针**(否则会被读成对引擎任意行为的背书);④ 只写成 R1 ship 的内置延伸、**未被泛化成通则** |

   可以是实施时的验证命令,不必新增测试代码。

**诚实边界(第 2 轮要求再收窄一次)**:以上只能证明
**「当前 checkout 的装载链包含这些字节」**。它**不能**证明「每个现存 Lead 的 prompt 已更新」
——那还需要确切的**已部署 commit** + Lead **重启 / 新 session** + live bundle 或
baseInstructions 的 **receipt**。更不证明 Lead 读了会照做:行为层证据要等下一次真实撞到
held-run 才有。本 PR 不声称拥有这两者中的任何一个。

## 8. 明确不做

- ⚠️ **不能再写「不改变 R2 的 reserved-action 集合」**(第 12 轮 HIGH-1 指出这是 overclaim):
  本版把 R2 catch-all 的判据从「是否结束一个 **live** Runner session」改成
  「**结束、替换、finalize 或删除** Runner 的身份 / 上下文 / 工作树」——
  这**实质扩大了** reserved 集合(replacement 路径现在被覆盖进来)。如实写明。
  另外**确实会改** R1 的授权演进措辞、R2 的 catch-all 与 auto-close exception —— 即 §5 明列的自洽性修正(第 7 轮 LOW-5:
  我原写「只补 R2 标题」**不属实**)。
- **不授权任何状态手术机制**(方案 B 第 1 点);四步配方只作形状示例。
- 不做服务端对齐与归属真实化 —— 那是代码,已由 Lead 扩 scope 升级进 **FLY-1895**(High,
  且是 Annie 放权真正落地的**前置件**)。
- 不改 Tadashi 的私有 memory(他已自行回灌本次发现)。
- 不碰 `companion-safety-contract.md` / `external-agent-contract.md`。

## 9. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 判据被宽泛解读去干破坏性操作 | Codex HIGH-1(两轮) | §3.3 分类≠授权 + §3.4 清单为空且**无 generic 入口** + §3.7 绝对禁止 |
| 「空清单」被读成可自行发明机制 | 方案 B 的固有风险 | §3.4 逐字写「空清单不是让你自己发明一条的邀请」 |
| 授权一条会伪造 founder 权威的路 | Codex HIGH-2(已实测证实) | 本版**不授权**;过渡期 §3.5 只做 detective provenance disclosure(**不抵消**伪造,只留线索);根治=FLY-1895 |
| 误写 `pr_head_sha` 改掉审批绑定 | Codex HIGH-4(已实测证实) | §3.7 禁止 + §3.8 栅栏标注 |
| 文件自相矛盾 / roadmap 过期 | Codex HIGH-5(两轮) | §5 去版本化 + 八个位点(含抬头覆盖声明) |
| 措辞反向放宽 kill/ship/close | Codex HIGH-6 | §6 采用精确措辞 |
| 验证过 claim | Codex MED(两轮) | §7 换会响的尺子 + 边界收窄到「当前 checkout 的装载链」 |
| 文件已 25KB,再加长 | 每个 Lead 的 prompt 都吃 | R5 控制在 ~120 行;不复述 R1/R2 已有内容 |
| 死角⑮配方过期 | research §7 保质期表 | §3.8「判据可迁移、配方不可迁移」 |
| `progress.md` 带无关内容进 PR | Codex LOW-8 | PR 前清理 |

## 9b. 收敛栅栏与「已声明接缝」清单(Lead 定,**在 R13 跑之前**写死)

Lead 于 2026-08-19 给出三出口判据。**判据必须先于数据** —— 所以下面这张接缝清单
是在**看到 R13 结果之前**钉下来的,避免事后按结果反推分类。

### 三出口

| 出口 | 条件 | 动作 |
|---|---|---|
| ① | R13 **APPROVED 或无 HIGH** | 直接落地 |
| ② | R13 的 findings **全落在下方已声明接缝内** | 修完跑 **R14 作最终验证**;R14 之后**无论结果**按现状落地(残余如实进台账 + 下游单) |
| ③ | R13 **再开全新地盘**(接缝之外的新 HIGH) | **立即停,按现状落地** —— 那是 **review 过程无界**的证据,**不是 plan 不行**的证据 |

### 已声明接缝(判「接缝内」的白名单)

1. **授权来源措辞** —— 任何位置把配置 / 数据 / 直令 / label / 请求成功写成授权来源;
2. **AUTH-CANON 的自洽性** —— 重述、概括、多版本、与各规则 fence 的边界;
3. **四分法与判别器**(R13 首次评估)—— 四类的边界、判别器的可判定性、②的栅栏指针、④不泛化;
4. **operator rework 的栅栏** —— close 分支、replacement 分支、绑定面、feedback 来源;
5. **standing 激活证据** —— 六项、manifest 不可拼接、自证禁止、R3 祖父条款;
6. **census 的完整性与状态措辞** —— 范围维度、语义维度、完成条件的诚实定性;
7. **验证断言的覆盖与反噬** —— 断言漏掉某语义、或断言本身把危险写法固化回来;
8. **项目层 precedence 的三段式表述** —— 意图 / 机械现实 / FLY-1910 指针;
9. **Step 0 与 evidence 的顺序**、**post-ship 三栅栏**、**R1 carryover 的正反断言**;
10. **交付 framing 的诚实性** —— 标题 / 目标 / PR 口径不得冒充已交付自决。

### 判「全新地盘」的标准(触发出口 ③)

一条 HIGH 若指向**上表任何一项都覆盖不到**的东西 —— 例如**从未被任何一轮点过名的
bundle 文件或生产机制**,且它引出的是**新的一类**问题而非已列接缝的又一个实例 ——
即判为全新地盘,**立即停**。

⚠️ **自我约束**:出口 ③ 的判定对我有利(可以早点收工),所以**我必须把每一条 finding
逐条对照上表点名**,写明它命中第几项;点不到才允许判 ③。**不许整体感觉判定。**

## 9c. 交付实况更正:④ 的闭合副作用清单**没有进规矩正文**(独立 QA FLY-1921 F2)

§3.5 设计了一张 4 项闭合允许副作用清单。**实现时它没有落进 `founder-only-authority.md`。**
实测:规矩正文里该清单命中 **0**;正文实际写进去的是

- **三栅栏**(provenance / target / causality)—— 但它们钉的是**触发来源**,不是**允许范围**;
- **辖域语言 + fail-closed**(`runner-patrol-rules`:引擎 housekeeping「outside the Lead
  contract」、「If you can reach it, it is yours to route」)。

也就是说,第 14 轮 H2 要求的「闭合副作用集合」**被一个不同的设计替换了**,
而我在 PR 正文里把三栅栏陈述成了 H2 已交付。**这是一处交付与陈述不符,由独立 QA 抓出。**

处置(按 QA):
1. **PR 正文显式披露该替换**,不再声称 H2 的清单已交付;
2. **清单本身折进 FLY-1895** —— 它与 close/replacement 栅栏本就属同一层工作;
3. 本节留档,避免以后有人从 §3.5 读出「清单已在规矩里」。

⚠️ 值得记一笔:替换本身未必是坏设计(辖域语言可能更耐用),
**问题在于我换了设计却按原设计报交付。**

## 10. Codex design review 处置台账

### 第 1 轮(5 HIGH + 4 MEDIUM)—— 全部折入 plan v2

| 结论 | 处置 | 我是否独立复核 |
|---|---|---|
| H1 三判据可授权破坏性操作 | 混合模型 | 逻辑成立 |
| H2 绕过 mutation-time fence | 硬前置 | 接受 |
| H3 非 crash-safe / 三字段必填 | 顺序+CAS+落盘 id | ✅ 实测 `runs-route.ts` 缺一即 400 |
| H4 `pr_head_sha` 参与审批绑定 | §3.7 禁止 | ✅ 实测 `write-gate-response.ts` |
| H5 roadmap 改动不足 | §5 | ✅ 实测 `doc/VERSION`=v1.55.0 |
| M 审计轨断言不实 | §3.6 | 接受 |
| M R2 标题正式在 scope | §4 | 接受 |
| M stuck-runner 解释错误 | §6 | 接受 |
| M 验证过 claim | §7 | ✅ 实测 lint 零信号(带阳性对照) |

### 第 2 轮(6 HIGH + 1 MEDIUM + 1 LOW)

| 结论 | 处置 | 我是否独立复核 |
|---|---|---|
| H1 混合模型只是重新包装,仍有开放类别 | §3.3 去掉 generic 入口;§3.4 清单为空 | 接受(「canonical runbook」确实谁都能自封) |
| **H2 rework 会制造错误的 founder authority** | **触发范围裁定 → 方案 B**;§3.4 / §3.5 | ✅ **逐字证实**:INSERT 硬编码 `'founder'`,`founder_feedback_verbatim` ← Lead 文本,再经 dispatcher 当 `founderFeedback` 交给替代 Runner,principal 仅 `"master"` |
| H3 硬前置不充分且不可执行 | 方案 B 下不再授权该机制,前置条款整体撤下 | 接受 |
| H4 顺序更安全但非 crash-safe | 同上,不再声称 crash-safe | 接受(`clientRequestId` 只让 API 可重放,不能让前面的 SQL 原子化) |
| H5 自洽扫描不完整 / roadmap 过期 / 抬头覆盖声明错 | §5 去版本化 + 补抬头位点 | 接受 |
| H6 stuck-runner 拟稿反向放宽 kill/ship/close | §6 精确措辞 | 接受(我拟的措辞确实会那样被读) |
| M7 验证边界仍过 claim | §7 收窄到「当前 checkout 的装载链」 | 接受 |
| L8 `progress.md` 被无关内容污染 | PR 前清理 | 属实 |

### 第 3 轮(2 HIGH + 2 MEDIUM)

| 结论 | 处置 | 我是否独立复核 |
|---|---|---|
| **H1 空清单被别的条款重新打开** | §3.0 改标题去 self-serve;§3.4 补「仍须 founder 授权」;§3.6 删「报备不是请示」;§5 的 TL;DR / R3 边界 / Current contract 三行改写;§6 写明 R5 当前不授权任何机制 | 接受 —— 从标题或 TL;DR 进来确实会被读成可自决 |
| **H2 披露模板自身制造错误归属,且「任何 rework」过宽** | §3.5 整节重塑:限定 operator 路径、四项分开写、定性为 detective disclosure | ✅ **逐字证实且推翻我自己的改动**:`:30117` engine 路径 `'engine'` + founder 逐字字段 `NULL`;`:30721` operator 硬编码 `'founder'`;`:36708` authority 是参数 |
| M3 roadmap 混淆授权来源与运行前置 | §5 `Relationship to Track 2` 行改写 | 接受 |
| M4 research / exploration 仍陈述作废设计且随 PR 提交 | 两文件顶部加**逐条列出失效结论**的醒目横幅 | 属实,已处理 |

Codex 同时确认的正面判断:混合模型方向对;R2 标题修复应保留;去版本化 roadmap 方向对;
§7 验证边界「现在基本诚实」。

### 第 4 轮(1 HIGH + 4 MEDIUM + 1 LOW)

Codex 开场即确认:**「R5 的核心模型已经安全」** —— 三判据只分类、授权必须来自闭合枚举、
空清单不授权任何操作。findings 在收敛(5H → 6H → 2H → 1H)。

| 结论 | 处置 | 我是否独立复核 |
|---|---|---|
| **H1 §5 漏两个位点,其中一条是危险的虚假防线** | §5 补两行 | ✅ 逐字证实:`:239` 写着「Track 2 hard gate enforces this server-side」;`:126` 写着审计表「captures … how the founder ultimately resolved it」 |
| M2 disclosure 定性仍自相矛盾(§0 与风险表还写「补偿控制/抵消」) | 全文统一为 **detective provenance disclosure** | 属实,是我 §3.5 改了但没回头扫全文 |
| M3 执行顺序不够 fail-closed | §3.5 写死顺序 + §3.6 显式「等待 founder 授权」 | 接受 |
| M4 我对 R3 的描述不准确 | §6 改写 | ✅ 证实:R3 的 runner 分支确实含「close dead session + dispatch successor」 |
| M5 目标仍在冒充「自决已落地」 | §1 改写 + PR/结单口径写死 | 接受 —— 这正是我该自己盯住的过 claim |
| L6 writer census 少算一条 | 见下 | ✅ 属实 |

### 更正:rework writer 的完整 census(四条,不是三条)

我第 3 轮只数了三条就说「只有 operator 那条有缺陷」。完整 census 是**四条** operational writer:

| 位置 | authority | founder 逐字字段 | 归属是否正确 |
|---|---|---|---|
| `:30113` engine 路径 | 字面量 `'engine'` | `NULL` | ✅ |
| `:30717` **operator 路径** | 字面量 `'founder'` | 存**请求里传入的**文本 | ❌ **缺陷在这里** |
| `:36704` | **参数** `?` | 参数 | ✅ |
| `:37971` founder-feedback-source 路径 | 字面量 `'founder'` | 参数 | ✅ 该路径本就校验 founder feedback 载荷,硬编码是**正确归属** |

结论不变(缺陷只在 operator 一条),**但现在才是被完整 census 证明的** ——
之前那个「唯一」是数了三条就下的。**一个「唯一」的强度,取决于 census 是否完整,
不取决于已数的那几条有多一致。**

### 第 5 轮(1 HIGH + 3 MEDIUM + 1 LOW)

Codex 再次确认「核心 R5 模型仍然安全」;剩余全是**旧合同扫漏**与**文档自身表述**。

| 结论 | 处置 | 我是否独立复核 |
|---|---|---|
| **H `Order of precedence` 仍称经 Track 2 配置旋钮放权** | §5 补该行 | ✅ 逐字证实:`:407` 写着 Loosening 「happens centrally via … the Track 2 configuration knobs, and version bumps」 |
| M R2「无 auto-close exception」与 R3 冲突;R3 开头会否定未来的 R5 清单 | §5 再补两行 | 接受(R3 的 runner 分支确含 close dead tmux + dispatch successor) |
| M §3.7 与 §3.5 字面冲突 | §3.7 区分「Lead 自己写」与「服务端机制在 founder 授权下的安全失效」 | 接受 —— 否则两节无法同时遵守 |
| M 交付 framing 仍未从所有入口诚实(标题/§0/§1) | 标题改为「分类框架(FLY-1895 前置件)」;§0 去掉「自决姿态」;§1 直说本单不交付自决 | 接受 |
| **L 我说「没有内容级测试」是假的** | §7 加第 5 项必跑项 + research.md 就地更正 | ✅ 证实:`test-fly26-rules-split.sh` Test 6.12 断言 H1 抬头 + 两个前缀下的全部 reserved 端点 |

**LOW 这条有实施后果**:它是一条**硬约束** —— 改动不得动到那些端点关键词、不得改掉
`# Founder-Only Authority` 这个 H1。

### 我的第二次「扫描范围」型错误(记录在案)

第 3 轮我数了三条 rework writer 就写「唯一」,完整是四条;第 5 轮我又因为只 glob
`__tests__/` 目录而漏掉直接躺在 `scripts/` 下的内容级测试,并据此写下「没有内容级测试」。

两次同一个病:**零命中/一致样本被当成了完整 census。**
一个「唯一」「没有」的强度,取决于**扫描范围是否覆盖全集**,
不取决于已看到的那几条有多一致。

### 第 6 轮(1 HIGH + 5 MEDIUM)

| 结论 | 处置 | 我是否独立复核 |
|---|---|---|
| **H 我上一版的修复开了一个新洞** —— 写「或 founder 产品级直令能放权」,而 Annie 在 FLY-1887 那句正是产品级直令,Lead 可据此主张「清单虽空但直令已放权」 | §5 改三段(直令授权的是「去改中央合同」,不是「现在可以做」);§3.4 补同款防误读 | 接受 —— 这是我修一个洞时开的另一个洞 |
| M2 §5 还漏五处把 Track 2 数据/配置写成授权来源(`:62 :115 :259 :310 :509`) | §5 补五行 | 接受 |
| M3 R2 那段若提 R5,会被读成 R5 可以授权 close | 该段**只提完整 R3 rescue**,不提 R5 | 接受(与 §6 正面冲突,是我制造的) |
| **M4「one atomic action」是虚假防线** | 改「one complete, enumerated authorization unit」并声明非事务、非 crash-safe | ✅ 实测 `rescue-runtime.ts:279` 起:terminate → close → dispatch 顺序执行且逐步早退,successor 起失败时旧 Runner 已被终结并关闭 |
| M5 framing 仍未从所有入口同步(progress.md / research.md 结论 / base README) | README 进改动清单;progress PR 前清理;research 结论就地更正 | ✅ 实测 README 确写着「Override base in safety-critical edge cases」 |
| M6 验证只能证明装载与旧锚点,证明不了 R5 语义被正确写入 | §7 新增精确静态断言(最终 25 条) | 接受 —— 这是我 §7 的真实缺口 |

Codex 同时确认:混合模型正确;§3.7 对「Lead 直接写行」与「获权服务端机制自行撤销」的区分
**清楚且正确**;R2 标题修复应保留。

### 我制造的洞的类型(记录在案)

第 5 轮我为了堵「Track 2 配置 = 授权来源」,写下「只有中心条目**或 founder 产品级直令**能放权」
—— 结果第 6 轮被指出:Annie 的原话本身就是产品级直令,这条修复**反而**给出了一条绕过空清单的
新路径。

教训:**堵一个授权来源时,新写下的那个「合法来源」本身要立刻当成攻击面重读一遍** ——
问「谁能声称自己命中了它？」。我写的时候只想着「把 Track 2 排除掉」,没回头看新句子把门开给了谁。

### 第 7 轮(2 HIGH + 3 MEDIUM + 1 LOW)

| 结论 | 处置 | 备注 |
|---|---|---|
| **H1「Track 2 不是授权来源的*唯一*途径」** | 改为「Track 2 **本身不是**授权来源;ALLOW / 未 403 / 请求成功都不创造授权」 | 我那句话字面上等于**承认它是途径之一** —— 一个字之差 |
| **H2 standing carve-out 的激活条件可被合同编辑者自证** | 三项并列条件 + 「加条目的人不能同时当批准人」 | 攻击者答案很简单:自己写进去、自己宣布已固化对齐 |
| M3 §5 还漏两处(`:95-97` auto-approve label、`:267-268` evidence 驱动的 per-project auto-close) | 补两行 + roadmap 双路径把 audit data 定性为决策证据 | |
| M4 七条断言没覆盖本轮刚修的 HIGH | 加第 8 条**组合断言** | 否则第 6 轮那个绕过可复活而七条全绿 |
| L5 §8「不改 R1/R2 规范内容,只补 R2 标题」不属实 | 改为「不改变 reserved-action **集合**;另做 §5 明列的自洽性修正」 | §5 确实会改 R1 措辞与 R2 catch-all |

Codex 同时确认:混合模型正确;R2 标题修复应保留;roadmap 去版本化方向正确;
R3 的「完整 rescue unit + 非事务/非原子/非 crash-safe」表述**准确**。

### 一个反复出现的模式(记录在案)

第 5→6→7 轮,我连续三次在**堵一个授权来源时,新写的句子又开了一条**:

- 第 5 轮堵 Track 2 配置 → 写「或 founder 产品级直令能放权」→ 第 6 轮指出 Annie 的原话就是直令;
- 第 6 轮堵直令 → 写「条目被写进清单即生效」→ 第 7 轮指出**写条目的人就是我自己**;
- 同时「不是唯一途径」这种措辞,字面上等于**承认它是途径之一**。

共同的病:**我在写「什么才算合法授权」时,只想着排除刚被否掉的那一个,没有把新句子当成攻击面
重读一遍**——问「谁能声称自己命中了它?」。安全条款的每一个肯定式表述,都是一扇新门。

### 第 8 轮(2 HIGH + 3 MEDIUM)

| 结论 | 处置 | 备注 |
|---|---|---|
| **H1 §5 整节漏扫 R4** | §5 补 R4 行 | R4 的紧急路径只要求 founder「explicitly aware」⇒ 可被读成:自己决定、先通知、再执行。⚠️ 若产品意图**就是**允许 Lead 自主发起 fleet restart,那「R3 唯一」的说法要改 —— **已列为待 Lead 确认意图的一项** |
| **H2 roadmap 尾段把第 6 轮堵掉的洞又开了** | 改为:audit 证据与 founder 产品方向都只是「提出合同变更」的**输入**,都不是运行时授权 | 我自己的回归 |
| M3 文件抬头允许项目层加「project-local authorization phrases」 | 限定为只能提供**解释**用的别名/示例,不得创造/扩大/转移授权,不得新增 R5 条目 | |
| M4 将来条目的形状不足;第 8 条断言漏两项 | 新增 §3.10 最小形状 + 断言补③④ | 删掉那两道门,八条断言仍会全绿 |
| **M5 我又夸大了 Test 6.12 的证明力** | §7 第 5 项降级 + 补三条实施断言 + 承认正向 sentinel 证明不了「全文没有相反句子」 | 它不覆盖 rework endpoint |

### 结构性解法(本轮真正的改动)

第 5~8 轮我连续四次「修好一个授权来源、新句子又开一扇门」。逐句打补丁在**制造**漏洞。
⇒ 新增 **§3.9 AUTH-CANON**:授权规则在本文件**只定义一次**,其它所有位置
(R1/R2/R3/R4/Order of precedence/Track 2/roadmap/TL;DR/抬头/README)
**一律改成指向它的一句话,不得各写各的版本**。
攻击面从「N 个各自措辞的肯定句」收敛成**一个**。

这也是对我那个反复模式的真正答复:问题不在每一句写得够不够严,
而在于**同一条规则被重述了 N 次**——重述次数就是攻击面大小。

### 第 9 轮(4 HIGH + 2 MEDIUM)—— HIGH 数**上升**,因为我的结构性修复本身有缺陷

| 结论 | 处置 | 备注 |
|---|---|---|
| **H1 AUTH-CANON 不能当全局定义** | §3.9 改为**两个来源类别**,各规则保留自己的绑定 | ✅ 我原写「绑定 run + 机制 + 当前状态」是 **R5 专属**的,**当全局定义会毁掉 R1 的 PR-head 新鲜度与 R2 的 session identity**;我还写「standing entry 将来才有」—— **R3 现在就是** |
| **H2「攻击面从 N 收敛为 1」不成立** | 改为如实表述 + 要求**完整 phrase census(含整个 bundle)** + 否定式扫描 | 我第三次犯 census 病:**没做普查就宣布收敛**。且漏扫同 bundle 的 `runner-messaging-rules.md`(称 Bridge 已验证 founder 授权 —— audit_only 下是虚假防线)与 `runner-reengage-rules.md` |
| **H3 R4 授权政策未决,不能同时宣称「R3 唯一」** | **⛔ 需 Lead 裁定**(已上报) | ✅ 实测双重口径**在代码里**:`flywheel-restart-guard.py` 正常路径写「founder 拍板后」、紧急路径写「Lead/founder 明确知情」。**若判定紧急路径也需明确批准,本单就不再是纯文档改动** |
| **H4 rework 会 close 旧 actor ⇒ FLY-1895 只修归属不够** | **⛔ 需 Lead 决定 FLY-1895 范围**(已上报) | ✅ 实测 `workflow-rework-coordinator.ts:411` 在 holder activation 失败于不可逆终态时调 `closeActorForReworkSupersession` → `closeRunner()`。**这正撞 R2「任何终结 Runner 生命的动作」**。我把 FLY-1895 说成充分前置件是 **overclaim** |
| M5 standing entry 激活证据不可操作 | 新增 §3.10a 六项证据 + **独立确认角色不得是添加者** | |
| M6 三判据仍能把破坏性动作分类成 recovery | 新增 **§3.2 Step 0 硬排除**(先于判据)+ 扩宽 Zero work loss 到未提交状态/活上下文/transcript/forensic | Codex 注明:因清单为空,当前不会立即授权破坏性操作,故非当前 HIGH |

### 本轮的两条 ⛔ 阻塞项(超出我的权限,已上报 Lead)

1. ~~**R4 的产品意图**~~ —— ✅ **已拍板(2026-08-19,Tadashi):不能,Lead 不得自主发起。**
   R4 = 拿到授权后的 transport 规定,**不是 carve-out**,「R3 唯一」维持。
   Lead 另补一条**显式豁免**:**ship 后的自动重启链不算 Lead 发起**,其授权来自 founder
   对那次 ship 的批准本身 —— 这是既有生产事实,**不写会造出新的自相矛盾**。
   (这条豁免是 Lead 想到的,我没想到:我只顾着堵发起权,没检查堵完会不会把现存的合法
   自动链也判成违规。**堵一个口子时,要同时问「现在有谁正在合法地穿过它」。**)
   ✅ **guard 文案裁定(2026-08-19)**:那是代码改动,**本单不碰**。
   R4 正文如实标注:**运行时 guard 的现行文案宽于本合同,收紧归 FLY-1895(授权层对齐)**。
   「文档比 guard 严格」是安全方向,可以先行。
2. ~~**FLY-1895 的范围**~~ —— ✅ **已裁定:走硬栅栏路线。**
   FLY-1895 必须**栅栏 / 证明恢复类条目不可达**
   `closeActorForReworkSupersession → closeRunner` 那条分支;**做不到则 `workflow_rework`
   永远要 per-instance founder 授权**。Lead 已更新 1895 卡,并把 guard 文案修正也追加进其 scope。

### 范围膨胀提示(已上报)

✅ **已裁定(2026-08-19)**:

| 文件 | 判定 |
|---|---|
| `lead-rules-base/` **目录内全部** | **in scope** —— 含 `runner-messaging-rules.md` 那句「Bridge 已验证 founder 授权」的**虚假防线**(生产跑 `audit_only`,这句**主动有害**,必须修)与 `runner-reengage-rules.md` 的 abandon 表述 |
| `lead-rules-base/README.md` | **follow-up**,记台账 |
| `scripts/hooks/flywheel-restart-guard.py` | **follow-up**,归 FLY-1895 |

### 第 10 轮(3 HIGH + 2 MEDIUM)

| 结论 | 处置 | 我是否独立复核 |
|---|---|---|
| **H1 「全量 census」漏掉整个动作动词空间;两处自主关闭指令就住在 dept bundle 里** | 两个文件进改动清单;census 扩成**授权词 + 动作动词**两个空间 | ✅ 逐字证实:`runner-patrol-rules.md:65-66` 对 parked-alive / dead 直接指示 wrap up + 关闭;`department-lead-rules.md:491` 指示按常规方式关闭 Runner。装载链实测两者**都进 dept bundle**(`lead-rules-bundle.sh:365`/`:349`、`claude-lead.sh:2502`) |
| **H2 AUTH-CANON 仍有三套互相冲突的版本** | 六项证据并入 AUTH-CANON(B);§3.4 与 §3.10a 降为指针;§5 那行改纯指针 | 接受 —— 攻击者会挑**条件最少**的那版;而 §5 那行还把第 9 轮已否掉的**全局 binding** 写了回去 |
| **H3 post-ship 豁免没有可判定的来源栅栏** | 钉死 provenance / target / causality 三项,并改写成「该次 R1 ship 的内置副作用」而非第三种授权来源 | ✅ 证实手工入口与自动链**共用 transport**(`request-restart.sh` → `self-ship-restart.sh`),故「走 updater 队列」区分不出来 |
| M1 Step 0 一刀切会永久排除将来修好的 rework | 区分「产生/转移新权限」(永久排除)与「服务端获权后的单调收紧」(可由将来条目列举) | 接受 —— 否则 Step 0 与 §3.7 字面冲突 |
| M2 README 的 scope 指令自相矛盾 | 从「本轮必须改」列表移除,遵 Lead 裁定 | 我自己制造的不一致 |

Codex 同时确认:混合模型方向正确;Step 0 与扩宽后的 zero-work-loss 方向正确;
R2 标题修复应保留;roadmap 去版本化方向正确。
并点名我当前**最大的一处 overclaim** 就是把窄关键词扫描称作完整 census —— 已改。

### 最要紧的一条产出(已单独报 Lead)

`runner-patrol-rules` 与 `department-lead-rules` 里的自主关闭指令,
和 R2「关闭 Runner 归 founder」**同时装进每一个部门 Lead 的提示词**。
这不是未来风险,是**现在每天都在生效的生产矛盾**;而且 patrol 那条只要求核对
founder / QA acceptance —— 而 R2 明写 acceptance **不构成**绑定该 session 的关闭授权。

### 第 11 轮(4 HIGH + 2 MEDIUM)

| 结论 | 处置 | 我是否独立复核 |
|---|---|---|
| **H1 operator rework 的实际调用面比我写的 fence 宽** | 在 FLY-1895 证明 close 分支不可达前,它**命中 Step 0**,不得称 recovery-class;若走 founder per-instance 调用,绑定面扩到 target node/attempt、feedback digest 与来源、base/head、invalidation scope、可能被关闭的 exact session | 接受 —— consent 调用只拿到 `requestedReason`,**没绑目标节点**;thread 披露约束不了 successor 读到的权威输入 |
| **H2「引擎级联继承触发动作授权」重新造出第三类授权来源** | 拆成三行:post-ship = 内置副作用(唯一);引擎 housekeeping = **不在 Lead 合同辖域内**(不是「继承」);手工/补跑/repair/fallback/redrive **一律回 R2** | ✅ 证实:**QA PASS 是 QA verdict 不是 founder 授权**;`HeartbeatService` 的 GEO-270 周期 reaper 按状态谓词自动关闭,**根本没有可继承的已批准动作**。**这条修正的是 Lead 给我的表述,已并排上报他** |
| **H3 加宽后的 census 仍漏「效果同义形状」** | 按效果搜 `abort / stop / replace / re-dispatch / reclaim / finalize / cleanup / remove-worktree`;**人工通读全文**而非只读匹配行;`auto-qa-pipeline.md` 进改动清单;R2 catch-all 判据改为「结束/替换/finalize/删除 Runner 身份·上下文·工作树」,**不得要求进程仍 live** | ✅ 三处**按内容**证实(实测行号 86 / 55 / 238,review 报的 80 / 50 / 234 有偏差) |
| **H4 AUTH-CANON 对 R1 的摘要会毁掉受控 head carryover** | AUTH-CANON 改**纯指针**,不再复述任何一条 fence | ✅ 逐字证实合同保留该例外:QA-evidence commit 移动 head 后 Bridge **自动 rebind gate 到新 head** |
| M1 R3 与六证据门缺可核验衔接 | 新增 §3.9d **祖父条款**:六证据只适用于本门之后的新条目;R3 的依据是 FLY-871 直令 + 生产事实,**且明确不可被援引为先例** | 不硬凑 —— 让 R3 事后补证等于实施者自证,正是本门要堵的 |
| M2 验证项会把本轮几个洞判绿 | 断言从 8 条扩到 14 条(最终实现为 **25 条**)(补 rework 绑定面、旧句精确为零、housekeeping 不写成泛化继承、post-ship 三栅栏、**R1 carryover 的反向断言**、R3 祖父说明可解析) | 接受 —— 第 8 条只钉 `run + mechanism + state`,正好固化 H1 的弱 fence |

### 第三次「收紧时忘了问谁在合法穿过这扇门」

① R4 的 self-ship 链(Lead 补)② 引擎级联(Lead 补)③ **R1 的受控 head carryover(Codex 补)**。

第三次的形状更细:**我是在「概括」别人的规则时把它改掉的** ——
我以为自己只是在 AUTH-CANON 里复述 R1,实际上那句概括删掉了 R1 明文保留的例外。
**概括别人的规则,本身就是在改那条规则。** 已写进 research 的方法论附录。

### 第 12 轮(3 HIGH + 5 MEDIUM)—— Codex 首次明确给出收敛判断

开场原话:**「剩余问题已收敛到明确接缝,不是在重审已接受的架构。」**
Step 0 硬排除 + 三判据只分类 + 空清单 + 闭合枚举授权,这四层**没有**被重新打开。

| 结论 | 处置 | 我是否独立复核 |
|---|---|---|
| **H1 只栅栏 close 分支不够 —— rework 还有独立的 replacement 路径** | operator rework 保持在 Step 0 外,理由从一条变两条;§8 撤回「不改变 R2 集合」的 overclaim | ✅ 证实 `replacement_pending`(coordinator `:214`/`:376`);且**证实 quiescence validator 被 Annie 直令 NEUTRALIZED**(FLY-1434,2026-07-24 事故复盘)—— 既不能当证据,**也不能提议恢复** |
| **H2 项目层按现行 precedence 仍能覆盖中央合同** | ⛔ 上报 → **Lead 裁定 (a) 只做文档层**;装载层对齐立 **FLY-1910**;正文改**三段式**(意图 invariant / 当前机械现实 / 指针) | ✅ 逐字证实三处:base 的 precedence 段、Test 6.11 的 later-wins 固化、loader 顺序 |
| **H3 断言 8 把刚删掉的全局概括从验证侧塞了回去** | 收窄到「仅空清单期间的 R5 candidate 路径」;standing 断言改引 AUTH-CANON(B) 完整六项 | 接受 —— 否则正确的 R4 授权反而过不了断言 |
| M1 Step 0 的 fail-closed 顺序在 evidence 段被打乱 | evidence 段改为先跑 Step 0、命中即如实写「已排除」 | 我自己制造的顺序矛盾 |
| M2 六项证据可被拼接 | 改为**一份不可拼接的 canonical activation manifest**,共同绑定同一 entry digest / 机制版本 / 部署版本 | 接受 |
| M3 R1 carryover 只有反向断言 | 补**正向**断言(rebind 例外必须仍存在)—— 否则实施者直接删掉那条规则仍全绿 | 接受,这是空过绿的经典形状 |
| M4 census 状态被写成「已完成」 | retitle 为**词法扫描**;完成条件 = 逐文件 disposition 的**人工台账** | 属实 |
| M5 R3 的「生产运行事实」被写成授权依据 | 改为:授权**只来自** exact FLY-871 批准;运行事实只解释**为什么保留祖父条款** | ✅ 接受 —— 否则与 AUTH-CANON 负面清单直接打架 |

### 第 13 轮(2 HIGH + 2 MEDIUM)—— **Codex 判定:剩余有界,走出口 ②**

Codex 开场原话:**「剩余问题是有界的。全部落在 §9b 已声明接缝内,没有发现新文件、
新机制或新问题类别;按收敛栅栏应走出口 ②:修正后做 R14 最终验证。」**
并说明它按 fail-closed 与 transitive control 的标准重读了所有肯定式授权语句。

**我按 §9b 的自我约束逐条点名核对**(不许整体感觉判定):

| 结论 | 命中接缝 | 处置 | 我是否独立复核 |
|---|---|---|---|
| **H1 判别器不可机械判定,且与 ④ 冲突** | #3 #7 | 改判**本次 exact invocation 的 causal ingress**;同 sink 自动/手工可分属不同类;state transition 需 engine-origin receipt;**未知/混合/无法证明 ⇒ fail-closed 归 ①** | 接受 —— 自动 self-ship 与手工 restart 共用 transport 是**本单自己实测过的**,按代码路径判必然假阳 |
| **H2 ④ 只钉了触发来源,没闭合破坏性副作用集合** | #3 #9 #7 | ④ 增加:闭合可版本化的允许副作用清单 / 每项的对象推导+身份栅栏+mutation-time 重读 / 明确禁止项 / **新 deleter 必须重新批准合同,接进 autoclean seam 不自动继承授权** | ✅ 证实 post-ship 含 remote branch CAS + issue closeout + **全项目 trailing sweep**,且 composition root 要求**未来每个新 deleter** 都挂既有 seam |
| M1 R3 祖父条款在 AUTH-CANON 外形成第二套规范 | #2 #5 | 唯一例外**并入 AUTH-CANON(B) 本体**;§3.9d 只留解释与指针 | 接受 —— 这正违反我自己定的「授权规则只定义一次」 |
| M2 验证会把这两个 HIGH 判绿 | #7 | 新增**第 16 条反例断言**(手工入口必归①/间接迁移必归①/来源不明必归①/清理对象越界必拒/新 deleter 未列清单必拒) | 接受 —— 断言 12/15 只查「在位」,把有缺陷的文字原样写进去照样全绿 |

**四条全部命中白名单,零条指向新文件 / 新机制 / 新问题类别 ⇒ 出口 ② 成立。**
下一轮 R14 是**最终验证轮**,之后**无论结果**按现状落地。

### 一条被当轮打回的「教训」(记录在案)

我在 R12 后写进方法论、并获 Lead 认可的那条「**肯定式定义开门,能力式判据关门**」,
**第 13 轮立刻打回了它的第一版实现** —— 我给出的能力式判据
(「是否**存在** Lead 可达的调用面」)落在了**错误的判定单位**上:按代码路径判,
既产生假阳(合法自动链被判成 Lead 发起),又产生假阴(间接制造的迁移被判成引擎自有),
而且要求证明一个**完整负面**。

⇒ 完整教训是**两层**:①用能力式判据替代资格式定义;
②**判定单位必须是「这一次事件」而不是「这段代码」**。
**第二层是我漏掉的那半**,而且因为能力式判据读起来很硬,漏掉时更不容易被质疑。
已回写方法论附录,不留一个「被认可但不完整」的版本。

### 第 14 轮 —— **最终验证轮**(2 HIGH + 1 MEDIUM,全部在接缝内)

Codex 收尾原话:**「以上全部属于既有白名单接缝,因此按既定收敛栅栏仍是出口②的残余,
不是新地盘。」** 并确认 R2 标题修复仍然合理、roadmap 去版本化没有新增主动有害问题。

| 结论 | 命中接缝 | 处置 |
|---|---|---|
| **H1 断言 15 仍在强制那条已被 R13 否决的旧判别器** | #3 #7 | 改写断言 15;旧措辞现在**只作为禁令的引用**存在(已反向自证:全文该短语仅剩 1 处,且在「不得出现」子句内) |
| **H2 ④ 的副作用集合仍未真正闭合** | #3 #7 #9 | **本单直接给出初始允许清单**(4 项,逐项钉对象推导),不再留给实施者临场定;**`postShipSweep` 明确不得作为单一允许项**(它本身是开放类别);断言 16 补 ⑥逐项 fence + ⑦sweep 未被列入 |
| M R3 祖父条款仍有第二份规范定义 | #2 #5 | §3.9d 削成**纯解释 + 指针**,规范本体只在 AUTH-CANON(B) |

### ⚠️ 这三条修复**未经再一轮评审**(诚实标注)

按 Lead 的收敛栅栏,**R14 是最终验证轮,之后无论结果按现状落地**。
我仍然修了这三条,理由是它们**便宜、具体、且第一条是我自己留下的内部矛盾**
(断言强制的判别器与正文修正后的判别器**正面冲突**,会主动误导实施者把错模型写回去)。
栅栏约束的是**评审循环**,不是基本卫生。

但必须说清楚:**这三处改动之后没有再跑 review**,所以它们**没有被独立验证过**。
如果它们本身引入了新问题,那就是本单落地时的已知残余风险 —— 记在这里,不粉饰。

### 落地判定

- R13:全部在接缝内 ⇒ 出口 ②;
- R14(最终验证轮):仍全部在接缝内,**零条指向新文件 / 新机制 / 新问题类别**;
- ⇒ **按栅栏落地**,残余如实进本台账 + 下游单(FLY-1895 / FLY-1910)。

### 我自己的一处错误(记录在案)

我曾把 Tadashi 第 4 点从「自助 rework」主动扩大到「任何恢复类 rework」,并向他说明这是
有意改进。理由是「误标是机制属性、与谁批准无关」——**没核就外推,事实不成立**(见上表 H2)。
教训:**最该自我审查的时刻,正是自己的推理读起来最顺、且我专门宣告「这是我有意改的」那一刻。**
