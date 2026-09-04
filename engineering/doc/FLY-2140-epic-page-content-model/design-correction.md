# FLY-2140 Epic 页面内容模型与首版生成 — 设计修正
Issue: FLY-2140 (https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳)
日期: 2026-09-02
基于: plan.md（design-review blob 已钉，不修改）；QA c7c97526 补验 7(a)/(b)

## 1. 修正依据与边界

本修正来自 Lead 打回，决策人为 Tadashi，依据是 QA c7c97526 的补验，不转述为 founder 原话。只修正两个已证实的展示/可见性缺口，不改变 `next.v1`、批次、StateStore 投影、路由、版本链或其它机制。

## 2. 页面级 gaps 覆盖六个执行格

钉住的计划要求 StateStore 读取失败使用稳定标识 `statestore_error`，且不把原始异常文本写进页面。原实现虽然让失败格本身 `missing`、并让该子单从 `next_candidates` fail-closed 消失，但 `computeGaps` 只扫描 `title`、`batch`、`acceptance`、`founder_named` 四面。因此 Lead 在页面级「缺什么、缺在哪」里看不到执行事实读取失败。

修正后，`gaps.v1` 的扫描面扩为十格：原四面，加 `session`、`run`、`attempt`、`gates`、`carriers`、`land`。任一执行格读取失败都会产生 `{ item: <子单 id>, face: <格名>, reason: "statestore_error" }`。`gaps` 的 derived provenance 同步列出十格输入路径，schema 守卫也要求每个 missing 执行格必须在 gaps 中有对应项。

这不改变失败传播关系：例如 `workflow_run` 读取失败仍由物化器把 `run`、`attempt`、`gates`、`carriers` 四格都标成 missing；页面现在只是把这四个已存在的事实逐项说清楚。

## 3. 首屏 session 摘要使用账面 live 聚合

`next.v1` 判断执行位是否空闲时读取 `session.value.ledger_live_count`，而原首屏表格展示 `session.latest[0].status`。两者在「旧 live 行 + 较新的终态行」时会表达相反结论。

修正后，Markdown 与 HTML 首屏的「账面执行体」列保留 `latest[0]` 的状态/角色/执行 id 摘要，并在同一格并列显示 `ledger_live_count=<n>`；`latest` 为空时也明确显示计数。session 详情格仍保留完整的 `latest` 与 `ledger_live_count`、出处和时间；读取失败时首屏显示稳定 missing reason。这样既不丢原有首屏信息，又让首屏与 `next.v1` 使用同一账面 live 口径，同时仍不声称底层 OS 进程一定存活。

## 4. 证明

- RED：人为把一张子单的六个执行格设为 `statestore_error`，旧实现得到空 gaps。
- GREEN：同一用例得到六条含子单 id、格名和稳定 token 的 gaps；`assertEpicPage` 通过。
- RED：session 的 `latest[0]=completed/design(deadbeef)`、`ledger_live_count=2` 时，旧 Markdown/HTML 首屏只显示 latest 摘要、看不到 live 聚合；只显示计数的中间实现又丢了 latest 摘要。
- GREEN：两种首屏均同时显示 `completed/design(deadbeef)` 与 `ledger_live_count=2`。

500 子单读取的性能边界只记入 `implementation-notes.md`，按本轮决策不改代码。

## 5. 未闭合 fenced code 的验收边界恢复

qa@3 复验发现，验收段标题扫描为避免截断 fenced code 内的示例标题而维护 fence 状态后，未闭合的 fence 会把下一个真实同级章节及其后全文都吞进 `acceptance`。这相对修正前是行为回退，也会让页面把不属于验收的正文误报为「做完算什么样」。

按 Lead 裁定，本轮只恢复这一条边界：遇到 fence opener 时先检查后文是否存在合法 closer；有 closer 时继续忽略 fence 内的标题，保留上一轮修对的 closed-fence 行为；没有 closer 时，以下一个带空白的同级或更高级 Markdown 标题作为恢复点并终止验收段。正常章节仍保留上一轮对无空白标题（如 `##下一节`）的兼容，不改变标题匹配、原文引用或 4096-byte 截断规则。

- RED：裸未闭合 fence 与带语言标记的未闭合 fence 都把 `## 下一节` 和尾部哨兵吞进验收正文。
- GREEN：两种输入都在 `## 下一节` 前终止；closed fence 内的 `# 示例标题` 仍保留，随后在真实章节标题处终止。

## 6. 未闭合 fence 后的无空白标题

exact-head code review round 4 指出，第 5 节新增的恢复路径使用了比正常章节路径更严格的标题表达式，导致 `##下一节` 这类无空白标题在未闭合 fence 后仍会被吞入验收正文。该行为与同函数正常路径已经支持的无空白标题不一致。

修正后，未闭合 fence 恢复直接复用正常路径预计算的同一 heading matcher；同级或更高级标题无论 marker 后是否有空白，都会按 fail-short 方向终止验收段。closed fence 的 closer 查找与 fence 内标题保护保持不变。

