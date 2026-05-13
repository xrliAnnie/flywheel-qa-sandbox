# Exploration: Shared Channel Reply Discipline — FLY-152

**Issue**: FLY-152 (Lead reply discipline — shared channel default to cos)
**Date**: 2026-05-10
**Status**: Draft — Step 1 audit (codebase evidence) before brainstorm with Annie

> 目的：在跟 Annie brainstorm 之前，把现状摸清楚。下面写的全是 codebase 上能直接 grep 到的事实，不是"我猜应该是"。后续 brainstorm 的 fork-point 选择，都引用本文 §1–§5 的编号。

---

## 1. Problem statement (Annie 的原话)

`#geoforge3d-core` (shared channel) 里 Annie 不显式 @-mention 特定 Lead 时，**Peter / Oliver / Simba 三个 Lead 都会 reply** → 重复 + 混乱。

Annie 期望：
1. shared channel default → **只 Simba (cos-lead) reply**
2. Simba 自决 escalation — Simba 觉得需要 Peter / Oliver 时 **自己 @ 他们**
3. Annie 显式 @Peter / @Oliver → 那个 Lead 才 reply

---

## 2. 现状架构 — 没有中央 Discord router

### 2.1 Lead 怎么"听到"消息

Discord 消息派发**不经过 Bridge**。每个 Lead 是独立的 Claude Code session（`packages/teamlead/scripts/claude-lead.sh` 启动），通过 Discord MCP 插件 (`mcp__plugin_discord_discord__*`) 直接订阅 Discord 网关事件。Bridge 只负责：

- `STANDUP_CHANNEL` 这种 **Bridge → Discord 推送** (`packages/teamlead/src/bridge/standup-route.ts`, `plugin.ts:1534`)
- `chatThreadId` / `forumChannel` 这种 **Bridge → Discord 创建 thread** (`DirectEventSink.ts`, `ForumPostCreator.ts`)
- gate-poller 把 Runner 问题 relay 给 Lead (`bridge/gate-poller.ts:214`)

**入站消息（Annie → Lead）走的是 Discord MCP 插件直连**。Bridge 完全不感知 Annie 在 core 里说了什么。

→ 结论：**没有"Bridge 中央过滤"这条路可走，除非新建一条**。今天每个 Lead 自己决定自己是否回复。

### 2.2 Channel 订阅 = identity.md 里写死的白名单

每个 Lead 的 `identity.md` 有 "Channel Isolation Rules"，列出**只在这些 channel 回复，其他静默忽略**：

| Lead | 自有 channel | 共享 channel |
|------|-------------|-------------|
| Simba (cos) | `cos-lead-control` (control), 无 forum / chat | `geoforge3d-core` |
| Peter (product) | `product-chat`, `product-forum`, `product-lead-control` | `geoforge3d-core` |
| Oliver (ops) | `ops-chat`, `ops-forum`, `ops-lead-control` | `geoforge3d-core` |

`geoforge3d-core` (1487340532610109520) **同时在三个 Lead 的白名单里**——这是设计意图，不是 bug。

### 2.3 Core channel reply rule（**bug 的核心位置**）

三个 Lead 的 `identity.md` 都有一段"Core Channel Routing Rules"，定义"在 core 收到消息时回不回"。这三段规则的**结构**几乎相同，但是**默认行为**冲突：

**Simba (`cos-lead/identity.md:39-44`)**:
```
1. Called by name ("Simba") -> reply (from Annie or any Lead)
2. Called nobody             -> reply (you are the default handler)   ← 默认回
3. Called someone else       -> Don't reply
4. Called multiple incl. me  -> reply for my part
```

**Peter (`product-lead/identity.md:51-57`)**:
```
1. Message contains <@PETER_ID> or text "Peter"  -> reply
2. Simba's triage report @'d you                 -> must reply
3. Called someone else but not you               -> Don't reply
4. Called nobody                                 -> Don't reply (Simba takes over)   ← 默认不回
```

**Oliver (`ops-lead/identity.md:52-57`)**: 同 Peter 的结构。

**Annie 期望对比**:

| Annie 想要 | Simba 当前 | Peter 当前 | Oliver 当前 |
|-----------|-----------|-----------|-----------|
| 无 @ → 只 Simba 回 | ✅ 默认回 | ✅ 默认不回 | ✅ 默认不回 |
| @Peter → 只 Peter 回 | (无规则禁止 Simba 介入) | ✅ 回 | ✅ 不回 |
| @Oliver → 只 Oliver 回 | (无规则禁止 Simba 介入) | ✅ 不回 | ✅ 回 |
| Simba 自决 @Peter | ❌ 无规则授权或鼓励 | (Simba @ 的话 Peter 应回) | n/a |

