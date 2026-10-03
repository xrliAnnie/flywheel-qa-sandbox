# FLY-3150 真 Runner 通用演练(529 房间) — 实施计划

Issue: FLY-3150 (https://linear.app/geoforge3d/issue/FLY-3150/qa-sbx-fly-2167-real-runner-generalized-drill-529-room-only)
日期: 2026-10-03(本次派发 run `f461016e`,slot-4 再派发;沿用 run `2eae0ffd` / `c57ecd18` 已评审结构)
基于: exploration.md(README 规定"一份短 plan 足够,不需要 research 文档")

## 1. 范围

- 唯一权威:`origin/main:qa-sbx/fly2167/README.md`。每个节点开工先重读。
- 演练内容只有一个文件:`qa-sbx/fly2167/project-slot-4-FLY-3150.md`(= `git branch --show-current` + `.md`;节点开工时重新算,不要硬编码)。
- 不碰:README、任何代码、Linear issue、529 房间部署/拆除、其他 slot 的目标文件(`project-slot-1/2/5/6-FLY-3150.md`)。
- **流程文档例外(不来自 README,明示边界)**:派发提示词的节点契约(DOC-FLOW / 进度账本 / 设计 HTML)强制把 `engineering/doc/FLY-3150-real-runner-drill/` 下的设计文档与 `progress.md` 提交并推送到同一共享分支。它们是 Runner 协议记账产物,不是演练内容,不进 QA 三条 criterion。为不稀释 README 的"只碰一个 md":
  - **演练内容范围断言**(PR 级,两次交付都跑):`git diff --name-only origin/main...HEAD -- . ':(exclude)engineering/doc/FLY-3150-real-runner-drill'` 的输出**恰好**一行 `qa-sbx/fly2167/<branch>.md`。出现任何其他路径 → 停,不交付。
  - 流程文档只允许落在这个文件夹。

## 2. 本轮起点(派发时快照,仅供参考)

本轮 run `f461016e` 是同一 slot-4 分支的**再派发**(分支连续性:继续 `origin/project-slot-4-FLY-3150@2f94020e3`,OPEN PR #524)。上一轮 run `2eae0ffd` 已完成交付 #1:目标文件在分支上已是精确两行 `QA-SBX FLY-2167 drill` / `AWAITING-QA`(提交 `c179f8875`),PR #524 头 `2f94020e3`。

派发时 `origin/main` 已前进到 `15c97916b`(其他 slot 的 FLY-3150 PR #526 / #529 及 FLY-3228 夹具合入),与本分支在 `engineering/doc/FLY-3150-real-runner-drill/` 内 8 个文件内容冲突。设计节点已按 §3.1 做技术同步:`git merge origin/main`,冲突全部在流程文档文件夹内,逐个保留本轮 slot-4 版本(合并提交 `679732054`),对方来源记入 exploration §16;目录外无冲突。同步后 §1 的 PR 级断言恰好一行 `qa-sbx/fly2167/project-slot-4-FLY-3150.md`。

所以本轮交付 #1 走 §3 第 2 步的**幂等分支**:`HEAD` 中目标 blob 已逐字节正确 → 不再提交目标文件,只写 ledger、冻结 `HANDIN1`、推送、**复用 OPEN PR #524**(不新开)。合并提交在实现节点 `BASE` 之前,不落入交付区间。

**旧指针不是本轮权威**:上一轮的 `run=2eae0ffd HANDIN1=2f94020e3…`、它的代码评审 request `8eaee298…` 与 exact-head CI run、main 历史里 run `e1a786ce` / `1525e2e2` / `c57ecd18` 等的提交与 claim id,都不能当本轮 BASE / PREV / claim id。判定第几次交付只看**本轮**提示词有没有 "QA fix context";交付 #2 的 PREV 只认本轮交付 #1 摘要里的 `run=f461016e HANDIN1=<sha>`。

## 3. 实现节点

记 `F=qa-sbx/fly2167/$(git branch --show-current).md`。

**交付 #1(无 "QA fix context")**
1. `BASE=$(git rev-parse HEAD)`。
2. 先按 **HEAD 中的 blob** 判断:若 `git show HEAD:"$F" 2>/dev/null | cmp - <(printf 'QA-SBX FLY-2167 drill\nAWAITING-QA\n')` 零输出(路径存在于 HEAD 且字节精确;未跟踪文件不算)→ 跳过第 3–4 步的目标文件提交,直接到第 5 步;否则覆盖写两行:`printf 'QA-SBX FLY-2167 drill\nAWAITING-QA\n' > "$F"`。
3. 自检(**工作树**,目标文件此时尚未提交):`printf 'QA-SBX FLY-2167 drill\nAWAITING-QA\n' | cmp - "$F"` 退出码 0。
4. `git add "$F"` 并提交 `docs(qa-sbx): FLY-3150 drill hand-in`。
5. 写 ledger:`node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" --file engineering/doc/FLY-3150-real-runner-drill/progress.md …`(从仓库根跑)—— 该命令会**自行提交** progress.md(path-limited commit),不要再手动 add/commit 它;之后确认 `git status --porcelain` 为空。**所有 ledger 提交完成后**才冻结 `HANDIN1=$(git rev-parse HEAD)`。
6. 核验:(a) `git diff --name-status $BASE..$HANDIN1` 只含 `"$F"`(`A`/`M`)+ `M` progress.md;仅当 `git show $BASE:"$F"` 已是精确两行时允许目标文件不在该范围内;(b) `git show $HANDIN1:"$F"` = 上述两行;(c) §1 的 PR 级断言通过(这个对 `origin/main` 的断言在任何情况下都要求目标文件恰好一项)。
7. `git push -u origin HEAD`(普通快进推送)。PR:先查 `gh pr list --head project-slot-4-FLY-3150 --state open --json number --jq '.[0].number'`;有 OPEN PR(本轮重试或再派发,当前为 #524)就复用,没有才 `gh pr create --base main --head project-slot-4-FLY-3150 --title 'FLY-3150 QA-SBX FLY-2167 real-runner drill (run f461016e)' --body-file "$TMPDIR/fly3150-pr-body.md"`(正文写明 Linear issue 链接与本轮 run id);复用已有 PR 时用 `gh pr edit <n> --body-file "$TMPDIR/fly3150-pr-body.md"` 把正文改写为本轮 run id 与本轮核验结果(不改标题,上一轮的 HANDIN1 / 评审 / CI 记录不得留作本轮证据)。确认远端分支头 / PR 头 / CI 都在 `$HANDIN1`,交付;**交付摘要写明 `run=f461016e HANDIN1=<完整 SHA>`**(返工唯一 PREV 来源)。

**交付 #2(提示词首行 `QA verdict to fix: claim <id> ...`)**
1. 用 `^QA verdict to fix: claim (\S+)` 取 `ID`,原样复制;取不到 → 失败通道,不猜。
2. `PREV` = 本轮交付 #1 摘要里的 `HANDIN1`(`run=f461016e`);确认它是 HEAD 的祖先,且 `git show $PREV:"$F"` 第 2 行是 `AWAITING-QA`。取不到 → 失败通道,不退回 `git log` 猜。
3. 只改第 2 行为 `FIXED-FOR-CLAIM $ID`(若重试且 `git show HEAD:"$F"` 的 blob 已逐字节等于该内容,跳过第 4 步的目标文件提交;只看工作树或 `git diff` 不算);自检 `printf 'QA-SBX FLY-2167 drill\nFIXED-FOR-CLAIM %s\n' "$ID" | cmp - "$F"` 零输出。
4. `git add "$F"` 并提交 `docs(qa-sbx): FLY-3150 drill fix for claim $ID`。
5. 写 ledger(`progress` 命令自行提交 progress.md),确认工作树干净后才冻结 `HANDIN2=$(git rev-parse HEAD)`。
6. 核验:`$PREV..$HANDIN2` 只含 `M "$F"` + `M` progress.md;`$F` 的 patch 恰为 `-AWAITING-QA` / `+FIXED-FOR-CLAIM $ID`;§1 断言仍通过。
7. 推送并确认远端 / PR / CI 都在 `$HANDIN2`,交付。

核验后若又产生提交(含 ledger),重新固定 SHA、核验、推送。commit message 与 PR 标题不得含 `[skip ci]` / `[ci skip]` / `[no ci]` / `[skip actions]` / `[actions skip]` / `skip-checks:`。不 force-push;`origin/main` 前进时按 §3.1 处理。ledger 的 `--handoff` 只写**写入时已确定**的信息(本轮 `run=f461016e`、阶段、claim id、返工时已知的 PREV/HANDIN1),**不写本次最终交付头**(ledger 自提交会改变 HEAD,无法记录自身 SHA);最终 `HANDIN1`/`HANDIN2` 只写在不产生 Git 提交的交付摘要里。开出 PR 后用 `--pointer pr=<本轮 PR URL>` 覆盖账本里的 `none` 占位(本轮账本 `pr` 指针已是 PR #524,复用时保持)。

### 3.1 发生 main 同步时的核验分支

- **何时同步**:只在 PR 显示冲突(`gh pr view --json mergeable` 为 `CONFLICTING`)或节点契约明确要求时才同步,不主动同步。同步 = `git fetch origin main && git merge origin/main`(不 rebase、不 force-push)。
- **冲突处理**:冲突只允许落在 `engineering/doc/FLY-3150-real-runner-drill/` 内 —— 逐个 `git checkout --ours -- <path>` 保留本轮 slot-4 版本,并在 exploration.md 追加一个新小节记录对方 slot 的运行来源(不静默丢弃);冲突出现在该文件夹之外 → `git merge --abort`,走失败通道,不自行取舍。
- **判定**:交付区间(交付 #1 为 `$BASE..$HANDIN1`,交付 #2 为 `$PREV..$HANDIN2`)里 `git rev-list --merges <区间>` 非空 → 走本分支的核验,**替代**第 1 次交付第 6(a) 步与第 2 次交付第 6 步的全树双点范围限制(合并会带进 main 的路径和新增的 exploration 记录,旧限制必然不过);为空 → 仍用原限制。
- **同步后的核验**(仍要求工作树干净,`HANDIN` 在所有提交含 ledger 之后才冻结):
  - 交付 #1:(a) §1 的 PR 级范围断言对 `$HANDIN1` 通过(排除流程文档文件夹后恰好只有 `"$F"`);(b) `git show $HANDIN1:"$F"` 逐字节等于 `QA-SBX FLY-2167 drill` / `AWAITING-QA` 两行。
  - 交付 #2:`PREV` 不变,仍是本轮交付 #1 摘要里的真实 `HANDIN1`(照旧做祖先检查,不得因同步改指向合并后的头);(a) `git diff $PREV..$HANDIN2 -- "$F"` 的 patch 恰为 `-AWAITING-QA` / `+FIXED-FOR-CLAIM $ID`;(b) §1 的 PR 级范围断言对 `$HANDIN2` 通过;(c) `git show $HANDIN2:"$F"` 逐字节等于 `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM $ID` 两行。
  - 推送后照旧确认远端分支头 / PR 头 / CI 都在最终交付 SHA;交付摘要注明发生过同步。

## 4. QA 节点

分轮只看提示词有没有 "QA re-verification context"。

| criterion | 第 1 轮 | 重验轮 |
|---|---|---|
| `file-shape` | 文件存在且第 1 行 = `QA-SBX FLY-2167 drill` | 同左 |
| `fixed-for-claim` | 恒 `fail`,evidence `round 1: no previous QA claim yet` | 第 2 行 = `FIXED-FOR-CLAIM <id>`(id 取自 `Previous QA verdict: claim <id>`)才 `pass`;取不到 id → 失败通道,不得 pass |
| `e2e_529_exempt` | `not_run`,`exempt_category: docs_only`,附原因 | 同左 |

title < 120 字符,evidence < 80 字符;不部署房间、不碰 Linear、不改目标文件。

## 5. 流程

```mermaid
sequenceDiagram
    participant I as eng_implement
    participant Q as qa
    participant B as 驱动器
    B->>I: 派发(无 QA fix context)
    I->>B: 交付 #1:新增 drill / AWAITING-QA
    B->>Q: 第 1 轮
    Q->>B: fixed-for-claim = fail(planted),产生 claim <id>
    B->>I: QA fix context: claim <id>
    I->>B: 交付 #2:FIXED-FOR-CLAIM <id>
    B->>Q: 重验(Previous QA verdict: claim <id>)
    Q->>B: 逐字匹配 → pass
```

## 6. 诚实边界

只覆盖 README 的两行文件 + 三条验收,证明 529 房间里真 Runner 的 fail → fix → re-verify 回路能贯通 claim id;不设计任何 Flywheel 代码,不验证生产 FLY-2167 实现本身。回滚 = revert 本轮提交。
