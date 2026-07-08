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
   - **MVP 先做 Ingest + index**(注意:这和之前提案「MVP=Lint」有出入 —— Annie/Lead 现在
     说 MVP 先 Ingest+index。执行时以此为准:MVP 收窄到 Ingest→写互链页→进 index,Lint 次之)。

3. **事实校正(已初步 grounded)**:我们有 mem0 `MemoryService`(在
   `packages/edge-worker/src/memory/MemoryService.ts`,含 pgvector/embedding 代码路径),
   **但 pgvector 基本没接、主力是文件 markdown**(证据:187 个 `memory/*.md` + MEMORY.md 是
   活 substrate)。→ 所以「编译 wiki 层确实缺」,提案成立。执行时可再确认 pgvector 是否真 dormant。

## 执行时的动作(quota 回来后)

- 更新 `agent-wiki-proposal.html`:加「为什么 Lint(类比 lint 代码)」+ 具体化编译层
  Ingest/Query/Lint + 事实校正小节;MVP 收窄为 **Ingest + index**(Lint 留后或并列次要)。
- 保持 FLY-930 nonce + addEventListener + Apple 浅色 + textarea 评论框;curl 验。
- publish-report --channel 1524481167246495774(FLY-347 thread)→ 把 URL 发 Lead → relay Annie。
- 不 close、不 ship、不 build code。

## 交付坐标(复用)

- HTML: product/doc/FLY-347-llm-knowledge-base/agent-wiki-proposal.html
- thread channel: 1524481167246495774
- 上一版 URL: https://fw-reports-a53de2.vercel.app/r/d276a498dbeba4ecae67ffab65842dd5/
