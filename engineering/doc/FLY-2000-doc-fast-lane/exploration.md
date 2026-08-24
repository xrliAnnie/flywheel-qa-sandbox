# FLY-2000 文档快车道(P1 增量判据) — 探索

Issue: FLY-2000 (https://linear.app/geoforge3d/issue/FLY-2000/ci省钱-文档提交走快车道纯文档提交只跑快速检查fly-1987-p1founder-立单先做识别判据可行性验证)
日期: 2026-08-23
基于: 无(上游输入为 FLY-1987 plan §P1 与 research §4.2/§4.5,engineering/doc/FLY-1987-actions-cost-audit/)

---

## 1. 这单到底要做什么(先把「快车道」拆清楚)

「纯文档提交走快车道」今天**已经存在一半**:

- **已有(FLY-1877,现行)**:一个 PR 相对 merge-base 的**全量** diff 只动文档(四个 doc 前缀 × 13 个惰性后缀)→ 跳过全部重 job。这救的是**整条 PR 都是文档**的场景(纯 docs PR)。
- **没有(本单 = FLY-1987 P1)**:一个**含代码**的 PR,在某次全量 CI 真·全绿之后,再推**只动文档的增量提交**(progress.md、QA 报告、founder HTML、doc 归档)→ 今天每一笔都重跑全量套件(约 30–60 计费分钟/次)。本单加的是这条**增量通道**:识别「自上一次真·全绿以来,只多了文档」,只跑快速检查。

省钱口径:FLY-1987 research §4.2 给的是**净省上限 ≈ $116/月**(R6 口径)。issue 文本里的「约 $135/月」是 R5 中间值,已被 R6 修正;founder 一页方案上写的也是 ≤$116。**两个数都是上限不是承诺**,真实值必然更低(§4.2 明写了两个未验证的收窄条件)。

## 2. 必须直面的历史:这个机制被删过一次

| 时间 | 事件 |
|---|---|
| 2026-08-17 | FLY-1861 (#881) 落了第一版 baseline 机制(latest green exact-PR baseline + 同 base + 祖先 + 增量惰性 diff) |
| 2026-08-18 | **Annie 直令「就把这个东西简单化」** → FLY-1877 (#883) 把 baseline 机制**整套净删除**,换成一条不看历史的 merge-base 规则 |
| 2026-08-22 | FLY-1987 调研量出增量场景的 $116/月 上限;founder 在省钱方案页**裁定「〔方案二·文档快车道〕立单」** → FLY-2000 |

**授权关系**:FLY-2000 是 founder 在看过 FLY-1987 全部数据(含 FLY-1877 简化史)之后对**这一条特性**的更新裁定,晚于并覆盖 08-18 的简化令;但简化令的**精神**仍然约束设计 —— 机制必须比 FLY-1861 v1 更简单、失败形状更清晰,且要能回答「为什么不会重蹈被删的覆辙」。

**FLY-1861 v1 为什么退化到只能跳 64 轮**(FLY-1877 plan §1 的三条理由,本设计逐条对症):

| FLY-1861 v1 的病 | 病根 | 本设计的对症 |
|---|---|---|
| 「舱队老打断自己」— cancel-in-progress 顶掉旧轮,latest **completed** run 常是 cancelled → 拒绝 | baseline 取的是「最新 completed run」这个**易碎指针** | baseline 是**持久标记**(真·全绿那一刻写下,retention 窗内一直可用;默认 90 天,实际值 N0 实读),不再看「最新一次」是什么 |
| base 漂移即拒绝,main 一动全废 | 同上,每次重找 baseline | 标记持久 + 只在增量通道生效;base 漂移仍拒绝(安全边界,见 §4),但纯 docs PR 走现行 merge-base 规则**不受影响** |
| C0/新鲜度/rerun 排序一族边界问题 | 信了 API 的**活指针**字段(run 里内嵌 PR 对象事后漂移,FLY-1987 §4.5 实测) | 标记只记**写入时刻的本地事实**(merge commit 首父、blob hash),消费端从权威 API **重验** job 结论,不信标记自述 |

## 3. 为什么必须有「持久标记」(这不是可选项)

FLY-1987 research §4.5 实测:run 里内嵌的 `pull_requests[0].head/base.sha` 是**活指针**,历史 run 上全部已变成 PR 当前值;check-suite 的 before/after 返回 null。本单研究阶段又补了一个直接证据(research.md §3.3):开着的 PR #901 的 `.base.sha` 字段与其 test-merge commit 的首父**不相等** —— PR 对象字段连「现在的被测 base」都不能可靠代表,更不用说历史的。

⇒ **「当时全绿验的是什么环境」只能在全绿那一刻自己写下来,事后从 API 拿不回来。** 这就是 issue 里「先做识别判据可行性验证」要验的核心:这个标记写得出来、读得回来、绑得住吗?(research.md 的只读探针给出**纸面可行**;最终裁定悬于实现节点的 N0 producer spike 实弹,N0 不过 = 整案放弃 —— plan §5。)

## 4. 判据草案(方向,细节在 plan.md)

```
通道一(现行,不动):merge-base 全量 diff 惰性 → no_code=true
通道二(本单新增):以下全部成立 → no_code=true
  a. 本 PR 存在一个「真·全绿标记」:某次 run 的某个 attempt,
     恰好 5 Unit + 2 Script Tests + 1 payload 全 success 无 skipped,
     且 CI OK success(从权威 API 重验,不信标记自述);
     且该 run 必须是 .github/workflows/ci.yml 本尊的 run
     (workflow_id + path 绑定,防 PR 自带同名 job 的第二个 workflow 铸假标记)
  b. 标记 head 是当前 head 的祖先(本地 git,fetch-depth 0 已有)
  c. 标记记录的被测 base(merge commit 首父)与当前被测 base 相同(main 没动)
  d. 标记记录的 ci.yml blob 与当前一致(c+惰性增量已蕴含,保留作双保险)
  e. 标记 head → 当前 head 的增量 diff 通过现行惰性检查(同一个 Python 检查器)
其余一切(含任何不确定)→ no_code=false,全跑
```

**安全红线(issue 原文)**:「其实动了代码」的提交**绝不能**被误放行。所有判不出、读不到、对不上 → 全跑。快车道 run **绝不写标记**(FLY-1987 plan R1 抓过的自举漏洞:快车道 run 的 CI OK 也是 success,若它能当 baseline,两个文档 run 可以互相作保,重测试一次都没跑过)。

## 5. 标记存哪 — 备选与取舍

| 候选 | 判定 | 理由 |
|---|---|---|
| **Actions artifact**(选它) | ✅ | 结构性绑定 run_id(artifact 属于 run,不是内容自证);写入用 runtime token 不需要扩 GITHUB_TOKEN 权限;读取需要 `actions: read` —— **classify job 恰好已有**(FLY-1877 因结构守卫钉死而保留的"无害残留",现在重新有用);retention 默认 90 天(**本仓库实际值待 N0 实读**),过期 = 全跑(只伤命中率不伤安全) |
| check-run output | ❌ | 需要 `checks: write`,扩权;FLY-350 把 CI token 钉在最小权限,不为省钱开写权限 |
| commit status / git notes / tag | ❌ | 需要 `statuses: write` / `contents: write`,同上 |
| job log 解析 | ❌ | 能读(`actions: read`)但解析脆、格式无 schema;artifact 严格更好 |
| 仓库外存储 | ❌ | 新增基础设施与凭据面,violate 简化令精神 |

## 6. 写入位点 — 备选与取舍

| 候选 | 判定 | 理由 |
|---|---|---|
| **ci-ok job 里加一个后续 step**(选它) | ✅ | 聚合断言 step 成功后才执行(step 顺序天然做门);`if: no_code != 'true'` 挡住快车道 run;ci-ok 已计费的那 1 分钟**预期**装得下(现在只跑 6 秒 jq;**是否真零边际以 N0-d 实测为准**);需要的两个 API 读(merge 父指针、ci.yml blob)只要 `contents: read`,ci-ok 已有 |
| 新增独立 marker job | ❌ | 每次全绿多计 1 分钟(GitHub 按 job 向上取整);job 图变化更大,结构守卫改动面更宽 |

两个方案都要动 `ci-structure.test.sh`(它钉死 job 图与 ci-ok 形状)—— 这是治理守卫的**设计意图**:改动必须台面化。plan.md 会把守卫的同步修改列为显式交付物,不是绕过。

## 7. 诚实边界(founder 页也要写的)

- **救不了**:纯 docs PR(已被现行规则救)、首推、全绿之前的任何提交、被 cancel 的轮次、main 已前进后的文档提交(base 漂移 → 全跑,这是安全边界不是缺陷)。
- **硬前置**:FLY-1996(CI 消费 doc 前缀文件的既有安全洞)必须先落地 —— 快车道扩面会放大那个洞的暴露面(plan §0.1)。
- **$116/月是上限不是承诺**:两个收窄条件(增量真惰性、base/ci.yml 未变)在建模时未验证,真实命中率只有上线后一周对账(issue 验收 3)才知道。
- **不新增信任边界**:同仓 PR 今天就能改 ci.yml 让 CI 空转变绿 —— 这是既有信任类(由 founder-gated ship + review 管着),P1 不扩大它;P1 的消费端从权威 API 重验,不给标记内容新增任何「说了就算」的字段(仅 base 首父与 blob hash 两项是写入时刻的本地事实,伪造它们需要的能力与今天伪造整个 CI 相同)。
- **机制自身成本预期 ≈ 0**(写入嵌在 ci-ok 已计费分钟内,读取嵌在 classify 已计费分钟内)——**以 N0-d 实测为准**,若多计 1 分钟如实入账并重估净省。

## 8. 结论(进入 research/plan 的方向)

采用「artifact 持久标记 + ci-ok 内写入 + classify 内双通道消费」的形态,判据按 §4,所有不确定分支 fail-closed。可行性验证(P1-a spike)的只读部分已在本单 research.md 落地并全部通过;需要真实 run 的部分收紧为实现节点的 **N0 producer spike 硬门**(N0 不过 = 整案放弃,不实现消费端)。另有一个硬前置:FLY-1996(doc-被-CI-消费安全洞)必须先落地(plan §0.1)。
