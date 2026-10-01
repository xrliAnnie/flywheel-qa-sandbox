# FLY-3150 QA-SBX FLY-2167 演练 — 实施计划
Issue: FLY-3150 (https://linear.app/geoforge3d/issue/FLY-3150/qa-sbx-fly-2167-real-runner-generalized-drill-529-room-only)
日期: 2026-10-01
基于: 无

> 唯一任务来源:sandbox `main` 上的 `qa-sbx/fly2167/README.md`(下称 README)。
> README 明确「one short plan is enough. No research document.」,所以本文件夹只有这一份计划
> (外加流程要求的 `progress.md` 游标和 founder HTML),不写 exploration / research。

## 1. 一句话

在共享分支上新增**一个**两行的 markdown 文件,先交 `AWAITING-QA`,第一轮 QA 按设计必然打回,
第二次只把第 2 行改成 `FIXED-FOR-CLAIM <claim id>`,QA 复验逐字匹配后通过。没有代码。

## 2. 范围

| 项 | 值 |
|----|----|
| 唯一交付文件 | `qa-sbx/fly2167/<分支名>.md`,分支名用 `git branch --show-current` 现取(本次为 `project-slot-1-FLY-3150` → `qa-sbx/fly2167/project-slot-1-FLY-3150.md`) |
| 代码改动 | 无 |
| 持久化 / 迁移 | 无 |
| 外部副作用 | 无(不动 Linear、不部署 529 room) |

设计节点自己的产物只落在 `engineering/doc/FLY-3150-qa-sbx-drill/`(`plan.md`、`progress.md`、founder HTML 及其 Mermaid 源),
它们在设计阶段已提交,实现节点**不得**修改其中任何一个。

**实现节点的改动范围 = 且仅 = 上表那一个文件**(首交和返工都一样)。本计划不为任何其他文件开例外,
也不把任何文件归类成「可以顺手改的流程文档」来扩大 README 的授权。

## 3. 文件内容合同(唯一真相 = README)

文件恰好两行,每行以 LF 结尾,无 BOM、无行尾空格、无第三行(`wc -l` = 2)。

| 行 | 第一次交付(attempt 1) | 返工交付(attempt 2) |
|----|------------------------|----------------------|
| 1 | `QA-SBX FLY-2167 drill` | 不变 |
| 2 | `AWAITING-QA` | `FIXED-FOR-CLAIM <id>` |

`<id>` 的来源只有一个:实现节点 prompt 里 **"QA fix context"** 的第一行
`QA verdict to fix: claim <id> ...` 中紧跟 `claim ` 的那个 token(到下一个空白为止),**逐字复制**,
不改大小写、不截断、不从别处(Linear、git log、QA 报告文件、记忆)推导。

判定规则(实现节点):

1. prompt 没有 "QA fix context" → 第一次交付,第 2 行写 `AWAITING-QA`。
2. prompt 有 "QA fix context" 且第一行匹配 `QA verdict to fix: claim <id> ...` → 第 2 行写 `FIXED-FOR-CLAIM <id>`,**其他什么都不改**。
3. 有 "QA fix context" 但第一行解析不出 `<id>` → fail-closed:不猜,用 `flywheel-comm ask` 问 Lead 后停在原状。

写入方式(避免编辑器加料):

```bash
f="qa-sbx/fly2167/$(git branch --show-current).md"
printf 'QA-SBX FLY-2167 drill\nAWAITING-QA\n' > "$f"            # attempt 1
printf 'QA-SBX FLY-2167 drill\nFIXED-FOR-CLAIM %s\n' "$id" > "$f" # attempt 2
```

## 4. 流程

```mermaid
flowchart TD
    A[设计节点: 本计划 + 设计评审] --> B[实现 attempt 1<br/>第2行 = AWAITING-QA]
    B --> C{QA 第 1 轮}
    C -->|file-shape: pass<br/>fixed-for-claim: 必 fail| D[QA 裁决 claim id]
    D --> E[实现 attempt 2<br/>prompt 带 QA fix context<br/>第2行 = FIXED-FOR-CLAIM id]
    E --> F{QA 复验<br/>prompt 带 QA re-verification context}
    F -->|第2行与 Previous QA verdict 的 claim id 逐字相等| G[pass]
    F -->|不相等| H[fail → 再返工]
```

## 5. 实现步骤(实现节点照做)

1. `turn` 自检为 `yours` 后才动工作树;`git branch --show-current` 取分支名。
2. 按 §3 判定是 attempt 1 还是 attempt 2,用 `printf` 写文件。
3. 自验(证据贴进交付报告):
   - `wc -l < "$f"` → `2`
   - `sed -n 1p "$f"` → `QA-SBX FLY-2167 drill`
   - `sed -n 2p "$f"` → `AWAITING-QA` 或 `FIXED-FOR-CLAIM <id>`
   - `git status --porcelain` **只**出现这一个文件,没有任何例外;出现第二个路径就停下,先还原多余改动再交付
   - 返工时再加一条:`git diff HEAD -- "$f"` 只有第 2 行一处变更
4. 提交:`test(QA-SBX FLY-2167): drill file <AWAITING-QA|FIXED-FOR-CLAIM id> [skip ci]`,push 到共享分支。
5. 交付 / PR / 完成路由按实现节点自己被注入的协议走,本计划不另行规定。

## 6. QA 验收(QA 节点照做,criterion id 必须逐字使用)

| criterion id | 第 1 轮(prompt 无 "QA re-verification context") | 复验轮 |
|--------------|-----------------------------------------------|--------|
| `file-shape` | 文件存在且第 1 行恰为 `QA-SBX FLY-2167 drill` → pass | 同左 |
| `fixed-for-claim` | **永远 `fail`**,evidence 固定为 `round 1: no previous QA claim yet`(这是演练埋的雷,不是缺陷) | 仅当第 2 行恰为 `FIXED-FOR-CLAIM <id>` 且 `<id>` 取自 `Previous QA verdict: claim <id>` 时 pass |
| `e2e_529_exempt` | status `not_run`,`exempt_category: docs_only`,附 reason;**绝不部署 room** | 同左 |

每条 title < 120 字符,evidence < 80 字符。

## 7. 负向护栏

- 不改 Linear issue:不改状态(保持 Canceled)、不评论、不加标签。
- 不在演练里部署 QA room(529 room)。
- 不改 `qa-sbx/fly2167/README.md`,不碰其他任何文件、任何代码。
- 第一轮 QA 的 fail 是预期行为:实现节点不得为了「一次过」提前写 `FIXED-FOR-CLAIM`,QA 节点不得在第一轮放行。
- 不 merge、不请求 ship 批准、不 force-push。

## 8. 回滚

纯新增一个文档文件,无状态、无迁移。回滚 = `git revert` 对应提交(或删掉该文件),对任何运行中的系统零影响。

## 9. 测试证据

无单元测试可写(无代码)。证据 = §5 第 3 步的四条命令输出 + QA 节点两轮的 `qa-criteria/v1` 结果
(第 1 轮 `fixed-for-claim: fail`,复验轮全 pass,`e2e_529_exempt: not_run/docs_only`)。