- RED：带语言标记的未闭合 fence 后接 `##下一节` 时，旧恢复路径把标题与 `SECRET-TAIL` 一起写进 acceptance。
- GREEN：同一输入在 `##下一节` 前终止；原有 bare/language unclosed fence、closed fence 及正常 no-space heading 用例同时通过。

## 7. founder 返工：按批次的一单一卡

2026-09-03 08:48 PT，founder 以 Lead 计划页 v69 为样板打回原 HTML：她要先看清 Epic 有哪些子单、每张做什么、做完看到什么，以及「做 X 之前先做 Y」这样的依赖关系；原页把每张子单的 14 个 Cell 全部展开成网格，出处完整但主任务不够清楚。

本轮只改 HTML 的信息层级，不改变 `EpicPage` 文档、`next.v1`、`batch.v1`、StateStore 投影、路由或 Markdown：

- 顶部先放 Epic 总览、批次顺序和「现在可以开始的」，再以批次分组；
- 每张子单只保留一张主卡，标题直接合并编号、Linear 标题与状态；正文用「是什么 / 为什么 / 做完你看到 / 依赖 · 批次」四行，再补账面执行体与 founder 标记；
- 「是什么」只复述 `title` Cell；「为什么」只反向读取全部 `blocked_by` Cell，说明该子单会解锁谁，不从 Linear 正文猜业务原因；「做完你看到」只摘取 `acceptance` Cell，缺失逐字显示「缺验收」；依赖行把未解除 blocker 写成「做 X 之前先做 Y」；
- 每个推导展示都写 `batch.v1`、完整输入 Cell 路径与「未获 founder 裁定的默认规则」；
- 每卡底部一行保留 Linear 出处链接、观察时间、来源更新时间；14 个 Cell 的精确 value / provenance / observed_at / source_updated_at 放进同一底部的原生 `<details>`，默认折叠但没有丢失，避免再次铺满屏幕；
- 页面没有增加开关，也没有新增页面独有事实。

TDD 证据：旧 HTML 对新增三条行为测试是 3 fail / 7 pass（仍含 `<table>` 与 `cell-grid`、没有 `card-meta`、没有 Epic 总览）；实现后渲染文件 10/10，通过全 Cell parity、安全转义、循环人话与 session live 聚合的原有断言。相关 Epic Page / 路由 / StateStore 联合范围为 10 files / 112 tests 全绿。

视觉核验没有伪造：生成的 fixture HTML 为 48,076 bytes、5 张子单恰好 5 张 `item-card`、零 `<table>`、零 `cell-grid`；Chromium 仍在当前 macOS sandbox 启动阶段被 MachPort rendezvous 以 1100 拒绝，未产出截图。

## 8. qa@5 返工：顶部审计摘要收口

qa@5 发现顶部 5 张派生总览卡虽然用了 `<details>`，但 `<summary>` 仍直接展开 `next.v1` / `gaps.v1` / `batch.v1` / `founder.v1` / `done.v1` 的完整 `/items/N/field` 输入路径，合计约 2,380 字符。折叠体关闭时这些路径仍常驻可见，破坏卡片层级。

implement@6 只调整这一个展示边界：五张卡的 summary 与子单卡一致，恒为短句「1 格出处与时间」；原 value、规则号、完整输入路径、`observed_at`、可选 `source_updated_at` 以及「未获 founder 裁定的默认规则」全部保留在折叠体。文档模型、规则、路径和时间值零改动，也没有开关。

- RED：`/batches` 的旧 summary 仍含完整 `/items/0/batch … /items/4/priority`，与短 summary 断言不等。
- GREEN：5 个派生 path 的 summary 都精确等于「1 格出处与时间」、零 `/items/`；每个折叠体仍逐一包含其规则号、默认规则声明和全部 `provenance.from` 路径。

## 9. founder 二次返工：批次模型废止

本节覆盖第 1–8 节里所有 `batch.v1`、`next.v1`、单 Epic 输入、整页版本读取口径；完整裁定依据与 locked scope 见 `plan.md` 第 11 节。

- 页面与模型彻底删除 batch：没有 item batch、root batches、批次分组或批次展示。
- `ready.v1` 每次渲染从 Linear 实时计算：范围内、非 Backlog、未完成/未取消、所有 blocker 均为 `completed`；只按 Linear priority（0 最后）与 identifier 排序。
- 范围是绑定边界内所有 started 顶层父单的完整子树，并必须包含标题含「日常」的常驻父单；Backlog 子单不在展示范围。零活动父单、缺日常或父单不可读均 fail loud。
- 每卡以「等谁 / 谁在等我」双向展示依赖，编号与标题同时出现；`dependents.v1` 写全 `blocked_by` 输入路径并标为已获 founder 裁定。
- `epic_page` 表只写 source-only render receipt；任何渲染或排序代码都不能读取它。存储守卫拒绝 batch/next/ready/order 字段和计算结果路径。
- API 与 CLI 移除 Epic、version 旋钮；JSON、Markdown、HTML 都通过同一 POST 入口实时查询 Linear。
