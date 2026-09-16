# FLY-2244 designer 节点规范:高保真 mockup 的形态与交付 — 实施计划

Issue: FLY-2244 (https://linear.app/geoforge3d/issue/FLY-2244/流程designer-product-design-节点规范写错了高保真-mockup-的形态与交付方式)
日期: 2026-09-07
基于: 无(上游是 PR #1022 已提交的规范改动 + founder 2026-08-27 / 2026-09-01 两次口头纠正)

## 1. 这张单到现在为止的状态

规范改动**已经写完了**,在 OPEN 的 PR #1022 里(分支
`docs/fly-2071-designer-mockup-must-run-on-real-frontend`,MERGEABLE,只改一个文件
`.flywheel/agents/nodes/product_design.md`,+74 / -9)。

Issue 的三条验收:

| 验收项 | 状态 |
|---|---|
| ~~规范内部无自相矛盾(已扫)~~ | ❌ **这句是假的。** 本轮扫出一处硬矛盾(见 §2):Step 4 结尾要求 open founder_review,而同一次改动加的 ⛔ 禁止托管快照 —— 两条对撞,照字面执行开不出轮次。原验收项应改成实话 |
| founder 过目措辞 | ❌ 未做 —— 本节点的主要任务 |
| PR #1022 合入 | ❌ 未做 —— 合入是 founder 的门,不是我的 |

所以本节点的 bounded task 不是"重写规范",是:**补掉一处会让规范跑不通的冲突,然后把措辞交给
founder 过目。**

## 2. 本轮查出的问题:改后的规范和 harness 合同直接打架(必须修)

PR #1022 给 Type (b) 高保真加了这条:

> ⛔ **Do not deliver a Type (b) mockup as a hosted static snapshot** — no
> `publish-report`/Artifact/screenshot *as the deliverable*. She reviews the running
> thing at localhost, not a picture of it.

同一次改动里,原来那句「Publish it as interactive HTML and open a fresh `founder_review`」
被删成了「open a fresh `founder_review` bound to that exact committed version」。

**但 `founder_review` 这道门在代码层面强制要一个 HTTPS 托管 URL:**

```
packages/flywheel-comm/src/founder-review.ts:285
  if (!/^https:\/\//.test(input.evidence.hostedUrl)) {
    throw new Error("founder_review requires an HTTPS hosted review URL");
  }
```

而且 `packages/flywheel-comm/src/__tests__/gate-noblock.test.ts:194` 有一条名叫
**"non-HTTPS delivery"** 的用例,用的正是 `http://localhost/review`,断言**必须被拒**。

⇒ 照 PR #1022 现在的字面执行,designer runner 会卡死:规范说"不许 publish",门说"没有
HTTPS URL 就开不了"。**Type (b) 的高保真评审轮根本开不出来。**

### 修法(Lead 裁决:把「绑什么」写死,不只是把 ⛔ 措辞放软)

Lead 明确要求:「交付物 = localhost 上跑的真代码;founder_review 那一轮绑的是那个 commit
+ 那个 localhost URL,不是一张托管静态页。把『绑什么』这件事讲明白,而不是留给下一个体去猜。」

⚠️ 一处必须说清的事实约束:**localhost URL 在机器层面绑不上去** —— `--hosted-url` 强制
HTTPS,localhost 会被拒。所以规范里新增一节
`### What the Type (b) review round binds`,把一轮里的三样东西逐个点名:

| 绑什么 | 是什么 | 作用 |
|---|---|---|
| **commit**(artifact digest + 路径) | 被评审的那个确切版本 | 通过所批准的就是它 |
| **托管 HTTPS 卡** | 让轮次能开出来的**信封** | 门的硬性要求;卡里装 localhost URL + proofshot + 批注框 |
| **localhost URL** | 🔴 **交付物** —— 跑着的真代码 | 她真正打开、真正判断的东西;写在卡里,不作为绑定 URL |

并明写两个要防的失败模式:① 卡很漂亮但服务是死的 = 她已经退回两次的"假 HTML";
② 把 ⛔ 读成"什么都不许发" ⇒ 轮次根本开不出来,阶段静默卡死。

这不是新发明 —— 兄弟角色 `proto.md` 早就是 proofshot / 托管卡 配同一道门。

## 3. 还有一处措辞不整齐(轻,顺手改)

Step 0 现在仍把两种 mockup 描述成**二选一的类型**(「(a) throwaway static direction图 …
or (b) a UI increment that must live on the real app」),而 PR #1022 新加的小节把它们
重新解释成**同一条流程的两个阶段**。

对 Type (b) 的单子来说,(a) 不是"另一个选项",而是它**必经的第一阶段**(Step 2 的
concept image 本来就强制)。Step 0 真正在问的其实只有一件事:**这次改动落不落到真产品上。**
建议把 Step 0 的问法收紧成这一句,别再让 runner 以为可以"选 (a) 就不做 (b)"。

## 4. 我**不**做的事(明确划界)

- ❌ 不改 `product_designer.md`。它虽然也提到 mockup,但它自己就写着"视觉 mockup 是
  designer 的活,交出去"(`product_designer.md` 第 3 步 + CRITICAL rules),不是这次
  founder 指的那个 bug。scope discipline:她点名的是 `product_design.md`。
- ❌ 不合 PR。ship 永远是 founder 的门。
- ❌ 不把她的**理由**再升级成**教条**。上一轮已经踩过一次(她说"从现有代码改起因为省事",
  被写成"必须跑在产品自己的前端上",当场被纠正)。本轮所有措辞保持"强默认 + 可给理由破例"。

## 5. 执行步骤

1. 分支归属:**Lead 已裁决走 C** —— 从 `flywheel-FLY-2244` 开新 PR **取代** #1022,
   ⛔ 不动 #1022(不关、不推),由 Lead 去 #1022 上留指向说明。理由:① #1022 分支名是
   `docs/fly-2071-...`,linkback 绑的 FLY-2071 已于 9-05 关闭,等于挂在一张已关的单上;
   ② 我已 cherry-pick 那三个 commit,新 PR 是 #1022 的超集,不丢东西;③ 分支追踪已查证
   (`workflow-decision-routes.ts:347` 的分支名相等检查只在非 worktree 路径生效,我在
   worktree 里会跳过;真闸是 349 行 `probe.headRefOid === serverHead`,拿我的 tip 去
   `complete --pr 1022` 会撞 `land_head_pr_not_at_tip`)⇒ C 是唯一天然对齐的。
   验收第 ② 条「PR #1022 合入」需改成新 PR 号。
2. 落 §2 的修法 + §3 的措辞收紧,commit。
3. 出一页 founder-facing 互动 HTML:并排「改前 / 改后」措辞 + §2 那处冲突的说明,
   每段带批注框 + 一键汇总复制。
4. `publish-report --publish-only`,拿 hosted URL 开 `founder_review`。
5. 她过了 → `complete --route needs_review --pr <N>`。她打回 → 改措辞、重发、开新一轮。

## 6. 风险

- **最大风险:又一次把她的理由硬化成规则。** 对策:每条硬约束都必须能指回她的原话;凡是
  我自己推导出来的,写成"默认 + 可破例",并说明为什么。
- 次要风险:PR #1022 和本分支双开,同文件冲突。对策:等 Lead 裁决,默认复用 #1022。

---

# 附录 A — Lead 框定的三处 × 改成什么字(逐条)

> 加于 2026-09-07,收到 `[lead-instruction 957780ff]` 之后。
> **时序如实交代:这条指令送达时,前面 §1-§6 的改动已经落到 `.flywheel/agents/nodes/product_design.md`
> 并开了 PR #1117、开了 founder_review 轮次(`339d1f73`,绑 commit 39b0035)。**
> (归属更正 —— Lead 事后认下了这笔账:框定说「先出 plan 再动文件」,其后的裁决说
> 「push、开新 PR、complete」,**是后一条覆盖了前一条**。按最新指令执行是对的,
> 这不是 Runner 的违规。原文此处曾写成我方违规,记错了帐,已改成事实描述。)
> 下面把已落地的部分和**还欠的部分**分开列,
> 欠的那部分**不动文件**,等 Lead 过目 —— 现在动文件会让那一轮的 artifact 失效,要重开一轮。

## 先跑 Lead 的自查句

> 「一个体只读你改后的规范、不读这条消息,它还有没有可能理直气壮地交一张跟真产品无关的托管 HTML?」

**答案:能。还有两个口子。诚实说,现版没改够。**

| 口子 | 为什么还漏 |
|---|---|
| **Step 0 只说了「(a) 不是逃生门」,没说「(a) 什么时候是错的」** | 现版写的是「这不是二选一菜单,(a) 是 (b) 的必经第一步」。一个体完全可以读成:那我做完 (a) 这一步,交 (a) 的产物,流程上没毛病。**缺一句硬话:一旦答案是 (b),独立托管静态页在任何阶段都不构成合法终态交付。** |
| **我新加的「信封」一节反而给了新借口** | 为了解开 ⛔ 与 founder_review 的死锁,我写了「Type (b) 也要发一张托管卡」。一个偷懒的体可以:发一张漂亮的卡、里面塞一个死的/根本没跑过的 localhost 链接,声称合规。我写了「服务死了这轮不算交付」,但那是散文,**没有一句把「信封不能给假货洗白」点名**。 |

⇒ 这两条必须补。是我自己引入的第二个口子,记在这里。

## ① Step 0(第 49-61 行)—— 缺「什么时候 (a) 是错的」

**已落地:** 把开场问句收成一句「does this land on the real product, or not?」,
并加了「这不是二选一菜单,(a) 是 (b) 的必经第一步」。

**还欠(建议加在两个 bullet 正下方,原样这几句):**

> **When (a) is WRONG — say it out loud, this is the whole point of the gate.** If the
> answer is **(b)**, a standalone hosted static page is **not a legal final deliverable
> at any stage of this issue**. It is legal only as the Step 2 *option card*, and only
> to pick a direction; the moment a direction is chosen it can no longer discharge the
> issue. Handing one over as the answer to a (b) issue is a **failed** delivery, not a
> partial one — that page is precisely what the founder rejected on 2026-08-27 and
> again on 2026-09-01.
>
> **Type (a) is the correct *final* form only when the founder has confirmed this is
> pure exploration that will NOT land on the product.** If you did not get that
> confirmation, you are on the (b) path.

理由:Lead 的判据原话 ——「『静态托管页』只在纯探索方向、且明确不落产品时才合法,
要把这个前提写进规范,而不是让它当默认选项之一。」上面第二段就是这句的直译。

## ② Step 4(原第 109 行)—— Type (b) 从没要求是真代码

**已落地(继承自 #1022 + 本轮加固):** 「a note on where it lands」这个措辞已整条删除,
换成「write it in real code (JS/TS) and serve it at localhost」+ 一节 Type (b) 契约
(从现有代码改起 = 强默认可破例 / 假数据可以 / 服务归 runner 养)+ 一节
`What the Type (b) review round binds`(commit / 信封 / localhost 三样点名)。

**还欠(建议作为 Type (b) 契约的第 0 条,放在现有 1. 之前):**

> 0. **A note saying where it lands does not constitute delivery.** The old spec asked
>    for "a mockup + a note on where it lands in the real app" — and that is exactly
>    what produced the rejected artifacts: *prose about* the real product handed over
>    *instead of* the real product. If what you are about to hand over is a page plus a
>    description of where it would go, you have not delivered.

**还欠(补在「信封」那一节末尾,堵我自己开的口子):**

> **The envelope does not launder a fake.** Publishing a card does not turn a
> standalone page into a Type (b) delivery. If the localhost URL inside that card is
> dead, was never actually run, or points at something rebuilt from scratch with no
> relationship to the product's own code, **the round is a failed delivery** — the card
> only changed how the fake was packaged. Before you open the round: open that URL
> yourself, in a browser, and confirm it is the thing you are claiming it is.

## ③ 技能表(原第 151 行)—— publish-report 无限定

**已落地:** 原来那一行拆成两行 ——
「Hosting the **option-stage** card (concept images → Option 1/2/3)」
和「Hosting the Type (b) **review envelope** (localhost URL + screenshots + comment
boxes) — ⛔ never as the deliverable itself」。

**还欠:** 无。这一处我认为已经够了。

## 我需要 Lead 拍的一件事

上面「还欠」的三段字,**现在改还是等**?

- 现在改 ⇒ 必须重新 publish + 开**新一轮** founder_review(现在那一轮绑的是 commit 39b0035,
  文件一动就不是她看的那版了)。她还没看过第一轮。
- 等 ⇒ 她先看现版,回来的意见和这三段一起进第二版,只开两轮。

**我倾向前者(现在就改)**:这三段补的是 Lead 自查句真正的漏点,让她看一个我自己都知道
还漏两个口子的版本,是浪费她一轮。**但轮次已经开出去了,撤不撤是 Lead 的判断,不是我的。**

---

# 附录 B — 第二遍全文扫描:同型矛盾(Lead 指派)

> 加于 2026-09-07,应 `[lead-instruction]` 第 5 条。
> **结论:有,两处。** 第一处会把这单要堵的洞原样重新打开。

## 用的方法(上一次「已扫」为什么假)

上一次的扫描是**读措辞找语义打架**,所以只能看见散文层面的不一致。真正扫出问题的方法是:

> 把文件里**每一条禁令**列出来 → 问「它禁掉的东西,是不是规范自己要求的下一步**唯一可行的手段**」
> → **去读机器那一侧的代码验证**,不看规范怎么说。

上一次漏掉 ⛔ 与 founder_review 对撞,就是因为没做最后一步(没去读 `founder-review.ts` 的校验)。
本轮 22 条禁令逐条过了一遍,下面两处成立。

## 🔴 发现一(严重)—— 「不许写 production code」+「文档只放 doc 目录」= 只剩「独立仿制页」这一条路

三条规则,单看每条都对,合起来把 Type (b) 的正路堵死:

| 行 | 规则 |
|---|---|
| 第 285 行 CRITICAL rules | **「No production code」——无条件,无限定** |
| 第 133 行 Type (b) 契约 | 界面已存在时**从现有代码改起**(强默认,founder 亲口给的理由:省事) |
| 第 289-290 行 Docs & branch | 设计产物 → `<dept>/doc/<ISSUE>-<slug>/` |

⇒ 「从现有代码改起」必然产生 `packages/...` 的 diff。而机器那一侧是这么判的:

```
packages/teamlead/src/bridge/ship-relevant-diff.ts:10-15
  DOCS_PREFIXES = ["doc/", "engineering/doc/", "product/doc/",
                   "content/doc/", "marketing/doc/"]
:144  return DOCS_PREFIXES.some((prefix) => path.startsWith(prefix))
```

碰 `packages/` ⇒ 不是 docs-only ⇒ ship-relevant ⇒ 进 review hold。

**于是一个体同时面对:强默认让它改产品源码 / CRITICAL 说不许写 production code /
文档规则说产物放 doc 目录。三条同时满足的动作只有一个 ——
在 `product/doc/...` 下手搭一个独立仿制页。**

**这就是这张单存在的理由本身。**founder 8-27、9-1 两次退回的就是它。
我们从 Step 4 把它赶出去,它从 CRITICAL rules 那扇门原样走了回来。

### 为什么第 233-236 行那条豁免救不了

第 235-236 行确实写了「Do not let the 'no production code' rule fight an Implement/QA phase
you were explicitly put in」—— 但它只覆盖 **DAG 的 Implement/QA 阶段**。
Type (b) 的高保真是在 **Design 阶段**做的,而第 231 行对 Design 阶段的表述恰恰是
「In the Design / mockup workflow, you do **NOT** write production code」。
⇒ 豁免管不到本单这条路径。**漏得干干净净。**

### 建议改成什么字

CRITICAL rules 第 285 行那颗子弹拆开,并在 Docs & branch 补一句落点:

> - **No production code — 但这条禁的是「production」,不是「code」。** Type (b) 的高保真
>   *要求*你写真代码、并且默认直接改产品现有的源文件(Step 4)。那不算违反这条。
>   这条禁的是它后面那半截:生产接线、真数据、测试、发布 PR —— 那些是 engineer 的。
>   **如果你正因为这条而准备去手搭一个独立仿制页,你读反了**:那正是 founder
>   2026-08-27 / 2026-09-01 两次退回的东西。

> Docs & branch 补:**Type (b) 的高保真改动落在它本来该在的地方 —— 产品源码里**,不是
> doc 文件夹。这会让 PR 变成 ship-relevant(`ship-relevant-diff.ts` 的 DOCS_PREFIXES
> 不含 `packages/`)从而进 review hold,**这是正确的、预期之内的**,不是需要绕开的东西。
> 一页 spec 仍然放 doc 文件夹。

## 🟡 发现二(中等)—— 规范要求一个 runner 生命周期内做不到的状态

第 161-163 行:

> **Give the founder the localhost URL** and keep the server alive. If it dies,
> restart it — that is your job, not hers.

但 `founder_review` 的超时是 **48 小时**,而 runner session 结束时 localhost 服务随之死掉。
⇒ 她在 session 结束之后点那个链接,**必然打不开**,而规范把「养活服务」写成了 runner 的责任。
一个体照字面执行,唯一能同时满足「服务要活着」和「轮次要开出去」的做法,
是**别开轮次、一直挂着不 complete**——或者反过来,发一张卡了事,回到发现一那个洞。

这一处我**没有**现成解法,所以不自作主张写字进规范。三条路各有代价,需要 Lead / founder 定:
- (i) 明写「她要看时喊一声,runner/Lead 重新起服务」—— 诚实,但把成本推给她。
- (ii) Type (b) 卡里同时放 `proofshot` 录屏/前后截图作为**服务死掉时的兜底**,并明说
  「这是兜底,不是交付物」—— 我倾向这个,但它离「用信封给假货洗白」只有一步,措辞要很小心。
- (iii) 认下这是平台缺口,单独开一张单(常驻预览服务),规范里先写实话:
  「服务只在本 session 内活着」。

## 扫过且判定为**不**成立的(免得你以为我只挑了两条)

| 候选 | 判定 |
|---|---|
| 第 158 行 ⛔ 托管页 vs 第 122 行 Type (a) 要托管 | 不成立 —— ⛔ 已限定 Type (b) |
| 第 116 行「founder 没过不许 complete Design」 | 不成立 —— 这是设计意图,不是死锁 |
| 第 292-293 行「不许 push main / 不许自 merge」vs 节点合同要求开 PR | 不成立 —— 开 PR ≠ merge |
| 第 101-102 行「不许自己往 Discord 发 / Lead 答复不算数」 | 不成立 —— Bridge 那条路是通的 |
| 第 113 行「不许硬逼她选一个」 | 不成立 —— 有明确的再来一轮出口 |
| 第 176 行「别试着绑 localhost」 | 不成立 —— 这条正是本轮加的,已给出替代路径 |
