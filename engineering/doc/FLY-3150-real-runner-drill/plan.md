# FLY-3150 真 Runner 泛化演练（529 Room，第二轮运行）— 实施计划

Issue: FLY-3150 (https://linear.app/geoforge3d/issue/FLY-3150/qa-sbx-fly-2167-real-runner-generalized-drill-529-room-only)
日期: 2026-10-01
基于: exploration.md（README 明示"No research document"，故无 research.md）

## 0. 一句话

implement 节点把当前分支上**已存在**的唯一文件 `qa-sbx/fly2167/project-slot-5-FLY-3150.md`
第 2 行覆写为 `AWAITING-QA` 后 hand-in；QA 节点按 README 三条准则判定，第一轮对 `fixed-for-claim` 必败是**设计内**的；
第二次 implement 用**本轮** QA 给的 claim id 回写第 2 行；QA 第二轮精确匹配通过。

## 1. 范围与不变量

- **唯一改动文件**：`qa-sbx/fly2167/project-slot-5-FLY-3150.md`。
  文件名取 `git branch --show-current` 的实时输出；若输出不是 `project-slot-5-FLY-3150`，以实时输出为准。
- **起点状态**（与上一轮不同）：该文件在当前分支和 `origin/main` 上都已存在，内容为
  `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`（上一轮 PR #435 遗留）。本轮不新建，只覆写第 2 行。
- **不碰**：Linear issue（状态/评论/标签）、任何 529 Room 部署、仓库其他文件、`qa-sbx/fly2167/README.md`。
- **不**写代码、不加测试文件、不改 CI 配置。
- 设计文件夹 `engineering/doc/FLY-3150-real-runner-drill/` 下只有 `exploration.md`、`plan.md`、`progress.md`、
  创始人 HTML 及其 Mermaid 源（`.mmd` + `.svg`）；无 research.md。
- **分支同步已完成**：远端同名分支与 `origin/main` 均已 merge 进本地（exploration §3），后续 push 都是 fast-forward。
  任何节点**不得** force-push；若再出现 non-fast-forward，先 `git merge origin/<branch>` 再推。

## 2. implement 节点步骤（第一次 hand-in）

1. `turn` 返回 `yours` 后再动工作区；`git pull --ff-only` 确认与远端一致。
2. `BRANCH=$(git branch --show-current)`；断言非空；`F=qa-sbx/fly2167/$BRANCH.md`。
3. 覆写文件（精确两行，末尾一个换行符，无 BOM、无尾随空格）：
   ```
   QA-SBX FLY-2167 drill
   AWAITING-QA
   ```
4. 自检：`wc -l` 为 2；`sed -n 1p` 逐字等于 `QA-SBX FLY-2167 drill`；`sed -n 2p` 逐字等于 `AWAITING-QA`；
   `git diff --stat` 只有这一个文件、只有第 2 行变化。
5. 提交信息：`docs(qa-sbx): FLY-3150 drill hand-in`。
   **禁止** `[skip ci]` `[ci skip]` `[no ci]` `[skip actions]` `[actions skip]` 及 `skip-checks:` trailer。
6. 推分支、开 PR（base `main`；标题同样不得含上述 skip 标记）。PR diff 对 main 的预期：
   drill 文件第 2 行 `FIXED-FOR-CLAIM 1` → `AWAITING-QA`，加上本轮设计文档的更新。
7. CI 必须跑在**本次精确 head** 上：记录 `git rev-parse HEAD`，确认对应 CI run 的 head SHA 一致。
   若未触发或无法核验，在协议回执里如实写明，不得拿旧 head 的 CI 记录顶替。README 只要求 CI 运行，
   不额外引入"必须全绿"、本地测试套件或房间部署。

## 3. implement 节点步骤（第二次尝试：有 "QA fix context"）

触发条件：prompt 含 "QA fix context"，其首行形如 `QA verdict to fix: claim <id> ...`。

1. 从该首行解析 `<id>`：取 `claim ` 之后到下一个空白为止的 token，**逐字保留**（不改大小写、不去前后缀）。
   解析失败（没有 `claim ` 或 token 为空）→ 不要猜，按协议 `complete --route blocked` 并给出原因。
   **禁止**回退到 main 上残留的旧 id `1`——它属于上一轮运行，与本轮 QA claim 无关。
2. 第 2 行改为 `FIXED-FOR-CLAIM <id>`；第 1 行不动；文件仍恰两行。
3. 自检（**替换** §2.4 的第 2 行检查）：`wc -l` 为 2；`sed -n 1p` 逐字等于 `QA-SBX FLY-2167 drill`；
   `sed -n 2p` 逐字等于 `FIXED-FOR-CLAIM <id>`。此轮第 2 行不应再是 `AWAITING-QA`。
4. 提交信息：`docs(qa-sbx): FLY-3150 drill fix for claim <id>`（同样禁 skip 标记）。
5. 推分支、hand-in。
6. 同 §2.7：CI 必须跑在修复轮的新 head 上；上一轮提交的 CI 记录不能覆盖新 head。

## 4. QA 节点判定规则

准则 id 必须**精确**使用下列三个；每条 title < 120 字符，每条 evidence < 80 字符。

| 准则 id | 第一轮（prompt 无 "QA re-verification context"） | 再验证轮 |
|---|---|---|
| `file-shape` | 文件存在且第 1 行逐字 `QA-SBX FLY-2167 drill` → pass；否则 fail | 同左 |
| `fixed-for-claim` | **恒为 fail**，evidence 逐字 `round 1: no previous QA claim yet` | 从 prompt `Previous QA verdict: claim <id>` 取 `<id>`；第 2 行逐字 `FIXED-FOR-CLAIM <id>` → pass；否则 fail |
| `e2e_529_exempt` | status `not_run`，`exempt_category: docs_only`，附一句理由（如 `docs-only sandbox markdown; no room deploy`） | 同左 |

负向守卫：
- 第一轮即使第 2 行是 `FIXED-FOR-CLAIM ...`（本轮起点就是 `FIXED-FOR-CLAIM 1`），`fixed-for-claim` 仍 fail（植入规则优先）。
- 再验证轮 `<id>` 比较是**逐字**比较，大小写、多余空格都算不匹配；`FIXED-FOR-CLAIM 1` 对本轮新 id 不匹配。
- QA 永不运行 529 Room 部署；`e2e_529_exempt` 就是为此留的记录位。

## 5. 回滚与失败边界

- 回滚 = `git revert` 该 hand-in 提交；无迁移、无状态。
- 任一节点若发现 README 与 `origin/main` 不一致，以 `origin/main` 版本为准重读。
- 远端分支再次分叉时只允许 merge 同步，不允许 force-push（FORCE-PUSH GUARD）。
- 房间无人类 Lead：不发提问；只发协议要求的结构化回执。

## 6. 测试证据（设计节点能给的）

- README 与 `origin/main` 逐字一致。
- 目标文件当前存在，内容为 `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`（`git show origin/main:qa-sbx/fly2167/project-slot-5-FLY-3150.md`）。
- 本地 HEAD 包含 `origin/project-slot-5-FLY-3150` 与 `origin/main`（`git merge-base --is-ancestor` 均为真）。
- 验收脚本思路（QA 节点可直接用）：
  ```sh
  f=qa-sbx/fly2167/$(git branch --show-current).md
  test -f "$f" && [ "$(sed -n 1p "$f")" = "QA-SBX FLY-2167 drill" ]   # file-shape
  [ "$(wc -l < "$f")" -eq 2 ]                                          # 两行
  [ "$(sed -n 2p "$f")" = "FIXED-FOR-CLAIM $ID" ]                      # 再验证轮，$ID 来自本轮 prompt
  ```

## 7. 被否决的替代方案

- **force-push 重置远端分支**：否决。FORCE-PUSH GUARD 要求 Lead 显式确认；房间无人类 Lead，且 merge 同步已能让 push 变 fast-forward。
- **在设计节点就把第 2 行改成 `AWAITING-QA`**：否决。README 把它归为 implement 产物；设计节点越界会让演练测不到 implement 节点真实落盘。
- **写 research.md 凑齐三件套**：否决。README 明示"No research document"，任务指令要求逐字遵守 README。
- **用正则宽松匹配 claim id / 复用旧 id `1`**：否决。QA 只在精确匹配时通过，宽松匹配或沿用旧 id 会掩盖 id 传递链的 bug，而那正是演练要抓的。
