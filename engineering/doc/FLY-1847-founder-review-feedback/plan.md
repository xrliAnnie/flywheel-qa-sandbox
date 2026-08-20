# FLY-1847 founder review 卡锚定回传协议 — 实施计划

Issue: FLY-1847 (https://linear.app/geoforge3d/issue/FLY-1847/founder-ux-互动-review-页的意见回传是手动复制粘贴-已实际发生她写了一整轮我们没收到而她不知道)
日期: 2026-08-19
基于: research.md

## 1. Founder 最终裁决

采用固定、可操作、可审计的卡锚定协议，不再对普通 thread 自然语言做 verdict 分类：

| 输入 | 机器动作 |
|---|---|
| founder 在当前卡上点 ✅ | 批准并关闭本轮 |
| founder reply-to 当前卡，正文固定为 `approve` 或 `look good to me` | 批准并关闭本轮；大小写与尾部标点归一化 |
| founder reply-to 当前卡，正文为 `打回`，或以 `design:` / `implement:` / `qa:` 开头 | 打回并关闭本轮；前缀接受半角/全角冒号，容忍尾部标点 |
| 问题、讨论、页面汇总、旧通过词、任何普通 thread 发言 | 交给 Lead；不写 verdict，本轮保持开放 |
| reply-to 当前卡但不符合固定协议 | 交给 Lead并解释固定操作；不写 verdict，本轮保持开放 |

显式打回允许空反馈；不强制 founder 填写意见。互动页面既有 localStorage 持久化继续保留，页面汇总 marker 只保留来源信息，不再是机器 verdict。

## 2. 实施切片

### 2.1 RED：锁定损失路径

- founder review：旧白名单、页面 marker、❌ 均不再写 verdict；只有卡锚定固定协议有效。
- ship review：普通 thread 的 `approve`、`ship`、旧白名单、问题与讨论不能进入分类器或写入器。
- F2：`打回。`、`design：...`、`implement: ...！`、`qa：...。` 都是显式卡锚定打回。
- 卡正文逐字断言三条路：批准、打回、讨论。

### 2.2 GREEN：收窄唯一写入边界

- `founder-reply-deliverer.ts` 仅把 verified direct reply-to-current-card 交给对应 review/ship handler；普通 thread 发言直接走既有 Lead handoff。
- `founder-review-response.ts` 删除旧五词白名单、页面 marker 与 ❌ 判定，只保留固定文本批准与显式打回。
- `approval-signal/text-approval-source.ts` 删除生产路径上的 Tier-2 词库与 Tier-3 LLM 分类，仅处理卡锚定固定协议。
- `founder-ship-approval-handler.ts` 增加二次 card-anchor 硬门，调用方即使误传普通 thread 文本也在分类前 fail closed。
- `workflow-rework-hint.ts` 集中实现文本归一化与显式打回识别；`write-gate-response.ts` 复用同一规则，消除半角冒号专用正则。
- `gate-poller.ts` 只轮询 founder review 卡上的 ✅，删除旧 ❌ 分支需要的回帖依赖。

### 2.3 卡正文与生成契约

- `founder-thread-notifier.ts`、`gate-materializer.ts` 明确：批准只能点卡上 ✅ 或 reply-to 卡回固定文本；打回必须 reply-to 卡显式表达；讨论直接发 thread，由 Lead 接且不改变 verdict。
- `edge-worker/src/Blueprint.ts` 同步未来互动 review 页契约：页面汇总交 Lead，不自动打回。

## 3. 不实施

- 不建设页面自动回传 endpoint、存储或轮询基础设施。
- 不用自然语言词库或 LLM 猜 founder 意图。
- 不把页面汇总 marker 当作打回。
- 不用 ❌ reaction 写入打回。
- 不允许普通 thread 发言关闭 gate。

旧的 `tier2-allowlist.ts` 与 `founder-ship-approval-classifier.ts` 在本切片后不再位于生产 verdict 路径；为避免未经授权扩大删除范围，本 PR 不删除历史模块，后续可单独清理。

## 4. 验证与交付

1. 运行 founder review、ship handler、deliverer、writer、卡正文的定向 Vitest 回归集。
2. 运行 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run` 与 `git diff --check`。
3. 推送 PR #888 新 head，等待 CI。
4. 通过 codex code review；若有 blocking finding，修复后用新 questionId 重审。
5. 完成 bounded implement node：`complete --route needs_review --pr 888`；不申请 ship、不合并。