→ **rule 是写了，bug 是"没被执行"**。下面 §3 拆 bug 实际触发点。

---

## 3. 为什么三个 Lead 还是都回 — bug 触发点拆解

Rule 都写了，但 prod 还是 3 个都回。可能原因（按概率排序）：

### 3.1 触发点 A: "or text 'Peter' / 'Oliver'" 这条字符串匹配规则太宽

`product-lead/identity.md:53`:
> Message contains `<@1485896147951419434>` **or text "Peter"** -> reply (regardless of sender)

Simba 的规则里同样有 `cos-lead/identity.md:41`:
> Called by name **("Simba")** -> reply (from Annie or any Lead)

**后果**：
- Annie 说 "刚 Peter 帮我搞了" → Peter bot 看到自己名字 → 回
- Annie 说 "Simba 不在的话…" → Simba 看到自己名字 → 回
- Annie 说 "等会 Peter 跟 Oliver 一起看下" → Peter + Oliver 都回

也就是 Annie 在 core 里**纯文本提名字** ≠ 给指令，但 Lead bot 把 "name in text" 当 "calling me"。如果 Annie 加上 Simba 默认回，**一句话提到 Peter + Oliver 就是三个都回**。

这是 prod 最容易踩中的 case。

### 3.2 触发点 B: "Called nobody" 在 Peter/Oliver 是 "Don't reply"，但 LLM 不严格

Peter/Oliver 的 rule 第 4 条说"无 @ → Simba 处理"。**这是 prompt 约束，没有代码 enforcement**。一个 Opus session 在 ambiguous case（比如 message 里有 product 相关词，但没 @Peter）可能仍然 LLM-judge "this looks product-related, I should reply" → 违反 rule。

### 3.3 触发点 C: 文本里出现 Lead 的 dept 关键词

如果 Annie 说 "product 那边怎样了"，Peter 没有规则说 "只有 @ 我才回"——他可能基于 "product"（语义）来判断 "在叫我"。这是 prompt-stacking 的灰区。

### 3.4 触发点 D: Simba 的"default reply" 没有触发条件限制

`cos-lead/identity.md:42`:
> Called nobody -> You reply (you are the default handler)

Simba 看见**任何 core 里的消息**只要没 @ 谁，都按"default handler"回。**包括 Peter / Oliver 之间互相讨论的消息**（如果他们在 core 讨论而不是 chat）。Simba 现在没有"discussion-only between Leads → don't intervene"这种区分。

### 3.5 三个触发点叠加

最坏 case: Annie 在 core 说 "Peter @oliver 看下这个 product issue":
- @oliver 显式 → Oliver 回 ✅（正常）
- Peter（无 @）按文本"Peter"+ "product"判断在叫他 → Peter 回 ❌
- Simba（无 @ to Simba）按 default handler 规则 → Simba 也回 ❌
- 三个都回，Annie 抱怨

---

## 4. FLY-127 R3 已经做了什么、没做什么

FLY-127 R3 ship 的是 **spawn 时的 dept-scope 防越权**：

