# FLY-2309 拆出的 build issue —— 可直接开单的规格

Issue: FLY-2309 (https://linear.app/geoforge3d/issue/FLY-2309/co-create落地-自动合并怎么落地-影子跑怎么跑规矩改哪几条拆成-build-issue)
日期: 2026-09-03
基于: prd.md §8 · research.md

---

## 开单说明(给开单人 / Honey Lemon)

| 项 | 值 |
| -- | -- |
| team | `FLY` |
| project | `Flywheel` |
| label | `Flywheel` |
| 路由 | Tadashi(Engineering Lead)的队列 |
| 依赖 | `B1 ∥ B2 ∥ B3 → B4 →(两周后)→ B5` |

⏸ **开单时机(Lead 已定,本 runner 遵办)**:**founder 看过并认了 PRD 之后再开。**
在她 review 之前开出 5 张工程单,等于把一个她可能要改的方案先钉进别人的队列。
⇒ 本 runner **一张都没有开**(本会话 Linear MCP `AUTH_HEADER_REJECTED` / HTTP 401,且 Lead 已明令暂停)。
Linear 上目前**零新单**,不需要撤。

⛔ **五张单都不改 `founder-only-authority` / merge 授权契约。** founder 至今**没有**批准自动合并上线。

📌 下面每张单的「Why now」里的数,全部取自 `~/.flywheel/teamlead.db` 的**只读副本**
(2026-09-03T23:0x 拷到 scratchpad 再查,未碰生产库)。复现 SQL 见每张单末尾。

⚠️ **这些是时点数,活表会继续涨**(实例:`workflow_node_pr_binding` 我看时 364 行,
Lead 三十分钟后复核是 366 行)。复现时**绝对条数对不上是正常的**;
要核的是**比例与方向**(「全是 `__main__`」「8/33 vs 3/212」「359 中 259 是主仓」这一类),
不是某一个整数。照抄 SQL 重跑时请一并报出你自己的全集规模。

---

## B1 —— docs-only 判定必须覆盖这一单的全部仓 【P0 · 影子跑前置】

**标题**
`FLY-XXXX: docs-only 判定覆盖全部 target repo —— 今天只看主仓,实测漏 8/33,且已在放行 QA 证据门`

### Why now(两条,第二条比第一条重)

**① 分类器只看主仓。**
`ship_relevant_diff_snapshot` 至今 260 条里 **259 条是 `xrliAnnie/flywheel`**(另 1 条 `belle-workspace`)。
nested target repo 的 PR **从未被分类过**。
结构性原因(不是漏配):`bridge/plugin.ts:4773-4803` 的 `ensureShipRelevantDiff` 是按
**session 的单个 PR** 驱动的 —— `session.pr_head_sha` / `session.pr_number` / `project.projectRepo`。
一个 session 只有一个主仓 PR;`complete --target-repo` 产生的 nested PR 在这里**没有入口**。

实测:被判 docs-only 的 **33** 个 run 里 **8 个(24%)**其实在 nested repo(`xrliannie/raya` 等)
有过真代码 PR 并通过了 Codex 评审。
对照组:被判 ship-relevant 的 212 个 run 里只有 **3** 个带 nested
⇒ 这个形状**恰好扎在 docs-only 这一类**(主仓只放文档锚点、代码进子仓,是这类单的常见长相)。

**② ~~这个洞今天已经在生效~~ 🔴 该断言已撤回(2026-09-03,我自己复核推翻)**

我一度写过:那 8 个单的 docs-only 头在 `auto_qa_record` 里零行 ⇒ 会落到
`review-hold.ts:176` 的 `ship_relevant === 0 → return null`(免掉 QA 证据要求)⇒ 洞已在生效。
**这是错的。** `review-hold.ts:153` 在那一支之前还有 `if (!mainRole) return null;`
(FLY-793:非 main 角色把验证委托给阶段流水线),而那 8 个 run 的 docs-only 快照
**全部挂在 `session_role='qa'` 的会话上,main-role 快照数为 0**
⇒ 它们在更早一行就退出了,**从未走到 docs-only 那一支**。详见 research.md §2b。

⇒ **B1 的必要性与优先级不变**:它是关于**未来自动道**的前置
(照今天的分类器开自动道,会放行它没看过的代码),**不是**一条现行的证据门缺口。

📌 一条**待核项,不是结论**:全体 docs-only 快照里有 **23 条挂在 `main` 角色会话上**。
这些**可能**走到那一支,但「是否同时带 nested 代码 / 当时是否 `awaiting_review` /
快照是否在 60 秒时效窗内(`SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS = 60_000`)」**一条都没核**。
实现 B1 时若要引用它,**必须先核**。

### Scope

1. **判定改为全仓**:docs-only 的充要条件 = 该单**全部** PR(主仓 + 每个 nested target repo)的
   改动文件都落在现有 6 个文档前缀下,且**合计** ≤ `MAX_DOCS_ONLY_FILES`(今天 50)。
   - 前缀常量:`bridge/ship-relevant-diff.ts:8-16`(`DOCS_PREFIXES` / `MAX_DOCS_ONLY_FILES`)
2. **fail-closed**:任一 PR 拿不到分类快照 ⇒ 整单判 `unknown` ⇒ **不算 docs-only**。
   与该文件头部既有语义一致(`missing row is authorization-unknown and therefore founder-held`)。
3. **classifier version 递增**(`SHIP_RELEVANT_CLASSIFIER_VERSION`,今天 = 1)。
   `review-hold.ts:161-165` 会因 version 不匹配直接判 `qa_evidence_missing` —— 这是**期望行为**:
   旧快照自动失效,不许就地改写历史行。
4. **入口**:`bridge/plugin.ts` 的 `ensureShipRelevantDiff` 要能拿到这一单的**全部** PR,
   不再只吃 `session.pr_head_sha` / `session.pr_number` 一对。
5. **登记 retention**:新表/新列**必须**进 `scripts/lib/fly-2006-retention-registry.mjs`,
   否则 `assertNoUnclassifiedSchema` 直接抛 `schema_unclassified` —— **建表就打红**。
   归入 `protectedCurrentOrReference`(现有 `ship_relevant_diff_snapshot` 就在这一组);
   **不要**放 `deleteTarget` —— 那一组 `RETENTION_MS = 14 天`,正好会吃掉影子跑的窗口。

### 🔴 未决项:权威的 target repo 清单从哪来(已查到底,附两个方案)

本 PRD 的 8/33 是从 `codex_review_record.target_repo_identity` **反推**的;
**反推不能当判定依据**(它只在「恰好过了 Codex 评审」时才有行)。所以要一个权威来源。

**查完的结论:家已经建好了,只是从来没被写进去。**

| 台账 | 定义位置 | 库里实况 |
| ---- | -------- | -------- |
| `workflow_node_pr_binding` | `StateStore.ts:20243` | **`target_repo_identity` 全是 `__main__`**(我看时 364 行,Lead 复核时 366 行 —— 行数会漂,**「全是 `__main__`」这个比例不漂**) |
| `workflow_pr_manifest` | `StateStore.ts:20261`(`expected_count BETWEEN 1 AND 50`) | **0 行** |
| `workflow_declared_pr` | `StateStore.ts` | **0 行** |
| `workflow_ship_target_binding` | — | 335 行,全 `__main__` |
| `codex_review_record` | — | **68 行非 `__main__`**(`xrliannie/raya` 60 等) |

三条关键事实:

1. **schema 早就支持 nested**:`workflow_node_pr_binding` 有
   `target_repo_identity` / `probe_repo_slug` / `target_repo_path` 三列,
   写入 API(`StateStore.ts:43560` 起)把 `targetRepoIdentity` 当**必填**校验。
   ⇒ 不是「没地方放」,是**从来没有 nested 的行被写进去**。
2. **一节点只能绑一个 PR**:`workflow_node_pr_binding` 主键 `(run_id, node_id, attempt)`
   ⇒ 一个节点尝试**结构上只能声明一个 PR**,主仓文档 PR 与 nested 代码 PR **放不下两个**。
   实测那三个 raya 单的绑定只有主仓那一个:

   ```
   3f9f9f1c  qa/2  PR 1006  __main__  /Users/xiaorongli/Dev/flywheel-FLY-2178
   5ae599c6  qa/3  PR  960  __main__  /Users/xiaorongli/Dev/flywheel-FLY-2029
   c8f001a6  qa/1  PR 1009  __main__  /Users/xiaorongli/Dev/flywheel-FLY-2205
   ```
3. **多 PR 声明路径已建但从未启用**:`workflow_pr_manifest` + `workflow_declared_pr`
   天生按 `(repo_identity, pr_number)` 分键 —— 正是「一单多仓多 PR」的形状,
   路由也在(`bridge/runs-route.ts:778` 开 manifest、`:817` 从绑定 seal、`:878` 列出)。
   ⚠️ 但 `sealWorkflowPrManifestFromBindings` 是**从 `workflow_node_pr_binding` 铸的**
   (`StateStore.ts:43103` 按 `target_repo_identity\0pr_number` 去重)
   ⇒ **绑定层全是 `__main__`,manifest 即使启用也只会是主仓。根在绑定层,不在 manifest 层。**

### 两个方案(建议 B,但由 Tadashi 拍)

| | 方案 | 代价 |
| - | ---- | ---- |
| **A** | 让 `complete --target-repo` 把 nested PR 也落进 `workflow_node_pr_binding` | ⛔ 撞主键 `(run_id,node_id,attempt)` —— 要**改主键或加一张从表**,动的是授权层台账 |
| **B**(建议) | 启用已建未用的多 PR 声明路径:节点声明**全部** PR 进 manifest / `workflow_declared_pr`,分类器改成读 manifest 里的全部已声明 PR | 机制已存在、键形状天生对;但仍需**先让 nested PR 进得了绑定层**(见上 §3),所以 A 的主键问题**绕不过去,只是换个位置解** |

🔴 **我没有查出来的(不许在实现中当成已解决)**:
- **为什么 manifest / declared_pr 从未被使用** —— 是没接、被 flag 关着、还是被别的机制取代,我没查到。
  我只查了它们零行、路由存在、seal 源是绑定层。**开工前必须先回答这个**,否则可能是在启用一条已被废弃的路径。
- **绑定层主键能不能安全扩展** —— `workflow_node_pr_binding` 有
  `workflowRunAcceptsAuthorityMutation` / `assertCurrentWorkflowWriterTx` 两道授权护栏,
  改主键的影响面我没有评估。

### 验收(硬)

- **阳性对照**:回溯重跑那 33 个 run,**8 个带 nested 代码的必须全部翻成非 docs-only**。
- **反向对照(防空过绿测)**:另外 **22 个不带 nested 的必须仍然判 docs-only**。
  不许靠「一刀切全判 unknown」来达标 —— 那会让阳性对照变成零判别力。
- `review-hold.ts` 的行为回归:同一个 session,主仓 docs-only + 有 nested 代码 ⇒ **必须 hold**
  (今天返回 `null`)。
- 新表/新列已在 retention registry 中,`assertClassifiedSchema` 通过。

### 复现 SQL(拿 teamlead.db 只读副本跑)

```sql
with runexec as (select distinct run_id, execution_id from workflow_run_node where execution_id is not null),
runship as (select r.run_id, max(s.ship_relevant) max_sr from runexec r
            join ship_relevant_diff_snapshot s on s.execution_id=r.execution_id group by r.run_id),
nested as (select distinct re.run_id from runexec re
           join codex_review_record c on c.execution_id=re.execution_id
           where c.target_repo_identity <> '__main__')
select (select count(*) from runship where max_sr=0) docs_only_runs,
       (select count(*) from runship rs join nested n on n.run_id=rs.run_id where rs.max_sr=0) docs_only_with_nested,
       (select count(*) from runship where max_sr=1) code_runs,
       (select count(*) from runship rs join nested n on n.run_id=rs.run_id where rs.max_sr=1) code_with_nested;
-- 期望(2026-09-03 副本): 33 / 8 / 212 / 3
```

---

## B2 —— founder 门的判决绑 exact head,并把「她本人」与「以 founder 权限提交」分开 【P0 · 影子跑前置】

**标题**
`FLY-XXXX: founder 门判决绑 exact head + 新增「是否 founder 本人」字段(authority 是权限不是作者)`

### Why now

**① 绑不上 head。**
`founder_gate` 是门节点,`workflow_run_node.execution_id` **恒 NULL —— 实测 358/358**。
55 条 `authority='founder' AND source_node_id='founder_gate'` 的返工,按
`(run_id, node_id, attempt)` join 到 execution 的有 **0 条**。
今天只能用 run 级松 join 近似(覆盖 42/47),而影子跑要的是**精确到她当时看的那个 head**。
- 表定义:`StateStore.ts:21306`(`workflow_rework_request`,键 `run_id`)、
  `StateStore.ts:20217`(`workflow_run_node`)、`StateStore.ts:4272`(snapshot,键 `execution_id`)

**② 🔴 `authority` 是权限,不是作者。**
FLY-2261 已实测:47 条 `authority='founder'` 里只有 **21** 条是她的判断。
本单再次撞上同一个坑 —— 5 条 docs-only 打回里只有 **2** 条是她本人:

| run | 内容 | 是不是她 |
| --- | ---- | -------- |
| `c8f001a6` | 「只要加了 feature flag,默认就要打开」→「写死+删旋钮」(thread 原话) | ✅ 是 |
| `3f9f9f1c` | 「我实际去测的时候,它根本就没有停…」(实测打回) | ✅ 是 |
| `5ae599c6` | `[提交人=flywheel-eng-lead]`,引她 2074 原话精神 | ⚠️ Lead 提交 |
| `54f0d683` | 「QA 撤回 PASS 效力后的 Lead 打回」 | ❌ 不是 |
| `f5bd6f2b` | 「HEAD-FOLD RECOVERY(非新工作)…零新改动」 | ❌ 机械返工 |

⇒ **只按 `authority` 统计一定高估**,而两周表的 N1 正好要的是「她本人」那一格。

### Scope

1. 每一条 founder 门的过卡 / 打回,可查到它当时绑的 `(repo, pr_number, head_sha)`。
2. **新增一个与 `authority` 分离的字段**表达「这条是不是 founder 本人写的」。
   ⛔ **不许**用文本前缀 / 正则去猜 `founder_feedback_verbatim`
   —— 那等于把「谁写的」这件事重新变成一个判断,正好违反资格门槛。

### 验收(硬)

- 新数据 **100%** 可绑到 exact head。
- 回溯 55 条**报出**可绑比例(不要求 100%,要求**报出来**,并同时报全集规模 ——
  「55 条里 N 条」才是结论,单独一个 N 不是)。
- **阳性对照**:上表 5 条真实样本必须被正确分开 ——
  `c8f001a6` / `3f9f9f1c` 判**是她本人**;`5ae599c6` / `54f0d683` / `f5bd6f2b` 判**不是**。

### 复现 SQL

```sql
select sum(execution_id is null) null_cnt, count(*) total
  from workflow_run_node where node_id='founder_gate';           -- 期望 358 / 358
select count(*) from workflow_rework_request r
  left join workflow_run_node n
    on n.run_id=r.run_id and n.node_id=r.source_node_id and n.attempt=r.source_attempt
 where r.authority='founder' and r.source_node_id='founder_gate'
   and n.execution_id is not null;                               -- 期望 0
```

---

## B3 —— 强度二证据台账 【P0 · 影子跑前置】

**标题**
`FLY-XXXX: 强度二证据台账 —— 真环境跑过 + 外部可查可重跑的记录(两个独立字段)`

### Why now

查遍现有台账,**没有任何一个字段表示「这是在真环境跑的」,也没有「记录在哪、怎么重跑」**:

| 表 | 有什么 | 缺什么 |
| -- | ------ | ------ |
| `auto_qa_record` | `status` / `verdict_event_id` / `qa_issue_url` / 起止时间 | 「真环境」「记录地址」「怎么重跑」全无 |
| `codex_review_record` | 评审结论(绑 exact head) | 评审 ≠ 跑过 |
| `ship_relevant_diff_snapshot` | 改动类别 | 与跑没跑过无关 |

⇒ **闸② 今天是一句话,不是一道闸。** 没有台账 ⇒ 判不了 ⇒ 也就自动不了。

### Scope

一条记录至少含:绑的 head、在哪跑的(529 房 / 其它)、跑的是哪条链路、
**外部可查的记录地址**、**怎么重跑**。

🔴 **两半必须是两个独立字段**:(a) 真跑过 (b) 有外部可查可重跑的记录。
founder 第一次读只读到 (a);**少了 (b),强度二退化成强度一,而强度一对那 8 条
「说做完了但没真跑过」一条都拦不住。**

fail-closed:**没有台账行 = 不满足强度二。只认台账,不认自称。**

登记 retention registry(同 B1,归 `protectedCurrentOrReference`)。

### 验收(硬)

- **阳性对照 1**:一条「自称跑过但没有台账记录」的样本 ⇒ 判**不满足**。
- **阳性对照 2**:一条「有台账行但记录地址取不到」的样本 ⇒ 判**不满足**。
  少了这条,(b) 会退化成「填了个字符串就算」。
- 两半分别被单独测到(不许一个布尔盖两件事)。

### 已知不解(照旧明写,不许在实现中悄悄声称覆盖)

强度二**挡不住** FLY-1833 那种 flaky —— 一个 flaky 的端到端测试照样会偶然全绿。
本单没有新解法。**验收文档里要保留这条缺口的说明。**

---

## B4 —— 影子跑记录线 + 两周表 【P1 · 依赖 B1/B2/B3】

**标题**
`FLY-XXXX: 自动合并影子跑(两周)—— 四条记录线 + 错判率表,一次都不真的自动合并`

### Scope

1. 每一单同时落四条记录(prd.md §4.2):
   ① 机器判的类 ② 人判的类 ③ 强度二两半 ④ 她有没有打回(且是不是她本人)
2. **一次都不真的自动合并。**
3. 唯一新增的人类动作:Lead 在 ship 卡上声明「这单属于哪一类」——
   **枚举字段,不是自由文本**(自由文本两周后没法统计)。
4. 两周后产出 prd.md §5.1 的 **N1 / N2 / N3**,外加**三个分母卫生指标**:
   四条记录线各自覆盖率、「未声明类别」条数、「绑定失败」条数。

**计时起点**:**B1 落地那天**起算两周(不是本 PR 合并那天)。理由见 prd.md §2 / §5.3。
⚠️ 这一条 founder 尚未确认(PRD 第 05 格 Q1),**以她的答复为准**。

### 验收(硬)

- 四条记录线覆盖率 **100%**(缺一条这张表不作数)。
- 表可被**独立重算**:交一份只读 SQL,任何人拿库副本能复现同样的 N1/N2/N3。
- founder 的动作变化量 = **0**。
- 🔴 报 0 时**必须同时报全集规模**(「30 个里 0 条」才是结论,单独一个「0」不是)。
  一张「错判率 = 0」的表和一张「什么都没记上」的表长得一模一样。

---

## B5 —— 放手那天要改的规矩清单 【P2 · 文档单 · 依赖 B4 结果】

**标题**
`FLY-XXXX: 自动合并放手前要改的三条规矩(提案,交 founder 拍)`

### Scope

把 prd.md §6.2 的 M1 / M2 / M3 写成可执行提案:

- **M1** `founder-only-authority` R1 增开窄口:同时过三道闸的单可不经她过卡直接合并。
- **M2** 走了自动道的单,事后要有她**看得见、能一键 revert** 的入口。
- **M3** 「她在卡上加新要求」这个入口关掉后的事后补位(FLY-2261 T4,未定案)。

⛔ **B5 本身不修改任何契约文件。** 改 `founder-only-authority` 只有 founder 本人能做。

---

## 附:五张单共同的「定义完成」检查

- [ ] 每张单链回它实现的 PRD 段落(`prd.md` §编号)
- [ ] 阳性对照与反向对照**都**存在(只有阳性对照会空过绿测)
- [ ] 新表/新列已进 retention registry 且归对组
- [ ] 未决项没有被静默解决 —— B1 的「target repo 清单从哪来」若仍未定,不许开工
- [ ] 引用 FLY-2261 那个 **2/7 分法**的地方都带「**founder 未逐字确认**」标注
