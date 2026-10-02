# FLY-3150 真 Runner 泛化演练（529 Room）— 探索

Issue: FLY-3150 (https://linear.app/geoforge3d/issue/FLY-3150/qa-sbx-fly-2167-real-runner-generalized-drill-529-room-only)
日期: 2026-10-01
基于: 无

## 1. 这张票是什么

FLY-3150 不是功能票，而是 FLY-2167 驱动器在 529 QA Room 里跑的一次"真 Runner 泛化演练"。
被测对象是 Flywheel 的 DAG 流水线本身（design → implement → qa → QA 修复回路），
不是任何业务代码。沙箱仓库 `xrliAnnie/flywheel-qa-sandbox` 只是载体。

任务的唯一权威来源是沙箱 `main` 上的 `qa-sbx/fly2167/README.md`。
本次读取的 README 与 `origin/main` 逐字一致（已 diff 核对，无差异）。

## 2. README 对每个节点的硬规则（逐条摘录）

| 规则 | 含义 | 本设计节点如何遵守 |
|---|---|---|
| 不改 Linear issue | 不改状态、不评论、不打标签 | 本节点不调用任何 Linear 写操作（本会话 Linear MCP 本就 401 未连接，顺带确保零写入） |
| 不从演练内部部署 529 Room | 永不触碰 `test-deploy.sh` 等 | 设计里无任何部署步骤 |
| 没有代码，只碰一个 markdown | 实现产物仅 `qa-sbx/fly2167/<branch>.md` | 实现范围锁定为单文件；设计文档落 `engineering/doc/`（DOC-FLOW 要求，不属"实现产物"） |
| 设计只要一份短 plan，不要 research 文档 | 设计阶段产物最小化 | 本文件夹只有 exploration.md + plan.md，**不写 research.md** |
| 提交信息禁止 `[skip ci]` 等 | hand-in 的 head 必须跑 CI | 本节点所有 commit 用 `docs(qa-sbx): FLY-3150 ...` 形式 |
| 房间没有人类 Lead，不要问 | 一切答案都在 README | 不发 `ask` 提问；只发协议要求的 `--report` 回执 |

## 3. 实现产物的精确形态

文件路径：`qa-sbx/fly2167/project-slot-5-FLY-3150.md`
（`git branch --show-current` 当前输出 `project-slot-5-FLY-3150`）。

文件恰好两行：

```
QA-SBX FLY-2167 drill
AWAITING-QA
```

第二次 hand-in（prompt 带 "QA fix context"，首行 `QA verdict to fix: claim <id> ...`）时，
第二行改为 `FIXED-FOR-CLAIM <id>`，`<id>` 与 prompt 中逐字相同，其余不动。

## 4. 植入的必败点（演练目的）

QA 第一轮对 `fixed-for-claim` 这条准则**必定 fail**，证据固定为
`round 1: no previous QA claim yet`。这不是 bug，是演练刻意制造的"QA 打回"，
用来验证流水线能否：把 QA claim id 带进 implement 第二次尝试 → implement 按 id 写回
→ QA 第二轮用 `Previous QA verdict: claim <id>` 精确匹配通过。

## 5. 仓库现状审计

- 当前分支 `project-slot-5-FLY-3150`，head `7df383e6f`，工作区干净。
- `qa-sbx/fly2167/` 目前只有 `README.md`，目标文件尚不存在。
- `engineering/doc/` 下无 `FLY-3150-` 前缀文件夹，本次新建 `FLY-3150-real-runner-drill/`。
- 仓库历史里大量 `[skip ci]` 提交，README 明示那不是风格指南。

## 6. 本节点的边界

- 只产出设计文档 + 进度账本 + 创始人 HTML，**不**创建 `qa-sbx/fly2167/<branch>.md`（那是 implement 节点的事）。
- 不派发后继节点、不请求 ship、不 merge。
- 需要澄清的点：无。README 已把每个判定点写成可机械执行的规则。