| Layer | 文件 | 管的事 |
|-------|------|-------|
| Bridge dept-check (PR #173) | `bridge/runs-route.ts` | `POST /api/runs/start` 时按 Linear label 检查 leadId 是否匹配，不匹配返回 `DEPT_SCOPE_REJECT` |
| Lead Action Gate base (PR #174) | `packages/teamlead/lead-rules-base/department-lead-rules.md` | 规定 Lead 调 `/api/runs/start` 前怎么分类（spawn / ambiguous / discussion），收到 Bridge reject 怎么发一行 Chinese diagnostic |
| Cos routing discipline (PR #174) | `packages/teamlead/lead-rules-base/cos-lead-rules.md` | 规定 cos 派 backend / Runner 工作时**一条消息一个 Lead**（防止 mixed multi-Lead spawn directive） |

**FLY-127 处理的是 "Lead 该不该 spawn Runner"**——这是一个**动作 (action)**。

**FLY-152 处理的是 "Lead 该不该在 Discord 回话"**——这是**另一个动作 (reply)**。两条规则不冲突，但需要独立设计，不能在 FLY-127 的 spawn rule 上贴一句"reply 也按这个"。

cos-lead-rules.md 里的 "Department Routing Discipline" 是说 **cos 主动派活**时怎么写；没说 **shared channel 收到 Annie message** 时谁该回——FLY-152 要补的是后者。

---

## 5. 历史背景

- `doc/engineer/plan/archive/v1.25.0-FLY-128-terminal-spawn-consistency.md:492` 里有一句 `❌ Lead reply rule (FLY-126 backlog)`，说明这个问题之前就识别到了，编号是 **FLY-126**（reply 规则）和 **FLY-127**（spawn 规则）成对设计，但只有 127 ship 了，126 在 backlog 里。FLY-152 = FLY-126 的接续。

- 当前 `lead-rules-base/README.md` 描述的 extension 模式（Java abstract + project subclass）是 ship 过的 pattern：base 在 `packages/teamlead/lead-rules-base/`，project 在 `<project>/.lead/shared/`。**FLY-152 的 reply rule 自然落点是同样的 base + project 双层**，跟 FLY-127 R3 的 layering 一致。

- `claude-lead.sh:1077-1093` 的 BASE rule append 逻辑已经把 cos 和 dept 分开 conditional load。**新加一条 reply rule 不需要动 shell 脚本主体**，只要在 `lead-rules-base/` 里写新文件 + 在 shell 里加 append block。

---

## 6. 还没问清楚但需要 brainstorm 的 fork-point（送 Annie）

下面是我读完代码后**没法自己拍板**的设计决定。**每一条都映射到 team-lead 在我接到任务时列的 5 个 fork-point**，但根据 audit 重新精确化：

### Fork-point a — "shared channel" 怎么界定

audit 找到的所有 core / shared channel 实际就一个：`geoforge3d-core` (1487340532610109520)。但 `STANDUP_CHANNEL` 是 Bridge → Discord 单向推送，**Annie 不在那里跟 Lead 互动**。

→ **问 Annie**: FLY-152 范围是不是**只针对 `geoforge3d-core`**？或者你希望规则更通用（"任何被多个 Lead 同时订阅的 channel"）以备未来扩展？

### Fork-point b — 实施在 Lead system prompt（self-discipline）还是 Bridge router（中央过滤）

audit 结论：**Bridge 完全不感知入站 Discord 消息**。要"中央过滤"必须新建一条 Bridge / proxy 链路：Discord → Bridge → 单一 Lead inbox。这是大动工程，跟 FLY-127 R3 的 prompt-only 模式不一致。

Self-discipline 路线：**复用 FLY-127 R3 的 base + project 双层**，在 `lead-rules-base/` 加 `shared-channel-reply-rules.md`，project 里给具体 cos/dept 实例化。**成本 ~1 个 PR，跟 FLY-127 R3 同一 deploy pattern**。

→ **问 Annie**: 我倾向 prompt-only（理由：FLY-127 R3 已经验证这条路对"动作分类"够用，且不增加 Bridge 复杂度）。你要不要为了"硬保证"接受 Bridge router 那条更重的路？

### Fork-point c — Lead 怎么判断"Annie 没 @ 我"

audit 发现今天的判断分两种：
- **Discord mention** (`<@BOT_ID>`) — 准确，结构化
- **Text string match** (`"Peter"` / `"Oliver"` / `"Simba"`) — §3.1 已说这是 bug 源头

→ **问 Annie**: FLY-152 是不是顺手**砍掉 "or text Name" 这条字符串匹配**，只保留 `<@BOT_ID>`？这样 Peter / Oliver 只在被 @ 时才回，文本里出现名字不触发——但 Annie 平时是否用纯文本"Peter, 看下"？如果是，需要给一个明确的 alternative（比如要求 Annie 习惯用 `@Peter`，或允许 "Peter," 行首 + 命令式开头才算）。

### Fork-point d — Simba escalation 时 @Peter，Peter 怎么区分"Simba @ 我"和"Annie @ 我"

audit 看 Peter 的现规则 `(product-lead/identity.md:53)`:
> Message contains `<@1485896147951419434>` or text "Peter" -> reply (regardless of sender)

Peter 已经"regardless of sender"地接受 @ 了——所以 Simba @Peter 时 Peter 会回，Annie @Peter 时 Peter 也会回，这是同一条 rule。**结构上没有区分需求**，除非 Annie 想让 Peter 在 "Simba @ 我" 时**用不同语气**（比如向 Simba 汇报而不是直接面对 Annie）。

→ **问 Annie**: 你要不要 Peter / Oliver 在 "Simba 来 @ 我" vs "Annie 来 @ 我" 时**话术不同**？还是都一样直接答即可？我倾向**都一样**（简单 + 现状的 prompt 语义已经支持）。

### Fork-point e — 边界 case: Annie @Peter @Oliver 同时呢

audit 现规则：
- Peter 看到 `<@PETER>` → 回
- Oliver 看到 `<@OLIVER>` → 回
- Simba 看到 "called someone else but not me" → 不回

→ 默认行为 = Peter + Oliver 都回，Simba 不回。

→ **问 Annie**: 这个默认 OK 吗？还是你希望 Simba 仍然"主持"（说一句开场白）然后让 Peter / Oliver 各自答？还是只让一个 Lead 答（比如 Simba 决定谁先答）？我倾向**默认 OK**（多 @ 多回，跟 discussion semantics 一致），但你要的话可以加一条"多 @ 时 Simba 不介入"以避免 noise。

### Fork-point f — Simba 主动 @ Peter/Oliver 的授权语句

audit 发现：cos-lead-rules.md 只有 "Department Routing Discipline (spawn-only)"，**没有 "shared channel escalation discipline"**。Simba 没有规则说"当 Annie 的问题需要 product 专业判断时，我应该 @Peter 让他答"。

→ **问 Annie**: 这个授权要不要写进 base layer `cos-lead-rules.md`？比如：
> 当 Annie 的问题涉及具体 dept 专业（status of running issues / dept-specific decision / dept Runner question），cos 应该 @ 对应 dept Lead 让他自己答，而不是 cos 转述。Cos 给的是 routing / global view，不是 dept 内的 detail。
>
> 触发条件示例：Annie 问 "GEO-XX 怎么样了" + 该 issue 有 dept label → cos 第一反应 = `<@PETER> 看下 GEO-XX`，让 Peter 直接答 Annie。

我倾向**加这条**，因为 Annie 期望 #2 就是 Simba 自决 escalation——如果 prompt 不写，Simba 默认会自己尝试答完，导致 dept-detail 走 Simba 转述，质量降。

---

## 7. 给 Annie 的 brainstorm 起手式

Step 1 audit 写完后，下一步是 brainstorm（≥3 轮 Q&A 才能写 plan，per memory rule `feedback_brainstorm_must_be_interactive_multi_round`）。

**第一轮提议先聚焦最少决定**：
1. Fork-point **a**（shared channel 定义：是 core 一个还是泛化？）
2. Fork-point **b**（self-discipline prompt 还是 Bridge router？我倾向前者）
3. Fork-point **c**（"or text Name" 字符串匹配砍不砍？）

这 3 个一旦定了，d / e / f 是局部细化，可以下一轮谈。

**Brainstorm 不进 plan 前**：
- 不创建 `lead-rules-base/shared-channel-reply-rules.md`
- 不改 `claude-lead.sh`
- 不动 GeoForge3D 的 identity.md

audit 完。

---

## 8. 相关文件清单（implement 阶段会动哪些）

供未来 plan 阶段参考，**现在不动**：

| 文件 | 现状 | 预计改动 |
|------|------|---------|
| `packages/teamlead/lead-rules-base/cos-lead-rules.md` | 只管 spawn routing | + shared channel default-replier 规则（fork-point f） |
| `packages/teamlead/lead-rules-base/department-lead-rules.md` | 只管 Action Gate + Bridge reject diagnostic | + shared channel "only reply when @-mentioned to me" 规则（fork-point c+d） |
| `packages/teamlead/lead-rules-base/README.md` | 文件清单 | + 新文件描述（如果拆独立文件） |
| `packages/teamlead/scripts/claude-lead.sh` | 已 conditional append base rules | **可能不需要改**（同一个 base file 加 section 即可）|
| `<project>/.lead/cos-lead/identity.md` | "called nobody → default reply" | 保持，或精化（discussion-between-Leads 时不介入）|
| `<project>/.lead/product-lead/identity.md` `:53` | "or text 'Peter'" | 砍掉 text match（fork-point c） |
| `<project>/.lead/ops-lead/identity.md` `:54` | "or text 'Oliver'" | 同上 |

**关键 invariant**: FLY-152 完全在 prompt-rule 层，**不改 TypeScript 代码、不改 Bridge router、不改 channel 订阅、不动 IPC**。

End of audit.
