# FLY-347 — Pending HTML update spec (deferred: quota 回来再做)

Issue: FLY-347
日期: 2026-07-08
基于: proposal.md / agent-wiki-proposal.html
状态: **DEFERRED** — Lead 5540c222 prefixed 「[quota 回来再做,先存着]」。已存,等 quota 回来 / Lead 说 go 再执行。

## 要改的 3 点(Annie 看完提案的调整)

1. **讲清「为什么要 Lint」**:wiki 越攒越大会烂(矛盾/重复/过时)。Lint = 定期体检 pass
   (去重 / 消解矛盾 / 清过时 / 标缺口),**像 lint 代码**。→ 现有提案第 5/6 节有 lint,但
   要把「为什么必须有」这个动机讲透(类比 lint 代码),单独讲清。

2. **把「缺的层 + 回路怎么做」具体化**:在现有 markdown 记忆之上加一个 **agent 维护的编译层**:
   - **Ingest**:读新东西 → 写互链 wiki 页 + `[[链接]]` + 进 index。
   - **Query**:先读编译好的 wiki(不翻 raw)。
   - **Lint**:体检。
   - **不建新存储** —— 现有 markdown 树 + 一个维护 skill + index/schema 约定。
   - 这三段(Ingest/Query/Lint)是**描述完整回路**用的,讲清楚即可;不代表 MVP 全做。

   > **MVP 定稿(Lead 钉死,别再两版)**:MVP = **agent 自跑的 memory consolidation/Lint
   > pass**(去重 / 合并 / 清过时,出**可审 diff、可逆、绝不自动删**),**不是 Ingest+index**。
   > 理由:我们已有 Ingest+index+互链 ~70%,真痛点 gap = consolidation(索引只增不并、
   > 约 190 文件/约 126 feedback 没合)。Lead chat 里的「Ingest+index」是说岔了,以提案 HTML 原本
   > 写的 Lint/consolidation 为准。Ingest/Query/语义搜索 都明确留后。
   > **注意:已 publish 的 agent-wiki-proposal.html 里 MVP 本来就写的是 Lint/consolidation
   > —— 已经对了,MVP 段不用改。** HTML 要改的只是下面 §「执行时的动作」里 Annie 的 3 点补充。

3. **事实校正(已初步 grounded)**:我们有 mem0 `MemoryService`(在
   `packages/edge-worker/src/memory/MemoryService.ts`,含 pgvector/embedding 代码路径),
   **但 pgvector 基本没接、主力是文件 markdown**(证据:约 190 个 `memory/*.md` + MEMORY.md 是
   活 substrate)。→ 所以「编译 wiki 层确实缺」,提案成立。执行时可再确认 pgvector 是否真 dormant。

## 执行时的动作(quota 回来后)

- 更新 `agent-wiki-proposal.html`,加/改这三块(MVP 段**保持现有 Lint/consolidation 不动**):
  1. 讲透「**为什么要 Lint**」:wiki 越攒越大会烂(矛盾/重复/过时);Lint = 定期体检 pass,
     **像 lint 代码**(单独一节讲清动机)。
  2. **具体化编译层 + 回路**:在现有 markdown 记忆之上加 agent 维护的编译层 —— Ingest(读新
     →写互链 wiki 页 + `[[链接]]` + 进 index)/ Query(先读编译 wiki 不翻 raw)/ Lint(体检);
     **不建新存储**(现有 markdown 树 + 维护 skill + index/schema 约定)。这是**完整回路描述**;
     MVP 仍只做 Lint/consolidation 那一段。
  3. **事实校正小节**:mem0 `MemoryService` 有代码(`packages/edge-worker/src/memory/`,含
     pgvector 路径)但主力是文件 markdown → 编译 wiki 层确实缺,提案成立。
- 保持 FLY-930 nonce + addEventListener + Apple 浅色 + textarea 评论框;curl 验。
- publish-report --channel 1524481167246495774(FLY-347 thread)→ 把 URL 发 Lead → relay Annie。
- 不 close、不 ship、不 build code。

## 交付坐标(复用)

- HTML: product/doc/FLY-347-llm-knowledge-base/agent-wiki-proposal.html
- thread channel: 1524481167246495774
- 上一版 URL: https://fw-reports-a53de2.vercel.app/r/d276a498dbeba4ecae67ffab65842dd5/
