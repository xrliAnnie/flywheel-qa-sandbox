# FLY-3150 真 Runner 泛化演练（529 Room，第二轮运行）— 探索

Issue: FLY-3150 (https://linear.app/geoforge3d/issue/FLY-3150/qa-sbx-fly-2167-real-runner-generalized-drill-529-room-only)
日期: 2026-10-01
基于: 无

## 1. 这张票是什么

FLY-3150 不是功能票，而是 FLY-2167 驱动器在 529 QA Room 里跑的"真 Runner 泛化演练"。
被测对象是 Flywheel 的 DAG 流水线本身（design → implement → qa → QA 打回 → implement 修复 → qa 再验证），
不是任何业务代码。沙箱仓库 `xrliAnnie/flywheel-qa-sandbox` 只是载体。

任务的唯一权威来源是沙箱 `main` 上的 `qa-sbx/fly2167/README.md`。
本次工作区中的 README 与 `origin/main`（`568e55e27`）逐字一致。

## 2. README 对每个节点的硬规则（逐条摘录）

| 规则 | 含义 | 本设计节点如何遵守 |
|---|---|---|
| 不改 Linear issue | 不改状态、不评论、不打标签 | 不调用任何 Linear 写操作（本会话 Linear MCP 本就 401 未连接） |
| 不从演练内部部署 529 Room | 永不触碰 `test-deploy.sh` / `room deploy` | 设计里无任何部署步骤 |
| 没有代码，只碰一个 markdown | 实现产物仅 `qa-sbx/fly2167/<branch>.md` | 实现范围锁定为单文件；设计文档落 `engineering/doc/`（DOC-FLOW 要求，不属"实现产物"） |
| 设计只要一份短 plan，不要 research 文档 | 设计阶段产物最小化 | 本文件夹只有 exploration.md + plan.md + progress.md + 创始人 HTML，**不写 research.md** |
| 提交信息禁止 `[skip ci]` 等 | hand-in 的 head 必须跑 CI | 所有 commit 用 `docs(qa-sbx): FLY-3150 ...` / `chore: ...` 形式，无 skip 标记 |
| 房间没有人类 Lead，不要问 | 一切答案都在 README | 不发 `ask` 提问；只发协议要求的 `--report` 回执 |

## 3. 本轮与上一轮运行的关键差异（仓库现状审计）

这是 FLY-3150 在 slot-5 的**第二次**演练运行（TURN `epoch=6`，run `ad98df54`）。上一轮已经完整跑完：
design → implement（`AWAITING-QA`）→ QA 打回 claim `1` → implement 修复（`FIXED-FOR-CLAIM 1`）→ PR #435 squash 合入 main。

审计发现（全部已核实）：

- `origin/main` 为 `568e55e27`（PR #435），**已包含**目标文件 `qa-sbx/fly2167/project-slot-5-FLY-3150.md`，
  内容为 `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`，以及上一轮的整套设计文档文件夹。
- 远端同名分支 `origin/project-slot-5-FLY-3150` 仍保留上一轮的 6 个 commit（未清理），
  而本 worktree 从 `7df383e6f`（PR #435 的父提交）新建，两者**分叉**。
- 直接 push 会是 non-fast-forward → 触发 FORCE-PUSH GUARD。

处置（已执行，纯技术 sync，不需要 ship 审批）：
1. `git merge origin/project-slot-5-FLY-3150`（与自己分支的远端同步）；
2. `git merge origin/main`；
3. 两次 merge 唯一冲突都是 `progress.md`（add/add），均保留本轮账本；
4. 之后 push 为 fast-forward，远端分支成为本地 HEAD 的祖先。

后果：本轮 implement 节点面对的不是"新建文件"，而是"文件已存在、第 2 行是上一轮的 `FIXED-FOR-CLAIM 1`"。
README 说第一次 hand-in 第 2 行必须是 `AWAITING-QA`，所以 implement 第一次 hand-in = **覆写**第 2 行。
上一轮的 claim id `1` 对本轮没有任何效力，不得沿用。

## 4. 实现产物的精确形态

文件路径：`qa-sbx/fly2167/project-slot-5-FLY-3150.md`
（`git branch --show-current` 当前输出 `project-slot-5-FLY-3150`；implement 节点必须实时取，不得硬编码）。

第一次 hand-in，文件恰好两行：

```
QA-SBX FLY-2167 drill
AWAITING-QA
```

第二次 hand-in（prompt 带 "QA fix context"，首行 `QA verdict to fix: claim <id> ...`）：
第 2 行改为 `FIXED-FOR-CLAIM <id>`，`<id>` 与本轮 QA 给的逐字相同，其余不动。

## 5. 植入的必败点（演练目的）

QA 第一轮对 `fixed-for-claim` 这条准则**必定 fail**，evidence 固定为 `round 1: no previous QA claim yet`。
这不是 bug，是演练刻意制造的"QA 打回"，用来验证流水线能否把 QA claim id 带进 implement 第二次尝试 →
implement 按 id 写回 → QA 第二轮用 `Previous QA verdict: claim <id>` 精确匹配通过。

本轮的额外验证点：main 上残留的 `FIXED-FOR-CLAIM 1` 不能让 QA 第一轮误判为 pass（植入规则优先于文件内容），
也不能让 implement 第二次尝试偷懒复用旧 id。

## 6. 本节点的边界

- 只产出设计文档 + 进度账本 + 创始人 HTML，**不**改 `qa-sbx/fly2167/<branch>.md`（那是 implement 节点的事）。
- 不派发后继节点、不请求 ship、不 merge。
- 需要澄清的点：无。README 已把每个判定点写成可机械执行的规则；分支分叉已用非破坏方式解决。
