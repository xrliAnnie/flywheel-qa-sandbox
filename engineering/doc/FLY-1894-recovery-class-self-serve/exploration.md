# FLY-1894 恢复类 run 状态操作 Lead 自决 — 探索

Issue: FLY-1894 (https://linear.app/geoforge3d/issue/FLY-1894/规矩机制-恢复类-run-状态操作-lead-自决-固化进-lead-rules-basefounder-only-authority-新增)
日期: 2026-08-19
基于: 无

> ## ⚠️ 本文部分结论已被 plan v4 / 范围裁定 B 作废
>
> 本文是**过程记录**,保留原样以便追溯推理链。以下结论**已不成立**,不要据此实施:
>
> | 本文的说法 | 现状 |
> |---|---|
> | R5 是一条已生效的 prompt 层自决授权 | **作废** —— R5 是分类框架,当前**不授权任何机制**;唯一生效的 carve-out 是 R3 |
> | thread 报备是直接状态写的唯一审计轨 | **作废** —— consent audit 与 operator rework 的多条 receipt 都会落盘;真正无 receipt 的只是直接状态写那几步 |
> | R5 应纯判据式、不该枚举 | **作废** —— 改混合模型:判据只分类,授权靠**闭合的逐项清单**(本版为空) |
> | 三判据满足即 Lead 自决执行 | **作废** —— 分类不是授权;清单为空期间仍须 founder 授权 |
> | 「只要发生恢复类 rework 都须声明」 | **作废** —— 缺陷只在 operator 一条路(engine 路径记 `engine` 且 founder 逐字字段为 `NULL`) |
>
> 权威版本以同文件夹 `plan.md` 为准。


## 1. 这单要解决的问题

2026-08-19,Tadashi(Flywheel Eng Lead)把一个 held-run 的解锁提案挂起等 Annie 裁决。
Annie 的原话(FLY-1887 thread):

> 「这个东西你为什么要等我 你自己做决定就可以」

紧接着的第二句,把这件事从「这一次」升成「产品规矩」:

> 「要把这个东西都固化在我们的产品里面,以后对所有的其他项目,用 Flywheel 其他项目的
> leader,包括 Honey Lemon 他们,大家都是一样的处理方式。」

所以这单**不是**「给 Tadashi 开个例外」,而是:把「恢复类 run 状态操作 Lead 自决」这条
授权,写进**全项目全 Lead 一体适用**的那一层。

## 2. 当前状态审计(动手前先看代码)

### 2.1 规矩现在住在哪里 —— 只在一个人的记忆里

| 位置 | 形态 | 覆盖面 |
|---|---|---|
| `~/.claude/agent-memory/flywheel-eng-lead/feedback_recovery_class_run_ops_self_serve.md` | Tadashi 的私有 memory | **只有 Tadashi** |
| `~/.claude/agent-memory/flywheel-eng-lead/reference_engine_deadend_states.md` 死角②/⑮ | 同上,注释里指向上面那条 | **只有 Tadashi** |
| `packages/teamlead/lead-rules-base/founder-only-authority.md` | 全 Lead base 规矩层 | **全项目全 Lead** — 但**没有**这条 |

⇒ 今天的实际效果:Honey Lemon / Hiro / Ariel / Triton / 任何新项目的 Lead 撞到同一类
held-run,仍会按 `founder-only-authority.md` 的现状去敲 founder 的门。Annie 的直令没有
落到他们身上。**这就是这单要补的那一格。**

### 2.2 base 规矩层怎么被装载(确认这条写进去真的会生效)

- 文件:`packages/teamlead/lead-rules-base/founder-only-authority.md`(516 行)
- Claude Lead:`packages/teamlead/scripts/claude-lead.sh:2583` `BASE_FOUNDER_AUTH_RULES` →
  append 进 system prompt
- Codex Lead(full-access / write-capable / infra-bot TUI):经
  `packages/teamlead/scripts/lead-rules-bundle.sh` 的 `assemble_full_access_governance`
  拼进 `SYSTEM_PROMPT_FILES`;`governance_required=1` 时**找不到这个文件直接 rc 10 fail-closed**
- companion Lead(Mufasa / Belle):**故意跳过**这个文件,换成更短的
  `companion-safety-contract.md`(它们不开 Runner,本条对它们天然 inert)
- external agent(Anna):同样跳过

⇒ 写进这个文件 = 自动覆盖所有**会开 Runner 的** Lead,零额外接线。这正是 Annie 要的
「大家都是一样的处理方式」。

### 2.3 文件现有结构与「R3 先例」

```
Current contract (v1.29.x 校准窗框架)
R1 — Merge / Ship Authorization        ← founder 之门
(R2 内容:Runner 生死 / terminate / reject / defer / shelve / retry / close-*)
R3 — Infra Self-Heal Carve-Out         ← 已有的、极窄的自决豁免先例
R4 — Fleet Restart Discipline
Order of precedence / Track 2 / Future autonomy roadmap / TL;DR
```

R3 是**唯一已有的 carve-out 先例**,它的写法值得逐条抄:

1. 开头点名授权来源(「The founder (Annie, FLY-871) has authorized…」)+ 明说它有多窄
2. **The ONLY authorized action** —— 把动作枚举死
3. **Hard conditions (ALL must hold)** —— 判据全满足才算命中
4. 结尾一句把边界钉回去:超出这个动作的一切,仍归 R1/R2

R5 应当同构。差别在于:R3 是**按动作枚举**(只有 restart-in-place 一种),
R5 是**按判据分类**(三条判据全满足即属恢复类)。因为恢复类的具体手法会随引擎演化
(今天是死角⑮四步配方,明天可能是别的死角),枚举会立刻过时,判据不会。

### 2.4 一个顺手发现的真实缺陷:R2 没有标题

`grep -n '^## '` 的结果里,`## R1` 之后直接跳到 `## R3`。R2 的内容(第 191 行起的
`### Reserved actions (current scope)`)在 markdown 结构上**被嵌在 R1 底下**,没有自己的
`## R2 —` 标题。而全文(包括我要新增的 R5 边界条款「R1/R2 不变」)反复引用「R1/R2」。

⇒ 一个照着规矩办事的 Lead 读到「R2 不变」时,**在文档里找不到 R2**。
这是一个先于本单存在的结构缺陷,但它直接影响本单新增条款的可读性。处置见 plan §4。

## 3. 规则内容的来源(逐字对照 blueprint)

蓝本 = `feedback_recovery_class_run_ops_self_serve.md`。要搬进 base 层的实质:

**判据(三条全满足才算恢复类)**
1. 零工作丢失 —— commit 已推送 / 产物还在
2. 方向 = 回到引擎自己的正常轨(引擎接管后自动推进)
3. 可回退或幂等

**满足 ⇒** Lead 自己决定并执行,做完在 issue thread **报备**(不是请示)。

**边界不放宽 ⇒** terminate / reject / abandon / 任何丢工作或终结 runner 生命的操作,
以及 merge / ship,仍是 founder 之门(R1/R2 逐字不变)。**恢复 ≠ 终结。**

**实例引用** —— 死角⑮四步配方(reviewer 429 churn → run held + node 挂 running/死 exec):
① `workflow_run.status` held→active(先查 `workflow_rework_delivery` 无活行)
② 补引擎没做完的一步:`workflow_run_node` state→failed + ended_at(**别清 execution_id**)
③ 死体 session 的 `pr_head_sha` 真值化为冻结 review head 全 40 位 sha
④ `POST /api/runs/:runId/rework` → 铸 attempt+1,引擎自派新体

## 4. 需要在写之前定下来的取舍

| # | 取舍 | 我的判断 |
|---|---|---|
| A | 判据式 vs 枚举式 | **判据式**。恢复手法随引擎死角演化,枚举会过时;判据不会。R3 用枚举是因为它真的只有一个动作。 |
| B | generic voice 到什么程度 | 判据 + 边界 + 报备义务全 generic;死角⑮配方作为**具名实例**保留(它是 Flywheel 自身引擎的事实,对其他项目是「长这样的东西」的样例,不是必须执行的步骤)。 |
| C | 放在哪 | R4 之后,`Order of precedence` 之前 —— 与 R3/R4 同级,读者按 R1→R5 顺序读到「例外」。 |
| D | 要不要动 Future autonomy roadmap | **要**。roadmap 的 v1.29.x 段现在写着「All approve / close actions route to the founder, every time. No per-issue / per-action / per-Lead exceptions.」——R5 落地后这句在字面上就不对了,而且 R5 恰恰是 roadmap 预言的「第一条实证放权」。不改会自相矛盾。 |
| E | R2 缺标题要不要顺手补 | 见 plan §4 —— 倾向补(一行、纯结构、让本单新增的「R1/R2 不变」可被读者定位),但明确标注为越界一行并在 PR 里点名。 |

## 5. 明确不做的事

- 不改任何代码(TS / sh)。这一单是纯规矩层 md。
- 不动 R1 / R2 的任何一个字 —— 边界不放宽是这条规矩自己的核心条款。
- 不改 Tadashi 的私有 memory(那是他的账本;本单只负责把规矩升到产品层)。
- 不做 Track 2 侧的 server-side 放行(`FounderConsentEvaluator` 门)。R5 是 prompt 层
  授权;server 端对齐是另一单。
  > **更正(research.md §3 实测推翻本节初稿)**:初稿写「生产 `decisionMode` 默认 `off`,
  > 且 rework 端点不在门里」——**两句都错**。实测生产是 `audit_only`(门写审计不拦),
  > 且 `/api/runs/:runId/rework` **在** `RESERVED_ENDPOINTS` 里。结论(本单不做 server 侧)
  > 不变,但理由换了:不是「门管不着」,而是「门今天不拦」。这个理由**会过期**,
  > 所以 R5 正文必须显式点名这个服务端保留端点。详见 research.md §3。
