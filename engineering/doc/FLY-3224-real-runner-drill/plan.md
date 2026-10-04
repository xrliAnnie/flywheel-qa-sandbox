# FLY-3224 真 Runner 通用演练(529 房间) — 实施计划
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04(本次派发 run `18c10fbd`,exec `7cab2c09`,slot-2;骨架沿用上一轮 run `0565c800` 已评审通过的计划,只改 §2 起点:分支继承上一轮已交付的 `AWAITING-QA`,复用仍开着的 PR #553)
基于: exploration.md(README 规定"一份短 plan 足够,不需要 research 文档")

## 1. 范围

- 唯一权威:`origin/main:qa-sbx/fly3224/README.md`(blob `c4a1b333…`)。每个节点开工先重读。
- 演练内容只有一个文件:`F=qa-sbx/fly3224/$(git branch --show-current).md`,本轮 = `qa-sbx/fly3224/project-slot-2-FLY-3224.md`(节点开工时重算,不硬编码)。
- 不碰:README、任何代码、Linear issue(状态 / 评论 / 标签)、529 房间部署/拆除、其他 slot / 其他练习单的文件。
- **流程文档例外(不来自 README,来源与边界明示)**:README 的 "Touch only the one markdown file" 约束的是**演练内容**。每个节点的派发提示词另外注入了 Flywheel 节点契约(权威来源 = Bridge 注入的系统提示,不是本仓库文件):DOC-FLOW(`engineering/doc/FLY-3224-<slug>/` 下的 exploration / plan)、PROGRESS LEDGER(同文件夹 `progress.md`,由 `flywheel-comm progress` 自行 path-limited 提交)、设计节点强制的创始人设计 HTML(必须提交并推送)。它们是协议记账,不是演练交付物:
  - 只允许落在 `engineering/doc/FLY-3224-real-runner-drill/` 一个文件夹;实现 / QA 节点除 `progress.md` 外不新增、不修改这里的文件。
  - 不进任何 QA criterion;PR 级断言把这个文件夹排除后再看演练净 diff。
- **PR 级演练范围断言**(两次交付都跑,记 `X=':(exclude)engineering/doc/FLY-3224-real-runner-drill'`):
  1. `git diff --name-only origin/main...<交付头> -- . "$X"` 的输出**只能**是空或恰好一行 `"$F"`;出现其他路径 → 停,不交付。
  2. `git show <交付头>:"$F"` 逐字节等于本次交付的期望两行(每行以 `\n` 结尾,共两行)。
  3. 输出为空**只在**合并基 `git merge-base origin/main <交付头>` 上的 `"$F"` 已逐字节等于本次期望两行时才合法。main 上残留(PR #547)的正是 `FIXED-FOR-CLAIM 1`(本轮派发时 `origin/main` = `caabb83da` 仍如此):交付 #1 期望 `AWAITING-QA`,所以交付 #1 **必须**恰好一行 `"$F"`;交付 #2 若本轮 claim id 也是 `1`,PR 级演练净 diff 为空是预期结果,返工由 §3 交付 #2 第 6(b) 步的区间 patch 证明。

## 2. 本轮起点(派发时快照,实现节点自己重算)

- 派发起点:`origin/main` = `caabb83da`(合入了 FLY-3227 的 PR #554);本地分支头 = 远端 `origin/project-slot-2-FLY-3224` = 设计节点最后一次提交(派发时 `44bf91dd`,其上是本设计节点的流程文档提交)。§1 的断言用三点 `origin/main...<交付头>`,main 之后若前进不影响判定;不主动同步,只按 §3.1 处理。
- **分支继承上一轮(run `0565c800`,exec `78025e65`)的交付**:它的交付 #1 提交 `77cdb3bf…` 已把 `"$F"` 写成 `AWAITING-QA` 两行,PR #553 仍 OPEN(base `main`,标题带 `run 0565c800`);那一轮的 QA 结果(若有)不属于本轮。本轮 **不** force-push、不另开 PR:交付时第 7 步的块按 OPEN PR 查到 #553,改标题 / 正文为本轮(`run 18c10fbd`),普通快进推送。
- 所以本轮 `HEAD:"$F"` 已逐字节等于 `AWAITING-QA` 两行 → 交付 #1 走 §3 第 2 步的 **继承态**(就是原计划的"重试态"分支,来源换成上一轮继承):不重写文件、不提交演练文件,`IMPL1=BASE`;交付 #1 的新提交只有 ledger(`"$L"`),它让交付头成为新 SHA,推送后 CI 在这个确切头上重新跑。返工回路照样成立:交付 #2 的证据是 `$PREV..$HANDIN2` 的 `-AWAITING-QA` / `+FIXED-FOR-CLAIM $ID` patch,`PREV` = 本轮交付 #1 的 `HANDIN1`,与 main 上残留的 `FIXED-FOR-CLAIM 1` 无关。
- 设计节点自己的流程文档提交(含 ledger 覆盖)都在实现节点 `BASE` 之前,不进入交付区间;设计节点不改 `"$F"`。
- **开工前置**:实现节点第 1 步之前先跑 `git status --porcelain`,输出必须为空;不为空 → 不清理、不提交别人的文件,走失败通道(`flywheel-comm ask` 报告路径后停)。
- **旧指针一律不认**:PR #547;上一轮 run `0565c800` 的 `HANDIN1`(`77cdb3bf…`)、ledger 头 `44bf91dd…`、PR #553 的旧正文与旧 CI(PR #553 只是本轮复用的容器);更早 run `0300be9d` 的 HANDIN / PREV / `IMPL2` / claim id;main 历史 / 旧 progress.md 里的指针;其他练习单的指针 —— 都不是本轮 BASE / PREV / claim id / 交付证据。判定第几次交付只看**本轮**提示词有没有 "QA fix context";交付 #2 的 PREV 只认本轮交付 #1 摘要里的 `run=18c10fbd HANDIN1=<sha>`。

## 3. 实现节点

记 `F=qa-sbx/fly3224/$(git branch --show-current).md`,`L=engineering/doc/FLY-3224-real-runner-drill/progress.md`。

**交付 #1(无 "QA fix context")**
1. `BASE=$(git rev-parse HEAD)`。
2. 按 **HEAD 中的 blob** 判断:`git show HEAD:"$F" 2>/dev/null | cmp -s - <(printf 'QA-SBX FLY-3224 drill\nAWAITING-QA\n')` 退出码 0(未跟踪文件不算)→ **继承态 / 重试态**,跳过第 3–4 步(本轮派发时即如此,见 §2;也覆盖本节点上次已提交后中断重来);否则 **重置态**:`printf 'QA-SBX FLY-3224 drill\nAWAITING-QA\n' > "$F"`。
3. 自检工作树:`printf 'QA-SBX FLY-3224 drill\nAWAITING-QA\n' | cmp - "$F"` 退出码 0。
4. 只 `git add "$F"`,提交 `docs(qa-sbx): FLY-3224 drill hand-in`。
5. 冻结 `IMPL1=$(git rev-parse HEAD)`(继承态 / 重试态 `IMPL1=BASE`)。再从仓库根写 ledger:`node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" --file "$L" --phase implement --cursor 1/2 --next "<下一步>" --handoff "<本轮已知信息>"` —— 它**自行** path-limited 提交 `$L`,不要手动 add/commit;`git status --porcelain` 为空后才冻结 `HANDIN1=$(git rev-parse HEAD)`。
6. 核验:(a) **实现范围** `git diff --name-status $BASE..$IMPL1`:重置态恰好一行 `M "$F"`;继承态 / 重试态为空且 `git show $BASE:"$F"` 已逐字节等于 `AWAITING-QA` 两行;(b) 重置态下 `git diff $BASE..$IMPL1 -- "$F"` 的 patch 只改第 2 行(`-<BASE 第 2 行原值>` / `+AWAITING-QA`,本轮原值 `FIXED-FOR-CLAIM 1`);(c) **账本范围** `git diff --name-only $IMPL1..$HANDIN1` 为空或恰好 `"$L"`(继承态下必须恰好 `"$L"` —— 否则交付头仍是旧头,停下 ask),且 `git rev-list --merges $BASE..$HANDIN1` 为空;(d) §1 的 PR 级断言对 `$HANDIN1` 通过(本轮期望恰好一行 `"$F"`)。任一不过 → 停,不交付。
7. 推送并开 / 复用 PR(普通推送,不 force)。下面的块自包含、在子 shell 里 `set -eu`,任一命令失败即整块停止(不会带着失败继续改 PR);两次交付共用,只换开头两个变量:
   ```bash
   KIND=HANDIN1; HEADSHA="$HANDIN1"; NOTE='<本次第 6 步核验结果,逐条写 PASS>'
   (
     set -eu
     git push -u origin HEAD
     BODY=$(mktemp "${TMPDIR:-/tmp}/fly3224-pr-body.XXXXXX")
     printf '%s\n' '## Linear Issue' 'FLY-3224: https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only' '' "run=18c10fbd $KIND=$HEADSHA" '' "$NOTE" > "$BODY"
     TITLE='FLY-3224 QA-SBX FLY-3224 real-runner drill (run 18c10fbd)'
     PR=$(gh pr list --head project-slot-2-FLY-3224 --state open --json number --jq '.[0].number // empty')
     if [ -n "$PR" ]; then gh pr edit "$PR" --title "$TITLE" --body-file "$BODY"; else gh pr create --base main --head project-slot-2-FLY-3224 --title "$TITLE" --body-file "$BODY"; fi
     PR=$(gh pr list --head project-slot-2-FLY-3224 --state open --json number --jq '.[0].number')
     gh pr view "$PR" --json number,headRefOid
   )
   ```
   `NOTE` 的 `<…>` 占位要先替换成真实核验结果;标题与正文都不得含 skip-CI 标记。块退出码非 0 → 停,不交付。确认远端分支头 / PR 头(上面最后一行打印的 `headRefOid`;按 OPEN PR 号查 = #553,不会读到已合并的 #547)/ CI 都在 `$HANDIN1`,交付;**交付摘要写明 `run=18c10fbd HANDIN1=<完整 SHA>`**(返工唯一 PREV 来源)。

**交付 #2(提示词有 "QA fix context",首行 `QA verdict to fix: claim <id> ...`)**
1. 用 `^QA verdict to fix: claim (\S+)` 取 `ID`,原样复制;取不到 → 失败通道,不猜。
2. `PREV` = 本轮交付 #1 摘要里的 `HANDIN1`;确认它是 HEAD 的祖先,且 `git show $PREV:"$F"` 第 2 行是 `AWAITING-QA`;取不到 → 失败通道,不用 `git log` / progress 旧指针猜。`BASE2=$(git rev-parse HEAD)`,按 `git show $BASE2:"$F"` 分两态核验(区间无合并时):**初始态**(blob = `AWAITING-QA` 两行)→ `git diff --name-only $PREV..$BASE2` 为空或恰好 `"$L"`;**已修复态**(上次尝试已提交修复、ledger 前中断,blob 已逐字节等于 `QA-SBX FLY-3224 drill` / `FIXED-FOR-CLAIM $ID`)→ `$PREV..$BASE2` 只允许 `M "$F"` + 可选 `"$L"`,且 `git diff $PREV..$BASE2 -- "$F"` 的 patch 恰为 `-AWAITING-QA` / `+FIXED-FOR-CLAIM $ID`;其他任何内容(含别的 claim id)→ 失败通道。
3. 只改第 2 行:`printf 'QA-SBX FLY-3224 drill\nFIXED-FOR-CLAIM %s\n' "$ID" > "$F"`(已修复态跳过第 3–4 步);自检 `printf 'QA-SBX FLY-3224 drill\nFIXED-FOR-CLAIM %s\n' "$ID" | cmp - "$F"` 退出码 0。
4. 只 `git add "$F"`,提交 `docs(qa-sbx): FLY-3224 drill fix for claim $ID`。
5. 冻结 `IMPL2=$(git rev-parse HEAD)`(已修复态 `IMPL2=BASE2`),再写 ledger(同交付 #1 第 5 步命令,`--cursor 2/2`,handoff 可写 claim id 与 PREV),工作树干净后冻结 `HANDIN2=$(git rev-parse HEAD)`。
6. 核验:(a) `git diff --name-status $BASE2..$IMPL2`:初始态恰好一行 `M "$F"`,已修复态为空;(b) `git diff $PREV..$HANDIN2 -- "$F"` 的 patch 恰为 `-AWAITING-QA` / `+FIXED-FOR-CLAIM $ID`(这一步才是"返工确实发生"的证据);(c) `git diff --name-only $IMPL2..$HANDIN2` 为空或恰好 `"$L"`、无合并提交;(d) §1 的 PR 级断言对 `$HANDIN2` 通过(`ID` = `1` 时 PR 级演练 diff 为空是预期结果)。
7. 跑交付 #1 第 7 步的同一个块,开头改为 `KIND=HANDIN2; HEADSHA="$HANDIN2"; NOTE='claim <ID>; PREV=<PREV 完整 SHA>; <本次第 6 步核验结果>'`(占位先替换;块内会重新查询 PR、重建正文,不依赖第一次交付的 shell 变量)。块退出码非 0 → 停;确认远端 / PR / CI 都在 `$HANDIN2`,交付。

通则:核验后若又产生提交(含 ledger),重新冻结 SHA、核验、推送。commit message 与 PR 标题不得含 `[skip ci]` / `[ci skip]` / `[no ci]` / `[skip actions]` / `[actions skip]` / `skip-checks:`(仓库历史里有,不可模仿)。不 force-push。ledger 的 `--handoff` 只写写入时已确定的信息(run id、阶段、claim id、返工时已知的 PREV),**不写本次最终交付头**(ledger 自提交会改变 HEAD);最终 `HANDIN1` / `HANDIN2` 只写在交付摘要里。

### 3.1 发生 main 同步时的核验分支

- **何时同步**:只在 PR 显示 `CONFLICTING` 或节点契约明确要求时;同步 = `git fetch origin main && git merge origin/main`(不 rebase、不 force-push)。
- **冲突处理**:冲突只允许落在 `engineering/doc/FLY-3224-real-runner-drill/` 内 —— 对冲突路径只做保留本轮 slot-2 版本的必要解决(`git checkout --ours -- <path>`),不对其他设计文档做任何附加编辑(守住 §1 "除 progress.md 外不修改"的边界);同步来源(`origin/main` SHA)与冲突路径记进 `progress.md` 的 `--handoff`(不丢弃信息),交付摘要注明发生过同步。冲突落在该文件夹之外(含 `"$F"`)→ `git merge --abort`,走失败通道。
- **判定**:交付区间(交付 #1 `$BASE..$HANDIN1`,交付 #2 `$PREV..$HANDIN2`)里 `git rev-list --merges <区间>` 非空 → 用下面的核验**替代**交付 #1 第 6(a)(b)(c) 步、交付 #2 第 2 步的交付间范围与第 6(a)(c) 步;为空 → 仍用原限制。
- **同步后的核验**(工作树干净、所有提交含 ledger 之后才冻结 HANDIN):交付 #1 —— §1 的 PR 级断言对 `$HANDIN1` 通过,且 `git show $HANDIN1:"$F"` 逐字节等于 `AWAITING-QA` 两行;交付 #2 —— `PREV` 不变(照旧做祖先检查),`git diff $PREV..$HANDIN2 -- "$F"` 的 patch 恰为 `-AWAITING-QA` / `+FIXED-FOR-CLAIM $ID`,§1 的 PR 级断言对 `$HANDIN2` 通过,`git show $HANDIN2:"$F"` 逐字节等于两行。推送后照旧确认三处头一致;交付摘要注明发生过同步。

## 4. QA 节点

分轮只看提示词有没有 "QA re-verification context"。

| criterion | 第 1 轮 | 重验轮 |
|---|---|---|
| `file-shape` | 文件存在且第 1 行 = `QA-SBX FLY-3224 drill` | 同左 |
| `fixed-for-claim` | 恒 `fail`,evidence `round 1: no previous QA claim yet` | 第 2 行 = `FIXED-FOR-CLAIM <id>`(id 取自 `Previous QA verdict: claim <id>`)才 `pass`;取不到 id → 失败通道,不得 pass |
| `e2e_529_exempt` | `not_run`,`exempt_category: docs_only`,reason `Markdown-only drill; no room deployment` | 同左 |

title < 120 字符,evidence < 80 字符;QA 不部署房间、不碰 Linear、不改目标文件。QA 读的是交付头上的 `"$F"`(不是 main 上的残留)。

## 5. 流程

```mermaid
sequenceDiagram
    participant I as eng_implement
    participant Q as qa
    participant B as 驱动器
    B->>I: 派发(无 QA fix context)
    I->>B: 交付 #1:继承的 AWAITING-QA 原样保留,只加 ledger 提交,复用 PR 553
    B->>Q: 第 1 轮
    Q->>B: fixed-for-claim = fail(planted),产生 claim <id>
    B->>I: QA fix context: claim <id>
    I->>B: 交付 #2:FIXED-FOR-CLAIM <id>
    B->>Q: 重验(Previous QA verdict: claim <id>)
    Q->>B: 逐字匹配 → pass
```

## 查询与索引

不适用:本演练只改一个两行 markdown 文件,不新增或修改任何表、查询或索引。

## 6. 诚实边界

只覆盖 README 的两行文件 + 三条验收,证明 529 房间里真 Runner 的 fail → fix → re-verify 回路能贯通 claim id;不设计任何 Flywheel 代码,不验证生产实现。设计节点不推演练文件、不开 PR、不跑 CI —— 由实现节点交付时核验。回滚 = revert 本轮提交。
