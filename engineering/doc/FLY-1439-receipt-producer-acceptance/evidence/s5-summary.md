# FLY-1439 插件收据 producer 真机验收 — S5 证据摘要
Issue: FLY-1439 (https://linear.app/geoforge3d/issue/FLY-1439/qafly-1437-独立真机验收-插件收据核销-producerfork-pr-17-bb0a1509)
日期: 2026-07-23
基于: plan.md

## 结论

S5 通过：pinned checkout 的独立全量测试精确复现 `172 pass / 0 fail /
411 expect()`，零 loud-skip；三个定向 mutation 探针 3/3 在预定断言处变红。
PR #17 与 feature branch 的远端 head 均仍为
`bb0a150989c0d7477bbb03543052c87ee229d368`。

## 全量测试硬门

- Bun `1.3.11`，sqlite3 `3.51.0`。
- 显式路由
  `FLYWHEEL_COMM_CLI=.../packages/flywheel-comm/dist/index.real.js`，不是
  missing CLI 或 shim 假路径。
- `bun test`：172 pass、0 fail、411 assertions、8 files，639ms。
- 全量和三个 mutation 输出中的 `SKIP LOUD` 计数全部为 0。

## 真实性审计

- **真 CLI / 真库**：集成测试要求实际 CLI 文件与 `/usr/bin/sqlite3` 存在；
  对同 envelope 连续 begin 两次、查询真实临时 comm.db 只有一行，再验证
  delivered 窗口 120 秒和 processed reply evidence。m3 进一步证明 suite
  的确执行了所路由的 CLI。
- **stock byte-compat**：从 fork-main
  `ff159052bf6f2212dd7f83d37de89ae3b17c60ad` 取原始 server.ts；
  直接调用生产 recorder 的三个 stock-mode copy 函数，三段运行时字符串
  （长度 460/169/106）均在 fork-main 字节中精确出现。
- **reply reference 真形态**：discord.js 当前安装类型为
  `Message.reference: MessageReference | null`，所以负测使用显式 `null` 是
  真实 SDK 形态，不是用 null 冒充省略字段。补充探针同时验证 omitted、
  explicit-null、wrong-id 都为 false，只有 persisted matching id 为 true。
- **隔离 env 真形态**：stock 用真正空对象（字段省略）；companion/external
  marker 在 capability 为空串/空白/省略时仍先静默隔离；非隔离 partial tuple
  则 loud-broken。S4 真 pane 的 companion marker 与零 receipt delta 已补上
  能力级证据。
- **真 fs mode**：runtime 测试在临时文件系统上 `statSync` 断言 spool 0700、
  intent 0600，并检查原子写无 `.tmp` 残留；S2/S3 真机也观察到相同 mode。

## Mutation sensitivity（全部 disposable copy）

1. **m1 settle write-ahead**：移除 `writeJsonAtomic(path, intent)` 后，
   `persists the settle proof before the CLI runs (write-ahead)` 精确失败，
   `intentDuringCli` 从 expected true 变为 false（该破坏还连带暴露另外两条
   recovery 失败，总计 12 pass / 3 fail）。
2. **m2 stock copy**：把 recorder 的 `Messages from Discord arrive as`
   改一个字符，`preserves all three stock strings exactly when receipts are
   not enabled` 精确失败（15 pass / 1 fail）。
3. **m3 CLI idempotence**：主仓副本先 topological build，再把 enqueue 的首个
   `INSERT OR IGNORE INTO lead_inbox` 改成 `INSERT INTO lead_inbox` 并重建。
   emitted `dist/lead-inbox-queue.js` SHA 改变且首条 emitted SQL 已是裸
   INSERT；入口 `dist/index.js` SHA 保持 `55974455…`，证明路由入口稳定。
   fork 副本显式将 `FLYWHEEL_COMM_CLI` 指向 mutated entry 后，第二次
   `runtime.begin()` 从 expected `ok` 变为 `spooled`（14 pass / 1 fail）。

## Verdict 前 clean 三查

- pinned HEAD 精确为 `bb0a150989c0d7477bbb03543052c87ee229d368`。
- 为不把 install 产物冒充 source clean，`node_modules` 已可恢复地移到 slot
  临时目录；随后 `git status --porcelain` 为空且 `git diff` exit 0。
- `git archive HEAD` 与 checkout（排除 `.git`）递归 diff 为 0 字节。
