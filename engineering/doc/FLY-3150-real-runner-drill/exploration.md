# FLY-3150 真 Runner 通用演练(529 房间) — 探索

Issue: FLY-3150 (https://linear.app/geoforge3d/issue/FLY-3150/qa-sbx-fly-2167-real-runner-generalized-drill-529-room-only)
日期: 2026-10-01
基于: 无

## 1. 任务来源与唯一权威

- 任务全文 = 沙盒仓库 `origin/main` 上的 `qa-sbx/fly2167/README.md`(commit `7df383e6f`)。
- README 明确:无代码;只碰一个 markdown 文件;"一份短 plan 足够,不需要 research 文档";房间没有人类 Lead,不要问 Lead。
- 本 issue 是 FLY-2167 演练夹具,只存在于 `xrliAnnie/flywheel-qa-sandbox` 的 drill 分支;Linear 状态保持 Canceled,设计/实现/QA 节点都不得改动 issue。

## 2. 当前仓库状态审计

| 项 | 结果 |
|---|---|
| 分支 | `project-slot-1-FLY-3150`(`git branch --show-current`) |
| 与 `origin/main` 差异 | 零(分支头 = main 头 `7df383e6f`) |
| `qa-sbx/fly2167/` 内容 | 仅 `README.md`;目标文件 `qa-sbx/fly2167/project-slot-1-FLY-3150.md` 尚不存在 |
| TURN | `yours phase=design epoch=1`(本节点持有共享 worktree 写权) |
| 收件箱 | 无 Lead 指令 |
| 本机 `mmdc` | 11.12.0 可用(设计 HTML 图表本地渲染) |

同类历史分支(`qa529-FLY-3143/3163/3170`)是 stub-runner 夹具(`doc/<ISSUE>-generalized-e2e/design.html` 11 行 + fixture md),不是真 Runner 产物,不能当模板;本次按真 Runner 的 DOC-FLOW 产出。

## 3. 交付物边界(来自 README,逐条对照)

**实现节点要写的文件** `qa-sbx/fly2167/project-slot-1-FLY-3150.md`,恰好两行:

1. `QA-SBX FLY-2167 drill`
2. 首次交付 `AWAITING-QA`;当提示词含 "QA fix context" 且首行为 `QA verdict to fix: claim <id> ...` 时改为 `FIXED-FOR-CLAIM <id>`(同一 id),其余不变。

**QA 节点验收标准**(criterion id 固定):

- `file-shape`:文件存在且第 1 行精确等于 `QA-SBX FLY-2167 drill`。
- `fixed-for-claim`:第 1 轮(提示词无 "QA re-verification context")**必定** `fail`,evidence 为 `round 1: no previous QA claim yet`;重验轮只有第 2 行精确等于 `FIXED-FOR-CLAIM <id>`(id 来自 `Previous QA verdict: claim <id>`)才 `pass`。
- `e2e_529_exempt`:`not_run`,`exempt_category: docs_only` + 原因;绝不部署房间。

**提交纪律**:commit message / PR 标题禁止 `[skip ci]`、`[ci skip]`、`[no ci]`、`[skip actions]`、`[actions skip]`、`skip-checks:` trailer(仓库历史里有,不可模仿);用平实消息如 `docs(qa-sbx): FLY-3150 drill hand-in`,CI 必须在交付头上跑。

## 4. 本演练在验证什么(为什么要"故意失败")

演练目标是 FLY-2167 的真 Runner 通用回路:**实现 → QA 判 fail(带 claim id)→ 实现带着 QA 修复上下文返工 → QA 重验精确匹配 claim id 才通过**。所以第 1 轮 `fixed-for-claim` 的失败是设计出来的触发器,不是缺陷;真正被测的是 claim id 从 QA 判定 → 返工提示词 → 文件第 2 行 → 重验的**逐字贯通**。

## 5. 歧义与决策

| 歧义 | 决策 | 理由 |
|---|---|---|
| DOC-FLOW full 档要求 research.md,README 说不要 research 文档 | 不写 research.md;产出 exploration.md + plan.md | README 是本任务的唯一权威,且"follow it exactly";exploration 是审计记录,不是 research |
| 设计 HTML 放哪 | `engineering/doc/FLY-3150-real-runner-drill/design.html` | DOC-FLOW 指定 `engineering/doc/FLY-3150-<slug>/`;`complete` 的匹配规则 `(^|/)doc/FLY-3150(-<slug>)?/*.html` 能命中 |
| 是否问 Lead | 不问 | README:房间无人类 Lead,一切都在 README 里 |
| Linear issue | 不动 | README + issue 描述双重禁止 |

## 6. 不做的事

- 不写代码、不改 README、不改任何非目标文件。
- 不部署 / 不拆 529 房间。
- 不在设计节点创建目标 md 文件(那是实现节点的工作)。
