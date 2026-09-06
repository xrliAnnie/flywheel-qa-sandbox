# FLY-2309 自动合并怎么落地 — 调研

Issue: FLY-2309 (https://linear.app/geoforge3d/issue/FLY-2309/co-create落地-自动合并怎么落地-影子跑怎么跑规矩改哪几条拆成-build-issue)
日期: 2026-09-03
基于: exploration.md · FLY-2261/process-log.md

**数据源**:`~/.flywheel/teamlead.db` 于 2026-09-03T23:0x 的只读副本(拷到 scratchpad 再查,不碰生产库)。

---

## 0. 一句话结论

> **不用等两周 —— 回溯数据现在就能算一次纯文档类错判率,而且它不是 0。**
> **5 / 30 的「纯文档」单在 founder 门上被以 founder 权限打回。**
> 但这 5 条里有 4 条被**同一个机制**解释干净:**主仓 PR 确实纯文档,真代码在 nested target repo 里,
> 而分类器只看主仓。** 补上这个洞之后,回溯口径下她本人的错判数落到 **0**。

⇒ 落地顺序因此要动一处:**影子跑之前先补这个洞**,否则影子跑测的是一个已知有洞的分类器,
两周后那张表一定是错的。

---

## 1. 先解决 2261 留下的地基问题:两张表怎么对上

2261 research.md §6.2 明写:「我没有把 `ship_relevant_diff_snapshot` 与那 21 条逐条对上
(两边的 key 不同,execution_id vs run_id)。这是拆单时要补的一次实证。」**本单补上了。**

### 1.1 naive join 是死的(实测,不是推测)

`workflow_rework_request` 的键是 `(run_id, source_node_id, source_attempt)`;
`ship_relevant_diff_snapshot` 的键是 `(execution_id, pr_head_sha)`。
中间表 `workflow_run_node(run_id, node_id, attempt) → execution_id` 看起来正好接上。**接不上:**

```
founder_gate 节点的 execution_id:  NULL 358 / 非 NULL 0 / 共 358
55 条 founder_gate 返工按这条路 join 到 execution_id 的:  0 条
```

`founder_gate` 是一个**没有 runner 的门节点**,它的 `execution_id` 恒为 NULL。
(与记忆库 `founder_gate 节点 execution_id 恒 NULL` 一致 —— 本单在本表上重新实测确认。)

### 1.2 可用的 join 路径(覆盖率 42/47)

改成 **run 级**:`rework.run_id` → 同一 run 里**任意一个非 NULL 的 `execution_id`** → snapshot。

| 量 | 值 |
| -- | -- |
| 有 founder 门返工的 run | 47 |
| 其中能拿到任一 execution_id | 47(100%) |
| 其中能拿到 snapshot | **42(89%)** |

⚠️ **这是一条松 join**:它回答的是「这个 run 里被分类过的 PR 是什么类」,
不是「她当时看的那张卡绑的那个 head 是什么类」。下面所有从它出来的数,我都**逐条打开
verbatim / PR 文件清单人工核过**(§2),不是拿 join 结果直接当结论。
**影子跑不能用这条松 join** —— 它需要的是精确绑定,那是一个 build issue(§4 B1)。

---

## 2. 回溯口径的纯文档类错判率

### 2.1 数

口径:一个 run 的**全部** snapshot 都是 `ship_relevant=0`(纯文档),且这个 run 到过 `founder_gate`。

| 量 | 值 |
| -- | -- |
| 被判纯文档的 run(全体) | 33 |
| 其中到过 founder 门 | **30** |
| 其中在 founder 门上被以 founder 权限打回 | **5** |
| 作为对照:被判 ship-relevant(代码)的 run | 212 |

**5 / 30 = 16.7%。不是 0。**

### 2.2 逐条读完那 5 条(必做 —— `authority='founder'` ≠ 她本人的判断)

2261 research.md §5b 已经把这个坑写死了:`authority` 是**权限**不是**作者**。所以我把 5 条
`founder_feedback_verbatim` 全文读完并逐条归类:

| run | 内容 | 是不是她本人 |
| --- | ---- | ------------ |
| `c8f001a6` (FLY-2205) | 「只要加了 feature flag,默认就要打开」→「写死+删旋钮」,标注 thread 原话 | ✅ **是** |
| `3f9f9f1c` (FLY-2178) | 「我实际去测的时候,它根本就没有停…打断的效果非常不好」实测打回 | ✅ **是** |
| `5ae599c6` (FLY-2029) | `[提交人=flywheel-eng-lead]`,引她 2074 原话精神,launchd 重启不自启 | ⚠️ Lead 提交 |
| `54f0d683` | 「QA 撤回 PASS 效力后的 Lead 打回」 | ❌ 不是 |
| `f5bd6f2b` | 「HEAD-FOLD RECOVERY(非新工作)…零新改动」 | ❌ 机械返工 |

⇒ **她本人:2 / 30 = 6.7%。** 这是下界,仍然**不是 0**。

### 2.3 🔴 真因:分类器只看主仓,代码在别的仓

打开 `c8f001a6` 那条:她的直令是「删掉 `rereadPolicyEnabled` 这个配置键」——**纯代码要求**。
可它绑的主仓 PR #1009 呢?

```
PR 1009  "FLY-2205: anchor Raya no-full-reread implementation"   13 files, 全部在 engineering/doc/ 下
```

分类器判 `ship_relevant=0` —— **判得完全正确**,主仓 PR 就是纯文档。
真代码在哪?`codex_review_record`:

```
target_repo_identity   条数
__main__               1324
xrliannie/raya           60      ← FLY-2205 / FLY-2178 / FLY-2029 的代码 PR 都在这里,且都过了 Codex 评审
xrliannie/flywheel        4
xrliannie/claude-plugins-official  4
```

而 `ship_relevant_diff_snapshot` 的 repo 分布:

```
xrliAnnie/flywheel        259
xrliAnnie/belle-workspace   1
```

**260 条里 259 条是主仓。nested target repo 的 PR,分类器从来没有分类过。**

### 2.4 这个机制解释掉了几乎全部错判

| 被判纯文档的 run | 打回 | 同一单在 nested repo 有过代码 PR |
| --- | --- | --- |
| `3f9f9f1c` | ✅ | ✅ |
| `54f0d683` | ✅ | ✅ |
| `5ae599c6` | ✅ | ✅ |
| `c8f001a6` | ✅ | ✅ |
| `f5bd6f2b` | ✅ | ❌(机械 head-fold,非她判断) |
| 另 4 个 | ❌ | ✅ |

**5 条打回里 4 条带 nested 代码;唯一不带的那条是机械返工,不是她的判断。**

规模:**被判纯文档的 33 个 run 里,8 个(24%)其实在 nested repo 里有过真代码 PR。**
对照组:被判代码的 212 个 run 里只有 3 个带 nested —— 说明这不是「到处都有」的噪音,
而是**恰好集中在纯文档这一类**里(主仓只放文档锚点、代码进子仓,是这类单的常见形状)。

### 2.5 补完洞之后的回溯数

如果「纯文档」的判定改成**这一单的全部 PR(主仓 + 每个 nested target repo)都必须落在文档前缀下**:

- 那 8 个带 nested 代码的 run **全部**会被判出自动道 ⇒ 4 条真打回全部被拦住。
- 剩下唯一一条打回是 `f5bd6f2b` 的机械 head-fold —— 不是她的判断。
- ⇒ **回溯口径下,她本人的纯文档类错判数 = 0 / 22。**

⚠️ **这不能当成「已经达标」。** 三个原因,都写下来:
1. 回溯样本只有 30 个 run,且用的是 §1.2 那条**松 join**;
2. 「补完洞之后会是 0」是我把机制套回历史数据算出来的**反事实**,不是实际跑出来的;
3. 她定死的放手判据是**影子跑两周后那张表为 0**,不是回溯表为 0。回溯只能决定**先补哪个洞**。

---

## 2b. ~~这个洞今天已经在生效~~ 🔴 **本节已撤回(2026-09-03,由我自己复核推翻)**

> ### 我在这一节写过的结论是错的。原文保留在下面,连同推翻它的证据。

**我当时的断言**:那 8 个「主仓 docs-only + nested 有代码」的 run,
因为在 `auto_qa_record` 里零行,会落到 `review-hold.ts:176` 的
`snapshot.ship_relevant === 0 ? null : …` 那一支,从而**免掉 QA 证据要求**被放到 founder 面前
⇒「这个洞今天已经在生效」。

**推翻它的证据**:`review-hold.ts:153` 在那一支**之前**还有一行:

```ts
// FLY-793 implement owns a PR but delegates its verification to the phase
// pipeline. FLY-1251's stopgap is intentionally main-only.
if (!mainRole) return null;          // mainRole = (session.session_role ?? "main") === "main"
```

而那 8 个 run 的 docs-only 快照,**全部挂在 `session_role='qa'` 的会话上,main-role 快照数为 0**:

```
run       main_role_snaps  qa_role_snaps
0edd3ffa  0                1
1be070a2  0                1
3f9f9f1c  0                1
54f0d683  0                1
5ae599c6  0                2
9788cc4d  0                1
c0ba3d95  0                1
c8f001a6  0                1
```

⇒ 它们在 `!mainRole` 那一行就 `return null` 了,**从来没有走到 docs-only 那一支**。
不 hold 的结果一样,但**原因完全不同** —— 是 FLY-793 那条「非 main 角色把验证委托给阶段流水线」的
既有豁免,**与 docs-only 分类无关**。

**我错在哪(判据,比这个结论有用)**:
我在原文里自己写了「`session.status`/`isReviewableRole` 两个前置**我没有逐条核**」,
然后**照样把它当结论写了出去**。
标注不确定 ≠ 可以先用。**一个断言的前置条件没核,它就还不是断言,是待核项。**
(同族:`two-states-one-trace` —— 「不 hold」这一个结果对应两种机制,我默认读成了需要我少做一步的那种。)

### 什么**没有**被推翻(承重结论全部不受影响)

| 结论 | 状态 |
| ---- | ---- |
| 快照 260 条里 259 条是主仓,nested repo 的 PR 从未被分类 | ✅ 不受影响 |
| 被判 docs-only 的 33 个 run 里 8 个带 nested 代码;对照组 212 个里只有 3 个 | ✅ 不受影响 |
| 30 个走到 founder 门的 docs-only run 里 5 个被打回,2 条是她本人 | ✅ 不受影响 |
| 若照今天的分类器开自动道,会放行它没看过的代码 ⇒ B1 是影子跑前置 | ✅ 不受影响(这本来就是关于**未来的自动道**,不是今天的 review-hold) |

⇒ **B1 的必要性和优先级不变**,变的只是「它是不是一条**现行**的证据门缺口」——
   **不是。** 我不该把它升级成现行。

📌 顺带记下一个**没被推翻、但需要单独核**的量:全体 docs-only 快照里,
有 **23 条挂在 `main` 角色会话上**(21 completed + 2 terminated)。
这些**可能**走到 docs-only 那一支。但它们是否同时带 nested 代码、当时是否 `awaiting_review`、
快照是否在 60 秒时效窗内(`SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS = 60_000`),**我一条都没核** ——
所以这里**不写任何结论**,只留一条待核项。

---

## 3. 闸② 的证据今天没有落账的地方

强度二 = 两半:①在 529 房真跑一次 ②留下**外部可查、能被重跑**的记录。

查现有台账:

| 表 | 有什么 | 缺什么 |
| -- | ------ | ------ |
| `auto_qa_record` | `status` / `verdict_event_id` / `qa_issue_url` / 起止时间 | **没有任何字段表示「这是在真环境跑的」**,也没有「记录在哪、怎么重跑」 |
| `codex_review_record` | 评审结论(绑 exact head) | 评审 ≠ 跑过 |
| `ship_relevant_diff_snapshot` | 改动类别 | 与「跑没跑过」无关 |

⇒ **闸② 今天是一句话,不是一道闸。** 没有台账 ⇒ 没法机器判 ⇒ 也就没法自动。
这是一个必须先建的 build issue(§4 B2),而且它正是她那句
「留下外部可查、能被重跑的记录」的**唯一落点** —— 少了它,强度二退化成强度一。

---

## 4. 影子跑的原始记录:今天有 / 今天没有

| 影子跑要记的 | 今天有吗 | 缺口 |
| ------------ | -------- | ---- |
| 机器判的类 | ⚠️ 有一半 | `ship_relevant_diff_snapshot` 只覆盖主仓(§2.3) |
| 人判的类 | ❌ 没有 | 没有任何地方记「Lead 认为这单属于哪一类」 |
| 是否满足强度二两半 | ❌ 没有 | §3 |
| 她实际有没有打回 | ⚠️ 有,但绑不上 | `workflow_rework_request` 有,但 founder_gate 的 execution_id 恒 NULL,绑不到那个 head(§1.1) |

⇒ **四样里三样今天缺**。影子跑不是「打开一个开关观察两周」,它本身要先建四条记录线。
这是本单最重要的一句话,也是 build issue 拆分的依据。

---

## 5. 保质期:两周的数据会不会被清掉

`scripts/lib/fly-2006-retention-registry.mjs`:`RETENTION_MS = 14 天`,只作用于 `deleteTarget` 那一组。

- `ship_relevant_diff_snapshot` → `protectedCurrentOrReference` ✅ 不清
- `workflow_rework_request` → `protectedCurrentOrReference` ✅ 不清
- `auto_qa_record` → `protectedCurrentOrReference` ✅ 不清

⇒ **两周窗口安全。** 但新建的记录线(§4 那三条)**必须一并登记进这个 registry**,
否则 `assertNoUnclassifiedSchema` 会直接抛 `schema_unclassified` —— 建表就会打红。
(这是一条实现约束,写进 build issue 的验收里。)

---

## 6. 我不敢下的结论 / 已知不确定

1. **§1.2 的 run 级 join 是松的。** §2 的 5 条我逐条核过,但「30」这个分母没有逐条核。
   真正的数只能等 build issue B1(精确绑定)落地后由影子跑产出。
2. **nested repo 的清单从哪来,我还没查死。** 我是从 `codex_review_record.target_repo_identity`
   反推出「这单有 nested 代码」的;分类器要覆盖 nested,得有一个**权威的 target repo 列表**,
   而不是反推。这条写进 B1 的未决项,不假装已解决。
3. **flaky 仍然没解。** 2261 已对她明说:强度二挡不住 FLY-1833 那种 flaky。本单没有新解法,
   照样明写。
4. **2/7 分法未经她确认**,本单不引用它做任何承重结论。
