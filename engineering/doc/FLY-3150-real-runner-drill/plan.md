# FLY-3150 真 Runner 通用演练(529 房间) — 实施计划

Issue: FLY-3150 (https://linear.app/geoforge3d/issue/FLY-3150/qa-sbx-fly-2167-real-runner-generalized-drill-529-room-only)
日期: 2026-10-01
基于: exploration.md(README 规定"一份短 plan 足够,不需要 research 文档",故无 research.md)

## 0. 一句话

实现节点在分支 `project-slot-1-FLY-3150` 上创建 `qa-sbx/fly2167/project-slot-1-FLY-3150.md`(恰好两行),QA 节点第 1 轮按 README 必判 `fixed-for-claim` 失败,实现节点带 claim id 返工改第 2 行,QA 重验逐字匹配才通过 —— 全程不碰代码、不碰 Linear、不部署房间。

## 1. 唯一权威与范围

- 权威:`qa-sbx/fly2167/README.md`(`origin/main` @ `7df383e6f`)。每个节点开工先重读它。
- 范围:**只有一个文件** `qa-sbx/fly2167/project-slot-1-FLY-3150.md`。文件名 = `git branch --show-current` 的输出 + `.md`。
- 禁区:README、任何代码、Linear issue(状态/评论/标签)、529 房间部署/拆除。

### 1.1 两套契约的边界(README 范围 vs 节点契约产物)

README 管的是**演练内容**:`qa-sbx/` 下只许动 `qa-sbx/fly2167/project-slot-1-FLY-3150.md` 这一个文件。
Runner 另受 Flywheel DAG **节点契约**(派发提示词注入的 DOC-FLOW / PROGRESS LEDGER / 设计 HTML 规则)约束,它要求的产物**全部**落在 `engineering/doc/FLY-3150-real-runner-drill/` 这一个文件夹内,与 `qa-sbx/` 互不重叠:

| 产物 | 来源契约 | 路径 | 谁写 |
|---|---|---|---|
| `exploration.md` / `plan.md` / `design.html`(+ `*.mmd`/`*.svg`) | 节点契约(设计节点) | `engineering/doc/FLY-3150-real-runner-drill/` | eng_design |
| `progress.md` | 节点契约(每个节点的进度账本,由 `flywheel-comm progress` 单独路径限定提交) | 同上 | 每个节点 |
| `qa-sbx/fly2167/project-slot-1-FLY-3150.md` | README | `qa-sbx/fly2167/` | eng_implement |

规则:README 范围内(`qa-sbx/**`)只允许目标文件;节点契约产物只允许出现在上述文件夹;两者之外任何路径出现在 diff 都是违规。README 的"只碰一个 markdown 文件"在本计划中解释为"演练内容只碰一个文件",节点契约产物不算演练内容,也不会被 QA 的三条 criterion 评估。

## 2. 实现节点(eng_implement)步骤

### 2.1 第 1 次交付(提示词**没有** "QA fix context")

1. 重读 `origin/main:qa-sbx/fly2167/README.md`;确认 TURN `yours`。
2. 写文件(精确两行,末尾一个换行,无 BOM、无尾随空格):
   ```
   QA-SBX FLY-2167 drill
   AWAITING-QA
   ```
3. 自检(字节级,`wc -l`/`sed` 不够 —— 未终止的第三行能骗过它们):
   ```
   printf 'QA-SBX FLY-2167 drill\nAWAITING-QA\n' | cmp - qa-sbx/fly2167/project-slot-1-FLY-3150.md
   ```
   `cmp` 必须零输出、退出码 0。再记录接手时的基准 SHA `BASE=$(git rev-parse HEAD)`(在创建文件之前取),交付前核验 `git diff --name-status $BASE..HEAD` 只有 `A qa-sbx/fly2167/project-slot-1-FLY-3150.md`,外加 `engineering/doc/FLY-3150-real-runner-drill/progress.md` 的 ledger 提交;其他任何路径 → 停止修正。
4. 提交:`docs(qa-sbx): FLY-3150 drill hand-in`。**禁止** `[skip ci]` / `[ci skip]` / `[no ci]` / `[skip actions]` / `[actions skip]` / `skip-checks:` trailer,PR 标题同理。推送后 CI 必须在交付头 SHA 上运行。
5. 用 `flywheel-comm progress` 更新账本(它只提交 progress.md),再按节点完成契约交付(PR 标题同样不得含跳过 CI 标记)。交付摘要里写明 `BASE` 与交付头 SHA。

### 2.2 第 2 次交付(提示词含 "QA fix context",首行 `QA verdict to fix: claim <id> ...`)

1. 从 "QA fix context" 首行按正则 `^QA verdict to fix: claim (\S+)` 取 `<id>`;**原样复制**,不改大小写、不截断。取不到 id 时停止并按节点失败通道上报,绝不猜 id。
2. 只改第 2 行为 `FIXED-FOR-CLAIM <id>`;第 1 行与文件其余部分零变动。
3. 自检(字节级):
   ```
   printf 'QA-SBX FLY-2167 drill\nFIXED-FOR-CLAIM %s\n' "$ID" | cmp - qa-sbx/fly2167/project-slot-1-FLY-3150.md
   ```
   零输出、退出码 0。以上一次交付头 `PREV`(交付 #1 的 SHA,从交付摘要/`git log` 取)为基准,`git diff --name-status $PREV..HEAD` 只有 `M qa-sbx/fly2167/project-slot-1-FLY-3150.md`(+ progress.md ledger 提交),且 `git diff $PREV..HEAD -- qa-sbx/fly2167/project-slot-1-FLY-3150.md` 的 patch 恰好是 `-AWAITING-QA` / `+FIXED-FOR-CLAIM <id>` 两行。
4. 提交 `docs(qa-sbx): FLY-3150 drill fix for claim <id>`(同样的禁词规则),推送,再次交付。

## 3. QA 节点(qa)验收合同

criterion id 固定、title < 120 字符、evidence < 80 字符:

**分轮判据只有一个**:提示词里有没有 "QA re-verification context"。没有 → 第 1 轮;有 → 重验轮,且 `<id>` **只**从该重验上下文内的 `Previous QA verdict: claim <id>` 行提取。若重验上下文存在但取不到唯一 id:`fixed-for-claim` 不得 pass、不得降级成第 1 轮、不得自行查库找 id,按节点失败通道报告"提示词不完整"。若第 1 轮提示词偶然出现 `Previous QA verdict` 字样,仍按第 1 轮处理(恒 fail)。

| criterion id | 第 1 轮(无 "QA re-verification context") | 重验轮(有 "QA re-verification context") |
|---|---|---|
| `file-shape` | 文件存在且第 1 行精确等于 `QA-SBX FLY-2167 drill` → pass/fail 按实际 | 同左 |
| `fixed-for-claim` | **恒为 `fail`**,evidence 精确为 `round 1: no previous QA claim yet` | 完整第 2 行精确等于 `FIXED-FOR-CLAIM <id>`(id 来自重验上下文的 `Previous QA verdict: claim <id>`)→ `pass`;否则 `fail`;id 不可得 → 失败通道 |
| `e2e_529_exempt` | `not_run`,`exempt_category: docs_only`,reason 如 `docs-only sandbox change` | 同左 |

QA 节点同样:不部署房间、不碰 Linear、不改目标文件。

## 4. 核心流程(序列)

```mermaid
sequenceDiagram
    participant D as eng_design(本节点)
    participant I as eng_implement
    participant Q as qa
    participant B as Bridge/驱动器
    D->>B: plan + design.html(节点契约产物,见 §1.1)
    B->>I: 派发(无 QA fix context)
    I->>I: 写两行:drill / AWAITING-QA
    I->>B: 交付 #1(CI 在交付头运行)
    B->>Q: QA 第 1 轮(无 "QA re-verification context")
    Q->>B: file-shape 按实 / fixed-for-claim=fail(planted) / e2e_529_exempt=not_run
    B->>I: 返工派发,QA fix context: "QA verdict to fix: claim <id> ..."
    I->>I: 第 2 行改为 FIXED-FOR-CLAIM <id>
    I->>B: 交付 #2
    B->>Q: 重验("QA re-verification context" 含 Previous QA verdict: claim <id>)
    Q->>B: fixed-for-claim=pass(逐字匹配)
```

## 5. 数据 / 结构模型

- 文件:`qa-sbx/fly2167/project-slot-1-FLY-3150.md`,两行文本。第 1 行是不变的"身份行",第 2 行是状态机:`AWAITING-QA` → `FIXED-FOR-CLAIM <id>`。
- claim id:由 QA 第 1 轮产生,经驱动器注入返工提示词(`QA verdict to fix: claim <id>`),实现写入第 2 行,重验提示词再带回(`Previous QA verdict: claim <id>`)。**同一字符串在四处必须逐字一致**;这条贯通链才是演练的被测对象。
- 验收记录:`qa-criteria/v1` 三条 criterion,id 固定如 §3。

## 6. 关键取舍与被否方案

| 取舍 | 选择 | 被否方案与原因 |
|---|---|---|
| 文档深度 | exploration + 短 plan,无 research | 写 research.md:README 明令不要;写了反而违反"follow it exactly" |
| 第 1 轮 `fixed-for-claim` | 恒 fail(planted) | "文件没问题就 pass":会跳过返工回路,演练失去意义 |
| claim id 来源 | 只认提示词 "QA fix context" 首行 | 从 Bridge/DB 自行查询:超出 README 范围,且引入猜 id 风险 |
| 返工改动面 | 仅第 2 行 | 重写整个文件:无法用 numstat 证明"其余不变" |
| CI | 平实 commit message,让 CI 跑 | 模仿历史 `[skip ci]`:README 明确禁止,交付头必须有 CI |
| 提问 | 不问 Lead | 房间无人类 Lead,README 已覆盖一切 |

## 7. 回滚边界与负向守卫

- 回滚:整个变更 = 一个新文件,`git rm` 即回滚;不涉及任何共享状态。
- 负向守卫(实现/QA 节点各自执行):
  - 目标文件与 `engineering/doc/FLY-3150-real-runner-drill/`(节点契约产物,§1.1)之外任何路径出现在 `BASE..HEAD` / `PREV..HEAD` diff → 停止、修正后再交付。不得为了"diff 只有目标文件"删除已有设计材料。
  - commit message / PR 标题含禁词 → 不得推送。
  - 返工时 `<id>` 为空或与提示词不一致 → 不交付、走失败通道;QA 重验时 id 不可得同样走失败通道,绝不 pass。
  - `e2e_529_exempt` 不得是 `pass`/`fail`,必须 `not_run` + `docs_only`。
  - 任何节点不得调用 `room deploy/teardown`。

## 8. 测试证据(docs-only,无代码测试)

| 证据 | 命令 / 来源 |
|---|---|
| 文件形状 | `printf <期望两行> \| cmp - <目标文件>` 零输出、退出码 0(字节级,含末尾换行) |
| 改动面 | 交付 #1:`git diff --name-status $BASE..HEAD` = `A` 目标文件(+ progress.md);交付 #2:`$PREV..HEAD` = `M` 目标文件(+ progress.md),patch 恰为 `-AWAITING-QA`/`+FIXED-FOR-CLAIM <id>`。`origin/main..HEAD` 还会含设计节点的 exploration/plan/design.html/progress,那是 §1.1 的节点契约产物,不是实现改动面 |
| CI 在交付头 | PR checks 关联的 SHA = 交付头 SHA |
| QA 三条 criterion | `qa-result --criteria-file` 的 JSON 原文 |
| claim id 贯通 | 返工提示词首行、文件第 2 行、重验提示词三者字符串 diff 为空 |

## 9. 诚实边界

- 本设计只覆盖 README 定义的两行文件 + 三条验收;不设计任何 Flywheel 代码或 Bridge 行为。
- 不验证生产 FLY-2167 实现本身;演练只证明 529 房间内真 Runner 的 fail → fix → re-verify 回路能贯通。
- 设计节点不创建目标文件;若后续节点的提示词格式与 README 不符,以 README 为准。
