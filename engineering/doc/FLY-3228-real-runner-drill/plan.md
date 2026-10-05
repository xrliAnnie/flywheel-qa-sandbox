# FLY-3228 真 Runner 通用演练(529 房间) — 实施计划

Issue: FLY-3228 (https://linear.app/geoforge3d/issue/FLY-3228/qa-sbx-fly-3228-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无(README 规定"一份短 plan 足够,不需要 research 文档",所以本档不出 exploration/research;本文件是上一轮已合并 plan 的本轮改写版)

本轮:run `ad2ead99-37a7-4281-b981-e969df098b4d`,设计节点 exec `0afc317b-dc7e-4981-be2e-899159d0573f`(本轮重派发,接续分支 `48045e7`;该点上的 plan/HTML/progress 是上一轮 run `dd71f848` 未合并的设计产物,本文件为本轮改写版)。

## 1. 范围

- 唯一权威:`origin/main:qa-sbx/fly3228/README.md`。每个节点开工先重读;本 plan 与 README 冲突时以 README 为准。
- 演练内容只有一个文件 `F=qa-sbx/fly3228/$(git branch --show-current).md`。本轮分支 `project-slot-6-FLY-3228` → `qa-sbx/fly3228/project-slot-6-FLY-3228.md`;节点开工时重新算,不要硬编码。
- 不碰:README、任何代码、Linear issue(不改状态、不评论、不加标签)、529 房间部署/拆除、其他 slot / 其他 issue 的目标文件。
- **流程文档例外(不来自 README,明示边界)**:节点契约(DOC-FLOW / 进度账本 / 设计 HTML)要求把 `engineering/doc/FLY-3228-real-runner-drill/` 下的 plan、图、HTML 与 `progress.md` 提交并推到同一分支。它们是 Runner 协议记账产物,不是演练内容,不进 QA criterion。为不稀释 README 的"只碰一个 md",每次交付都跑下面两条断言:
  - 为什么不能干脆不提交它们:`flywheel-comm progress` 命令本身就会把 `progress.md` path-limited 提交到本分支(Runner 协议强制,不可关闭);设计节点契约要求 plan/HTML "commit and push"。这些都是 Lead 注入的节点协议,不在 README 授权范围内也不在其禁止范围内(README 管的是演练内容)。所以本 plan 不扩大 README 的演练范围,而是把流程文件收成**逐文件白名单**,让任何其他路径都失败。
  - 白名单(仅以下精确路径,目录前缀 `W=engineering/doc/FLY-3228-real-runner-drill`):`$W/plan.md`、`$W/progress.md`、`$W/d1-core-flow.mmd`、`$W/d1-core-flow.svg`、`$W/d2-data-model.mmd`、`$W/d2-data-model.svg`、`$W/FLY-3228-design.html`(共 7 个文件)。
  - **完整 diff 断言**(不排除任何目录):`git diff --name-only origin/main...HEAD | grep -vxF -e "$F" -e "$W/plan.md" -e "$W/progress.md" -e "$W/d1-core-flow.mmd" -e "$W/d1-core-flow.svg" -e "$W/d2-data-model.mmd" -e "$W/d2-data-model.svg" -e "$W/FLY-3228-design.html"` 输出必须为空;出现任何其他路径(包括 `$W` 下的新文件)→ 停,不交付。
  - **演练内容断言**:上述完整 diff 中属于 `qa-sbx/` 的行:交付 #1 **恰好**一行 `"$F"`;交付 #2 为 `"$F"` 或**为空**(见 §2:本轮 claim id 若与 main 上遗留的编号相同,`$F` 回到与 main 逐字节相同,PR 级 diff 里自然消失;此时以 §3 交付 #2 第 6 步的 `$PREV..$HANDIN2` patch 核验为准)。
  - 实现节点不新增、不修改白名单里除 `progress.md`(由 `progress` 命令自动提交)以外的任何流程文件。

## 2. 起点(设计节点派发时快照,仅供参考)

- 设计节点派发时:远端分支 `project-slot-6-FLY-3228` 已存在,头 = `48045e7`(基于旧 `origin/main` `caabb83da`,只多了上一轮 run `dd71f848` 的设计文档/ledger 提交,没有演练内容提交);`origin/main` 已前进到 `c68c2b7d4`,新增的只是其他 issue 的提交,不涉及 `qa-sbx/fly3228/` 或本文件夹。`gh pr list --head project-slot-6-FLY-3228 --state all` 只有前几轮已 MERGED 的 #525、#545、#551(都不复用,本轮开新 PR)。
- **目标文件已存在于 main**,内容是上一轮遗留的 `QA-SBX FLY-3228 drill` / `FIXED-FOR-CLAIM 1`。所以本轮交付 #1 是**修改**(`M`,第 2 行 → `AWAITING-QA`),不是新增。
- main 上的旧 plan、旧 HTML/图、旧 `progress.md`(run `dce567d4`,其中 PR #551、`HANDIN1=63613f56…`)以及分支上 run `dd71f848` 的设计提交都来自之前的轮次;其中的 claim id、`HANDIN1`、PR 号、SHA **都不是本轮权威**。判定第几次交付、取 claim id、取 `PREV` **只看本轮提示词与本轮交付摘要**。
- 设计节点已在分支上加了 ledger 提交,还会再加流程文档提交;实现节点自己重算 `BASE`。

## 3. 实现节点

固定内容:`L1='QA-SBX FLY-3228 drill'`。

**交付 #1(提示词无 "QA fix context")**
1. `BASE=$(git rev-parse HEAD)`。
2. 若 `git show HEAD:"$F" 2>/dev/null | cmp -s - <(printf '%s\nAWAITING-QA\n' "$L1")` 成功(HEAD 中 blob 已逐字节正确;未跟踪/未暂存不算)→ 跳过第 3–4 步;否则 `printf '%s\nAWAITING-QA\n' "$L1" > "$F"`(本轮起点第 2 行是 `FIXED-FOR-CLAIM 1`,预期要写)。
3. 自检:`printf '%s\nAWAITING-QA\n' "$L1" | cmp - "$F"` 退出码 0(恰两行、末尾单换行、无多余空白);红:改前不匹配,绿:改后匹配。
4. `git add "$F"`,提交 `docs(qa-sbx): FLY-3228 drill hand-in`。
5. 写 ledger(`progress` 命令自行做 path-limited 提交,不要手动 add/commit progress.md);确认 `git status --porcelain` 为空后才冻结 `HANDIN1=$(git rev-parse HEAD)`。
6. 核验:(a) `git diff --name-status $BASE..$HANDIN1` 只含 `M "$F"`(第 2 步跳过时可无)+ progress.md;(b) `git show $HANDIN1:"$F"` 逐字节等于两行;(c) §1 断言(交付 #1 形态)通过。
7. `git push -u origin HEAD`(普通快进)。PR:有本 head 的 OPEN PR 就复用,否则 `gh pr create --base main --head project-slot-6-FLY-3228 --title 'FLY-3228 QA-SBX real-runner drill hand-in'`,正文写 Linear 链接与本轮 run id。确认远端分支头 / PR 头 / CI 都在 `$HANDIN1` 再交付;**交付摘要写明 `HANDIN1=<完整 SHA>`**(返工 `PREV` 的唯一来源)。

**交付 #2(本轮提示词含 "QA fix context")**
1. 定位本轮 "QA fix context" 的**内容首行**(context 前可以有其他说明,不要求它是整个提示词的首行),用 `^QA verdict to fix: claim (\S+)` 取 `ID`,原样复制(不改大小写、不去前导零);首行不匹配或取不到 → 失败通道,不猜,也不从提示词里的历史示例、main 上遗留的 `FIXED-FOR-CLAIM 1`、旧 progress.md 或其他上下文抓 ID。
2. `PREV` = 本轮交付 #1 摘要里的 `HANDIN1`;确认它是 HEAD 的祖先,且 `git show $PREV:"$F"` 第 2 行为 `AWAITING-QA`。取不到 → 失败通道,不从 `git log` 或旧 ledger 猜。
3. 只把第 2 行改为 `FIXED-FOR-CLAIM $ID`(重试时若 HEAD 中 blob 已逐字节正确,跳过第 4 步);自检 `printf '%s\nFIXED-FOR-CLAIM %s\n' "$L1" "$ID" | cmp - "$F"` 退出码 0。
4. `git add "$F"`,提交 `docs(qa-sbx): FLY-3228 drill fix for claim $ID`。
5. 写 ledger,工作树干净后才冻结 `HANDIN2=$(git rev-parse HEAD)`。
6. 核验:`$PREV..$HANDIN2` 只含 `M "$F"` + progress.md;`$F` 的 patch 恰为 `-AWAITING-QA` / `+FIXED-FOR-CLAIM $ID`;§1 断言(交付 #2 形态,允许为空)通过。
7. 推送,确认远端 / PR / CI 都在 `$HANDIN2`,交付。

**共同纪律**
- commit message 与 PR 标题**不得**含 `[skip ci]` / `[ci skip]` / `[no ci]` / `[skip actions]` / `[actions skip]` / `skip-checks:`(本仓库历史提交带这些标记,不要照抄)。
- 不 force-push、不 `--no-verify`。核验后若又产生提交(含 ledger),重新冻结 SHA、核验、推送。ledger `--handoff` 只写写入时已确定的信息;最终 `HANDIN1`/`HANDIN2` 只写在交付摘要里(ledger 自提交会改变 HEAD)。
- **main 同步**:只在 PR 显示 `CONFLICTING` 或节点契约要求时 `git fetch origin main && git merge origin/main`(不 rebase)。冲突只允许落在 `engineering/doc/FLY-3228-real-runner-drill/` 内(保留本轮版本);落在别处(含 `$F`)→ `git merge --abort`,走失败通道。交付区间含 merge 提交时,用"§1 断言 + `$F` 内容/patch 逐字节核验"替代第 6 步的全树双点限制;`PREV` 不因同步改指向。

## 4. QA 节点

分轮只看提示词有没有 "QA re-verification context"。

| criterion | 第 1 轮 | 重验轮 |
|---|---|---|
| `file-shape` | 文件存在且第 1 行 = `QA-SBX FLY-3228 drill` | 同左 |
| `fixed-for-claim` | **恒 `fail`**,evidence `round 1: no previous QA claim yet`(故意埋的失败,本演练的目的;即便文件第 2 行碰巧像 `FIXED-FOR-CLAIM …` 也不 pass) | 第 2 行 = `FIXED-FOR-CLAIM <id>`(id 取自 "QA re-verification context" 里的 `Previous QA verdict: claim <id>`)才 `pass`;取不到 id → `fail`,不得 pass |
| `e2e_529_exempt` | `not_run`,`exempt_category: docs_only`,附原因 | 同左 |

title < 120 字符,evidence < 80 字符;只读核验被验 head 上的 `$F`,不部署房间、不碰 Linear、不改目标文件。

## 5. 测试证据

无代码 → 无单测/构建。证据 = §3 的 `cmp` 逐字节自检(红:改前不匹配;绿:改后匹配)+ §1 范围断言 + 精确 head 上的 CI 结果 + QA 节点的 criteria JSON。负向守卫:多一行、尾随空白、错 claim id、前导零差异、沿用 main 遗留编号、目标文件之外的演练路径,都必须让自检或断言失败。

## 查询与索引

不适用:本演练只修改一个两行 markdown 文件,没有新增或改动任何表、查询或索引。

## 6. 诚实边界

只覆盖 README 的两行文件 + 三条验收,证明 529 房间里真 Runner 的 交付 → 故意 fail → 按 claim 修 → 重验 回路能贯通本轮 claim id。不设计任何 Flywheel 代码,不验证生产功能,不部署房间。回滚 = revert 本轮提交(或关 PR 不合并);对 main 和生产零影响。
