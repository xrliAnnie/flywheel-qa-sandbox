# FLY-2761 固定页漏报「无会话、不在 Epic」的 founderAsk — 实施计划
Issue: FLY-2761 (https://linear.app/geoforge3d/issue/FLY-2761/固定页漏报-founderask-挂在无会话不在-epic-范围的-issue-上时-现在要你看静默丢掉它attentionaudience)
日期: 2026-09-24
基于: research.md

> **产品判据**：founder 面的任何清单，过滤条件只能是「这件事还需不需要她」，不能是「我们能不能把它渲染出来」。
> 渲染不出来是我们的问题，不是让它消失的理由。

## 1. 范围

| 编号 | 改动 | 文件 |
|---|---|---|
| C1 | founder 视图不再以链接为条件丢行 | `epic-page/attention-presentation.ts` |
| C2 | 页脚摘要把「缺链接」与「清单不完整」拆成两类，数字对得上 | `epic-page/attention-presentation.ts`、`epic-page/labels.ts` |
| C3 | HTML / Markdown 行内缺链接时显示「（无讨论串链接）」；Markdown 计数与 HTML 同口径 | `epic-page/render-html.ts`、`epic-page/render-markdown.ts` |
| C4 | founder_ask 缺 Linear/Epic 元数据时用自带 identifier 作身份，走共用讨论串解析 | `epic-page/attention-sources.ts` |
| C5 | 校验器接受「本行自己那条 ask」作为身份来源 | `epic-page/attention.ts` |
| C6 | `pendingDecisions` 写明不覆盖 founder_ask | `bridge/lead-runtime.ts`、`bridge/bootstrap-generator.ts`（仅注释） |

不做：给 attention 行加 Linear 链接（今天就没有）；放宽 Linear 查询边界；渲染 ask 原文 excerpt；
改动生命周期过滤（`visible`、`message_id`、关联问题已答）——那些回答的是「还需不需要她」；改 thread 标题。

## 2. 设计

### C1 `attentionAudience(page, founder=true)`

删掉 `if (founder && !attentionLink(page, item).url) return [];`。其余投影（只取 founder 来源、只留最新一条问题）不变。
函数上方写产品判据注释。Lead 视图（`founder=false`）本来就不按链接过滤，不变。

### C2 摘要

N = 传入的 `count`（founder 行 + 班车行），M = founder 行里 `attentionLink(...).url === null` 的数目（M ≤ N）。
「清单不完整」只由读取失败 / 身份未核齐 / 体积截断触发，**不再**由缺链接触发。

| 清单完整？ | M | 文案 |
|---|---|---|
| 是 | 0 | `现在没有等你的事`（N=0） / `有 N 件等你处理的事` |
| 是 | >0 | `要你看 N 件，其中 M 件缺讨论串链接` |
| 否 | 0 | `已知 N 条记录，清单不完整（原因…）` |
| 否 | >0 | `已知 N 条记录，清单不完整（原因…）。其中 M 件缺讨论串链接` |

labels：新增 `attention.count_unlinked`、`attention.no_link`（`（无讨论串链接）`）、`attention.no_link_reason`（`（无讨论串链接：{reason}）`）；
`attention.unlinked` 改为 `其中 {n} 件缺讨论串链接`。

### C3 渲染

- HTML `renderAttention`：缺链接时 where 格显示 `（无讨论串链接）`，原因仍放 `title`；不输出任何 `href`。
  行的 what 格本来就显示 identifier，所以整行 = issue 标识 +「（无讨论串链接）」。
  子单行（`renderChild`）的「这张单还没有 thread」不动。
- Markdown `renderAttention`：where 格缺链接时 `（无讨论串链接：<原因>）`；摘要 count 改为 `founder.length + deploymentFounder.length`；
  删除「缺少讨论串链接的记录」折叠（那些行已在 founder 列表里，保留会重复）。

### C4 补源（`readAttentionSources`）

```ts
// FLY-2761: a founder_ask row is a project-scoped local record naming its own
// issue; missing Linear/Epic metadata must not hide the founder's pending ask.
const identityFor = (p: Pending) => {
  const issue = issueFor(p);
  if (issue) return { id: issue.id, identifier: issue.identifier, title: issue.title, provenance: linear(issue.id) };
  if (p.source.fact.value?.kind === "founder_ask" && p.issue && ISSUE_IDENTIFIER.test(p.issue))
    return { id: p.issue, identifier: p.issue, title: null, provenance: p.source.fact.provenance };
};
```

- 频道聚合、`visible` 别名、候选构造三处都改用 `identityFor`；讨论串解析代码不改——ask 的 `channel` 已进 `otherChannels`，
  于是以 `ask.channel_id` 为权威频道查 `chat_threads`（项目频道约束、`thread_missing`、ID 校验照旧）。
- 身份格 provenance = ask 来源自己的 `statestore · founder_ask · {ask_id}`；title 为空，`missing: issue_title_unknown`。
- 非 identifier 形状的 `issue_id` 不补源（保持身份不知道，但 C1 仍会列出并计入 M）。
- `ISSUE_IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/` 从 `attention.ts` 导出，两处共用。

### C5 校验器（`assertAttention`）

`issue_id` 非空时，issue_id / identifier / title 每格 provenance 须满足其一：

1. `linear` 且 `id === issue_id`（原规则）；
2. 恰好是 `{kind:"statestore", table:"founder_ask", key:{ask_id: A}}`，`A` 为非空字符串，且本行存在一条**已核对的 ask 来源**：
   `fact.value.kind === "founder_ask"`、`fact.value.id === A`，其 `fact` 与 `since` 的 provenance 都是
   `statestore · founder_ask`、`key.ask_id === A`；同时 `issue_id` 为 identifier 形状、`identifier === issue_id`、`title` 为空。

（设计评审 R1 #1：只比 provenance 里的 `ask_id` 不够——fact ID 是 ask-A、provenance 写 ask-B，或 key 缺 `ask_id` 时
`undefined === undefined` 都会放行。现在把补源身份绑到 fact ID 本身。）

其余不变量（`key === issue:<id>`、身份为空则 thread 为空等）不动。只在生成期校验，存量页面不重验（research §1），加宽无兼容风险。

### C6 文档

`BootstrapDecision[]` 字段 `pendingDecisions` 加 JSDoc：只含最近 `awaiting_review` 的 session，不覆盖 founder_ask，等 founder 的事以固定页「现在要你看」为准。
`bootstrap-generator.ts` 对应注释同步一句。无行为变化。

## 3. 测试（TDD：先红后绿）

| 测试 | 断言 | 改动前 |
|---|---|---|
| **新** `epic-page/__tests__/founder-ask-outside-scope.test.ts`（真 StateStore + CommDB，FLY-2736 样本 fixture） | ① 无 session / 无 Epic / Linear 边界外 → `attentionAudience(page,true)` = [FLY-2736]，链接 = ask 的讨论串，标题「· 1 件」；② guild 缺失 → 仍列出、「（无讨论串链接）」、「要你看 1 件，其中 1 件缺讨论串链接」；③ founder 在该讨论串回复 settle → 消失、「· 0 件」；HTML **和** Markdown 公开字节都不含 excerpt 与完整 ask_id | 3/3 红（已取证，见 §5） |
| `attention.test.ts` 新增 | `attentionAudience(page,true)` 对无链接候选的分支（guild / thread / thread_url 三种缺失）仍返回该行；校验器：本行 ask 身份通过、同一 issue 两条合法 ask 合并后通过；负向各自失败——外来 ask_id（fact ID 与 provenance ID 不同）、key 缺 `ask_id`、since provenance 错配、非 identifier、identifier≠issue_id、title 非空 | 红 |
| `attention-sources.test.ts` 新增 | identifier 形状的 ask + Linear `source_unavailable` → 补源身份、以 ask 频道为权威解析讨论串；非 identifier 形状维持身份不知道；Linear 元数据可用（UUID）时 identifier 形状的 ask 与同 issue 的 holder 归并为一行（key 为 UUID），不产生第二行 | 红 |
| `attention-render.test.ts` 改写 | 原钉住「无链接 → 0 行」的用例（`marks a valid founder item without %s…`、`keeps all four parts when thread…`、`disables missing thread…`、`disables absent guild…`、`FLY-2597: founder attention lists only actionable bound thread links`）改为「列出 + 无 href + 两类文案」；Markdown 计数与 HTML 同为 1 | — |

## 4. 验证（targeted，按 implement 协议）

- `pnpm lint`；`pnpm --filter "flywheel-teamlead..." build`（含 typecheck）。
- 改的都是包内模块，包的公开导出不变；如 `tsc` 报 dependents 相关再跑 `pnpm --filter "...flywheel-teamlead" typecheck`。
- `vitest related` 覆盖所有改动文件；再跑 `git grep -lF` 找到的直接消费者测试（epic-page 全目录、`bridge/__tests__/founder-attention*.test.ts`、bootstrap 相关）。排除项逐条写进 PR。
- 阴性对照：同一 fixture 在 HEAD 637752fcc 上计数不变（§5），改后 +1。

## 5. 阴性对照（已取证，HEAD 637752fcc，未改代码）

| 操作 | 标题 | 页脚 |
|---|---|---|
| 无 ask | `⚡ 现在要你看 · 0 件` | 现在没有等你的事 |
| 打 FLY-2736 ask 后 | `⚡ 现在要你看 · 0 件` | 已知 0 条记录，清单不完整（1 条记录缺少讨论串链接；身份尚未核齐，同一件事可能暂列多条） |

新测试在该 HEAD 上 3/3 失败（`expected [] to deeply equal [ 'FLY-2736' ]` 等）。

## 6. 回滚

纯代码回滚，无迁移、无配置、无存量数据改动。回滚后重新生成的页面回到旧行为。

## 7. 风险

- **一件事两行**：Linear 读失败时，同一 issue 的 holder（身份不知道）与 ask（补源身份）会分成两行。页脚已有「身份尚未核齐，同一件事可能暂列多条」覆盖这一情形。
- **标题「不知道」**：补源身份没有 Linear 标题。诚实优先，点讨论串可见原文。
- **计数上升**：此前被静默丢掉的无链接行会进入「现在要你看」计数——这是本单要的效果。
