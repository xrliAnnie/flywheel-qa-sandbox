# FLY-2000 文档快车道历史回溯 — 设计纠偏

Issue: FLY-2000 (https://linear.app/geoforge3d/issue/FLY-2000/ci省钱-文档提交走快车道纯文档提交只跑快速检查fly-1987-p1founder-立单先做识别判据可行性验证)
日期: 2026-08-23
基于: plan.md；Founder 纠偏原话（2026-08-23，经 Lead 转达）

---

## 0. 纠偏与最终裁定

**存在实质冲突，不能按现 plan 继续落 classifier；Founder 已选择 A，维持 FLY-1877 当年的单规则。** FLY-2000 plan 的安全性设计与被删版本有实质改进，但产品形态仍是「在现行整 PR 文档判据之外，再加一条依赖历史全绿基线的增量快车道」；这正是 FLY-1877 明令以「替换而非叠加、规则一条、不看历史」删除的形态。新设计还新增 artifact 持久状态、Actions API 读取、workflow/job census 和 11 段校验，复杂度不低于旧版。

因此：

- 终止 N0 后续实弹、N1 消费端、N2 快车道对照，不再提交 classifier / probe 代码；
- 纠偏前已进入草稿 PR #935 的 producer-only commit 已由 `067f16c9f` 显式 revert，保留完整审计历史、不 force 改写；
- 继续保留不依赖第二通道的事实、测试判据与一周对账方法；本单没有上线新机制，因此不产出虚假的「上线后一周」台账；
- 现行 FLY-1877 单规则保持不变；本单以「技术可行性有继续验证空间，但治理裁定不落第二通道」收口。

这也是 Ponytail 决策梯的第一层：若现行单规则已满足 Founder 想要的「纯文档 PR 走快车道」，则第二通道属于 YAGNI，不应仅因有潜在省钱上限就重新引入。

## 1. Founder 原话（逐字）

> 「这里我要说一点,就是我们之前其实已经做过这个东西,然后我后来删掉了,删掉了是因为我觉得这个不希望把我们的这个逻辑搞得太复杂,然后在CI里面还要搞一个分类器。所以我希望你这里要特别的小心,特别是去看一下我们之前把它加入,然后又删入的,删掉的整个过程,去理解一下说,我是就我不希望发生之前已经加过,你现在又删掉,然后你现在又加同样的东西出来,这样的东西。」

这条纠偏提供了 FLY-2000 设计评审时缺失的治理上下文。先前 plan 的 review 结论不能替代对这条新上下文的确认。

### 1.1 最终裁定（2026-08-23，经 Lead 转达并记录于 Linear）

Founder 原话：

> 「那就还是A吧,维持当年的选择」

落地语义：选择本文 §6 的 A；历史基线分类器 / 文档快车道第二通道废止不实现，producer-only 实验显式 revert，FLY-1996 维持 Canceled 且不再作为本单依赖引用。

## 2. 加入 → 删除的完整过程

### 2.1 FLY-1861 / PR #881：第一次加入历史基线分类器

- 2026-08-18，commit `74d04e9d`（后随 PR #881 merge commit `d839a92f`）加入 Track C。
- 形态：classify 查询 `.github/workflows/ci.yml` 的历史 runs，最多 12 页 / 1,200 条；找当前 PR 最新 completed run，要求 success、base 未漂移、baseline head 是当前 head 祖先，再检查 baseline..head 仅含惰性文档。
- 代码证据：`scripts/ci-classify.sh` 145 行；主查询是 `gh api …/workflows/ci.yml/runs`，并用 `jq` 排序 / 过滤。Track C 首次落码在四个 CI 文件中新增 431 行、删除 8 行。
- 运行后暴露的机制成本：历史查找、分页、rerun 排序、`no_completed_pr_baseline`、base 漂移和 Actions API 可见性都成为需要诊断的状态族；FLY-1861 Linear 后续还记录了每轮约 34 秒的分页成本与候选为空的不可复现样本。

### 2.2 FLY-1877 / PR #883：Founder 要求净删除

FLY-1877 Linear 的 Founder 直令（2026-08-18 19:11）是：

> 「就把这个东西简单化,不要把东西复杂化。这个东西我跟塔达西已经说了很多遍。」

该单把治理边界写得很明确：

- **替换而非叠加**；Founder 已否掉「两条并存」；
- 规则一条、不看历史：整个 PR 相对 merge-base 只动 allowlist 文档 → skip，任何其他情况 → 全跑；
- runs API、分页、新鲜度、rerun 排序、base 漂移整族逻辑全部删除；
- 验收专门要求 `scripts/ci-classify.sh` **零 runs API / 零 `gh` / 零 `jq`**；
- 真正收益被定义为「删掉一套机制」，不是把省钱额度最大化。

commit `6f2d7a8f` 将 `scripts/ci-classify.sh` 从 145 行缩到 84 行；脚本与测试合计新增 189 行、删除 274 行。PR #883 在 2026-08-19 合入（merge commit `fe9e3de8`）。现行 classifier 就是这条单规则。

### 2.3 FLY-1987 / FLY-1996 / FLY-2000：再次提出增量判据

- FLY-1987 成本调研重新提出 P1：若 PR 先有一次合格全绿，之后只追加惰性文档，可只跑快速检查；净省上限是 **$116/月**，不是 issue 旧文里的 $135/月，也不是承诺值。
- FLY-1987 同时证明历史 run 内嵌的 PR base/head 是活指针，无法事后恢复被测 base，因此把「全绿当时写持久标记」从可选项变成必选项。
- FLY-1996 原本把「doc 内被测试消费的文件仍会快车道放行」列为 bug；Founder 于 2026-08-22 13:20 裁定「1996那个不是bug 是feature 只改了文件的PR不需要过CI」，该单已 Canceled。**这只确认现行 doc-only PR 快车道是有意 feature，不等于授权恢复历史基线第二通道。**
- FLY-2000 的「〔方案二·文档快车道〕立单」随后把 P1-a 可行性验证立成单，但没有显式推翻 FLY-1877 的「替换而非叠加」。本次 Founder 纠偏正是要求先把这两个决定对齐。

## 3. 旧版与当前 plan 逐项比较

| 维度 | FLY-1861 被删版 | FLY-2000 当前 plan | 是否实质不同 |
|---|---|---|---|
| 产品语义 | 历史全绿 baseline 后只增文档 → skip | 在现行整 PR 通道外增加同语义 lane 2 | **否**：都是历史基线增量快车道 |
| 与单规则关系 | 与 doc-only 规则并存的前身 | 明写「通道一逐字保留 + 通道二新增」 | **否**：再次成为两条并存 |
| 基线来源 | 每轮从 runs API 选最新 completed | ci-ok 全绿后写 artifact，后续读最新 marker | **是**：从易漂移查询改成持久快照 |
| base / ci.yml 真实性 | 信任历史 run 内嵌 PR base；未钉 ci.yml | marker 记 merge 首父与 ci.yml blob，消费时重验 | **是**：修正旧版核心正确性洞 |
| 全绿认证 | run conclusion success | 绑定 canonical workflow + current attempt + 精确 11-job census | **是**：拒绝快车道 run 自举为基线 |
| 失败策略 | 任何不确定全跑 | 任何不确定全跑，且载体 / 网络全部有界 | **是**：fail-closed 更完整 |
| 外部状态 | runs API 历史、12 页分页 | artifact 生命周期 + repo/run artifact 查询 + run/workflow/jobs API | **不是简化**：状态面更宽 |
| classifier 合同 | `gh` + `jq` + 历史分页 | 需反转 FLY-1877 的「零 runs API / 零 gh」守卫 | **直接冲突** |
| 维护耦合 | run API 字段与分页规则 | marker schema、workflow identity、11-job 名全集、zip/JSON 限额、attempt overwrite | **复杂度复发且更高** |
| 观测 / 成本 | 查询约 34 秒/轮的既有实测 | producer 上传 + consumer 多次 API / 下载，真实计费尚待 N0 | **未知，不可先声称更省** |

结论：新 plan 在「不误放行」上确实比旧版强，不能说是逐行重抄；但 Founder 当年删除的首要理由是**不要 CI 分类逻辑复杂化、不要两条并存**，不是只因为某个 base 字段取错。按这个理由衡量，冲突仍然成立。

## 4. 已废止的设计概念

Founder 选择 A 后，以下不再视为已批准实现合同：

1. 「FLY-2000 的立单自动推翻 FLY-1877 的替换而非叠加」这一假设；
2. `scripts/ci-classify.sh` 新增 lane 2 及 b1–b11 历史基线校验；
3. classifier 读取 artifact / workflow run / attempt jobs，并维护精确 11-job census；
4. 反转 FLY-1877 的「零 runs API / 零 gh / 零 jq」守卫；
5. 将 ci-ok producer marker 当作必需生产机制；纠偏前已提交的 producer 仅作为可逆实验残段，不继续扩展；
6. 把已 Canceled 的 FLY-1996 当作「必须先落地」的可满足硬依赖。若未来授权 lane 2，其 doc-consumer 风险必须按 Founder 已接受的 feature 口径重新写，不得虚构一个不会 landing 的前置。

## 5. 保留的器官

以下内容不依赖历史基线第二通道，继续有效：

1. **现行 FLY-1877 单规则**：merge-base..head 整 PR 只含 allowlist 文档 → 快车道；混入代码、机器消费文件、symlink/gitlink 或任何不确定 → 全跑；
2. **阳性 / 阴性对照**：纯文档为正例，docs+code 混合为负例；误放行必须有机械 RED；
3. **常开安全面**：Quick Gate、Classify、CI OK 聚合门的必跑语义；
4. **fail-closed 原则**与稳定 reason 日志；
5. **一周对账方法**：若未来有另案上线同类机制，命中率与省下分钟数仍应沿用 FLY-1987 `derive-lib.mjs` 的 attempt 口径，金额写成实际值，$116 只作净省上限；本单没有上线，故没有 week-1 观测窗口；
6. **producer-only 已得事实**可以留作可行性研究证据，但裁定 A 后不形成新生产依赖，也不继续投入代码。

## 6. 已裁决的 A/B 选项

### A. 保持单规则（已选择）

保留 FLY-1877 现状；把 FLY-2000 的可行性验证结论写为「技术上可继续验证，但治理上与既有净删除决定冲突，故不落第二通道」。纠偏前 producer commit 显式 revert，PR 只交付 revert 与文档结论。结果是没有新的 classifier 状态、API 依赖与长期维护面。

### B. 明确授权有状态的第二通道（未选择）

该选项会恢复历史全绿 baseline 的产品形态、反转 FLY-1877 的零历史查询合同，并新增 marker / artifact / job-census 维护面；换来的是至多 $116/月、实际未知的增量快车道上限。Founder 未授权该选项，因此 N0→N1→N2 不恢复。

裁定已经完成：执行 A，不再等待 A/B 回复。

## 7. 证据索引与时效

| 事实 | 截止时间 | 复查命令 |
|---|---|---|
| FLY-1861 加入过程与 PR #881 | immutable Git / GitHub merge history；查于 2026-08-23 | `git show --stat 74d04e9d`; `git show d839a92f:scripts/ci-classify.sh`; `gh pr view 881 --repo xrliAnnie/flywheel` |
| FLY-1877 删除过程与 PR #883 | immutable Git / GitHub merge history；查于 2026-08-23 | `git show --stat 6f2d7a8f`; `git show fe9e3de8:scripts/ci-classify.sh`; `gh pr view 883 --repo xrliAnnie/flywheel` |
| 「替换而非叠加 / 零 runs API」治理文本 | Linear 可编辑；查于 2026-08-23 | 通过 Bridge `GET /api/linear/issue?query=FLY-1877` 复查 description；仓内镜像见 `engineering/doc/FLY-1877-classify-docs-only-rule/plan.md` |
| FLY-1996 Canceled 与 Founder feature 裁定 | Linear 可编辑；查于 2026-08-23 | 通过 Bridge `GET /api/linear/issue?query=FLY-1996` 与 `GET /api/linear/comments?issueId=FLY-1996` 复查 |
| FLY-1987 的 $116 上限与 marker 可行性前提 | main 上 process doc；查于 2026-08-23 | `rg -n 'P1|116|持久标记' engineering/doc/FLY-1987-actions-cost-audit/{research,plan}.md` |
| FLY-2000 最终选择 A | Linear 可编辑；Lead 于 2026-08-23 转达 | 复查 FLY-2000 Linear comment；Founder 原话见 §1.1 |
| classifier 当前生产形态 | 会随 main 改变；查于 2026-08-23 | `git show origin/main:scripts/ci-classify.sh`; `git log -S'workflows/ci.yml/runs' -- scripts/ci-classify.sh` |
