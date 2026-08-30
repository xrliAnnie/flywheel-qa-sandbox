# FLY-2166 迁移审计结构性不可通过 — 探索

Issue: FLY-2166 (https://linear.app/geoforge3d/issue/FLY-2166/fly-2103-遗留-迁移脚本-pre-cutover-审计对真实仓库结构性不可通过g1-receipt-不可获得已手工等价完成迁移)
日期: 2026-08-29
基于: 无

## 1. 问题重述

FLY-2103 (PR #987) 交付的 `scripts/migrate-fly2103-project-flags.ts` 的 `--phase pre-cutover`
对真实六仓结构性不可通过,G1 receipt 不可获得。迁移本体已于 2026-08-29 经 Bridge
`/api/fleet/flag/stage → /apply` 手工等价完成(6 行);post-deploy(第 7 行 ponytail
`*`=0 + G2)也计划手工执行。本单要给出:脚本处置、审计真相源与顺序自锁的修法,
以及为未来同类迁移沉淀的守则。

## 2. 现状实证(2026-08-29 23:18Z,本 worktree 逐项核对)

### 2.1 SQLite flag 行(`~/.flywheel/teamlead.db` → `flag_values`)

按 `FLY2103_MIGRATED_FLAG_NAMES` 过滤后恰好 6 行,与 `FLY2103_PRE_CUTOVER_ROWS`
manifest 逐行相等,全部 `updated_by=bridge-local-operator`、`updated_at=2026-08-29
22:28Z`(issue 记录的 22:47Z 是复核时刻;写入时刻以 DB 为准):

```
doc_flow/flywheel=1  doc_flow/joycon-typeless=1  doc_flow/personal-assistant=1
doc_flow/tidal-echo=1  pipeline_dag/flywheel=1  pipeline_work_kind/flywheel=1
```

`ponytail|*|0`(第 7 行)**尚未写入** —— post-deploy 手工步骤还没执行(等新 Bridge)。
`~/.flywheel/state/migrations/` 目录不存在,G1 receipt 从未生成。

### 2.2 六仓 config.yaml 矩阵(worktree vs committed@{upstream})

| 项目 | worktree retired keys | committed retired keys | config.yaml dirty |
|---|---|---|---|
| flywheel | checkpoints.enabled ×4 + doc_flow.enabled + pipeline.dag/work_kind(旧内容) | **已清理**(#987 已合并) | ✅ M |
| geoforge3d | checkpoints.enabled ×3(doc_flow 已本地删) | checkpoints ×3 + **doc_flow.enabled: true** | ✅ M |
| growth | checkpoints.enabled ×3(doc_flow 已本地删) | checkpoints ×3 + **doc_flow.enabled: true** | ✅ M |
| joycon-typeless | checkpoints ×3 + doc_flow.enabled | 同 worktree(其他键有未提交差异) | ✅ M |
| personal-assistant | checkpoints ×3 + doc_flow.enabled | 与 worktree 完全一致 | clean |
| tidal-echo | checkpoints ×2 + doc_flow.enabled | 同 worktree | ✅ M |

### 2.3 审计在每个真实时点的失败面

`auditLegacyConfigs` 的两道断言对着上表逐项对照:

- **PR #987 合并前**(从分支跑):geoforge3d/growth 的
  `assertRetiredKeysMatchCommitted` 先炸(worktree 缺 doc_flow、committed 有 →
  divergence);即便跳过,committed 推导出 8 行 ≠ 6 行 manifest,exact-set 炸。
- **PR #987 合并后**(现在):flywheel 的 committed 已清理 →
  `assertRetiredKeysMatchCommitted` 炸(worktree 旧内容 vs committed 已清);即便
  worktree 同步,`checkpoint legacy enabled must still be true` 炸(committed 里
  enabled 已删)。
- 结论与 issue 一致:**不存在任何真实时点能跑通 `pre-cutover --apply`**,G1 receipt
  结构性不可获得;而 `post-deploy` 硬性要求这个 receipt(逐字段校验含
  `manifestDigest`/`committedConfigDigest`),故 post-deploy 的脚本化路径同死。
  伪造一份 `status: passed` receipt 等于伪造审计产物,不在考虑范围。

### 2.4 Companion config PR 与运维序列

PR #987 body 列出 5 个外部 companion PR,现全部 **OPEN** 等维护窗:
GeoForge3D#283 / joycon-typeless#49 / belle-workspace#3 / growth#25 / tidal-echo#28。
实查 GeoForge3D#283 与 growth#25 的 diff:**确实同时删了 committed 里的
`doc_flow.enabled`**(plan Step 6 的文字清单漏写了这两键,但 PR 实体覆盖)。
即维护窗合并 + 同步 checkout 后,六仓 committed/worktree 都会干净。

### 2.5 新 loader 的 fail-loud 与兜底

#987 的 ConfigLoader 对 8 个结构入口(覆盖原 9 类 retired key;`pipeline` 整块判退)
**硬 throw**(`retiredProjectFlag`),
Bridge 侧的失败模式已内建:被拒项目的 runtime 被 drop,并发
`project_config_invalid` meta-alert(`MetaAlertNotifier.ts:47`),Bridge 本体不崩。
⚠️ 运维风险(不归本单修,但必须上报):当前六个 main checkout 的 worktree config
**全部还带 retired keys**(flywheel checkout 的 config.yaml 是带旧内容的未提交修改,
`git pull` 不会替它清理)。若下一班车(本地 00:00/12:00)在 companion PR 合并 +
checkout 同步之前部署 #987 代码,六个项目会全部被 drop 并连发 meta-alert。
维护窗操作里「同步 6 个 main checkout」必须显式处理 dirty 文件(reset 或提交),
不能只 `git pull`。

## 3. 根因分析

### 3.1 真相源错位(设计缺陷)

6 行 manifest 是从**运行时 effective 行为**推导的(geoforge3d/growth 的 doc_flow
OFF —— 见 qa.md 的 7×6 对照表);而 `auditLegacyConfigs` 从**committed@{upstream}**
推导预期行集。两个真相源在 geoforge3d/growth 上真实分叉:运行时关闭只存在于
main checkout 的未提交本地修改里。审计隐含假设 committed == runtime,这个假设
从一开始就不成立。`assertRetiredKeysMatchCommitted` 本意是逼真相源收敛
("resolve the repository change explicitly before cutover"),但没有任何流程步骤
负责在跑审计前完成这个收敛(把两仓的本地关闭提交掉),于是它成了必炸断言。

### 3.2 顺序自锁(交付形态缺陷)

flywheel 自己的 config 清理与迁移脚本**同乘 PR #987**(plan Step 6:"flywheel
(本 PR):删 …")。审计要求「全部 legacy key 仍在 committed」,而脚本可运行的
每个 commit 上 flywheel 的 legacy key 都已删 —— 合并前 geoforge3d/growth 挡路,
合并后 flywheel 挡路。脚本的 ordering 合同(G1 必须先于任何 config-removal PR
落地)被自己的交付载具违反。

### 3.3 QA 缺口:阳性对照缺失,阻断被合理化(修正版,以 milestone 为准)

- 单测 fixtures 把 geoforge3d/growth 的 committed 构造成「doc_flow 本来就没开」
  (`fly2103-project-flag-migration.test.ts:60` 一带只给 4 个 manifest 项目开
  doc_flow)—— fixture 是按**假设的** committed 状态搭的,不是按真实状态。
- divergence 形状(worktree 缺 / committed 有)在单测里**被覆盖过**(`:137-142`),
  但被当成「正确地 RED」的反例用例,没有人意识到这正是真仓的实际形状。
- `qa-bridge-parity.mjs` 的 fixture 项目没有 git 仓(只写 config.yaml 文件),
  迁移脚本(强依赖 `git rev-parse @{upstream}`)在该 harness 上不可运行;qa.md 中
  「pre-cutover 对现网六份 YAML 的严格审计得到 6 个计划写入」指向合成快照上的
  单测结论。
- **事实修正**(issue 原文说「从未对真仓跑过 dry-run」不完全准确):
  `engineering/doc/milestones/FLY-2103.md` 记载,QA attempt 1 返工后**跑过**一次
  真仓 dry-run,它「已在 GeoForge3D 的 `doc_flow.enabled` 分歧处按预期阻断,未替
  外部仓决定脏树去留」。真正缺失的是**通过态的阳性对照**:阻断被记录为
  「按预期」(审计正确拒绝),但没有任何流程步骤负责收敛分歧后再跑到 PASS,
  也没有人追问「哪个真实时点这个审计能通过」—— 而 §3.2 的顺序自锁使这个时点
  根本不存在。「跑过且阻断」被误读成「审计工作正常」,恰好掩盖了「审计永远
  无法通过」。

## 4. 设计空间

### 方案 A:修脚本至真实可跑,补铸 G1,post-deploy 走脚本

给审计加 per-project disposition 输入(founder 裁决记录)+ `--legacy-ref`
(指定合并前的 flywheel ref)→ 重跑 `pre-cutover --apply`(6 行已在,全部 no-op,
只补铸 receipt)→ 维护窗后 `post-deploy --receipt` 脚本化。

- 代价:对一次性脚本(全部常量 FLY2103_ 前缀,不会有第二次运行)做机制扩张:
  新输入格式、新校验分支、新测试;审计代码为「让它通过」而改,是拿答案改尺子。
- 收益:一条形式完备的 receipt 链 —— 但迁移的实质(6 行写入)已发生在链外,
  补铸的 receipt 证明力本来就弱于手工核对记录。
- 与 founder 红线「只删不加」正面冲突(FLY-2076 教训:评审条数逐轮涨=在长机制)。

### 方案 B:G1 判死,post-deploy 改收人工 attestation

比 A 小,但仍要新增 attestation 输入 + 校验分支,且 post-deploy 的 config 审计
还要求六仓 committed 全清(依赖维护窗完成),脚本化收益趋近于零 —— G2 的实质
就是一条 SQL exact-set 核对 + 可观察面抽查,手工成本低于维护这段代码。

### 方案 C(倾向):脚本退役 + 手工 G2 核对清单 + 未来迁移守则

1. **净删**脚本 + lib + 其专属测试(消费者 sweep 已做:仓内引用仅
   `fly1436-pr-b-assets.test.ts` 的文本断言,需同步改写;插件缓存零命中,
   2026-08-29T23:22Z)。git 历史保留全部代码,守则文档引用其 SHA。
2. 把脚本里仍有价值的断言转写成**手工 G2 runbook**(纯文档):exact-set==7 的
   SQL、六仓 config 清理核对、Step 7 可观察面抽查清单、dirty checkout 处理。
   经 Lead 挂到 FLY-2103 thread,供维护窗操作者使用。
3. 把三条教训写成**一次性迁移脚本守则**(`doc/reference/`):审计真相源必须显式
   声明并在跑审计前收敛;脚本不得与它审计的 config 清理同乘一个 PR;ship 前
   必须对真实环境跑一次 dry-run 阳性对照(这是 QA 流程门,不是 CI 门 —— CI
   没有六个真仓 + 真 DB,结构上做不了这个对照)。
4. receipt 机制作为**模式**保留在守则里(它本身是好的),供下一个迁移脚本
   参考实现,而不是保留这份跑不通的实现。

### 方案 D:最小补一个 `--phase verify`(免 receipt 的 exact-set 核对)

约 30 行,但它做的事就是一条 sqlite 查询;为此保留 1000+ 行不可运行的脚本主体,
性价比为负。runbook 里的 SQL 覆盖同样能力。

## 5. 倾向与理由

**方案 C。** 判据:

- 迁移已 6/7 手工完成,剩余工作(第 7 行 + G2)本来就计划手工做;脚本没有
  任何未来运行时点。修复(A/B)是为已经发生的事补一条形式链,纯机制增长。
- 「只删不加」红线与 enforce-simplicity 都指向净删;git 历史 + 守则文档引用
  SHA 保住模式价值。
- issue 修法里「receipt 机制本身是好的,为未来同类迁移保留」在方案 C 里由守则
  文档承接 —— 保留的是机制**模式**,不是这份结构性跑不通的实现。
- 真仓 dry-run 阳性对照进「CI」在字面上不可行(CI 环境没有六仓/真 DB),
  方案 C 把它落成 QA 流程硬门写进守则,这是该教训能落地的真实形态。

## 6. 边界(本单做 / 不做)

- ✅ 做:脚本处置(净删 + 引用改写)、手工 G2 runbook、未来迁移守则文档。
- ❌ 不做:FLY-2103 剩余 cutover 运维(companion PR 合并、checkout 同步、
  ponytail 行写入、G2 执行本身)—— 归 FLY-2103 thread;本单只提供 runbook。
- ❌ 不做:伪造/补铸任何 `status: passed` 的 G1 receipt。
- ⚠️ 上报:§2.5 的班车时序风险(六 checkout worktree 全 dirty,早于 companion
  PR 合并的部署会 drop 全部六项目)。
