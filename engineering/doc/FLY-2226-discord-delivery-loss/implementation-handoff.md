# FLY-2226 Discord 插件 gateway 自愈 — 实施交接

Issue: FLY-2226 (https://linear.app/geoforge3d/issue/FLY-2226/通信投递丢失-founder-discord-消息选择性丢投2216-thread-从出生就聋-engineer-顶层-0325z)
日期: 2026-09-01
基于: plan.md

## 交付边界

- 插件实现位于 `xrliAnnie/claude-plugins-official` PR #24（分支
  `fix/fly-2226-gateway-self-heal`，code head `a5d0135a9`）；实现节点不部署、不 cutover、
  不重启任何生产服务。
- Flywheel 锚 PR 仅承载获批设计、实施证据与外部仓指针，不包含插件运行时代码。
- 两个首版功能开关 `DISCORD_GATEWAY_WATCH` / `DISCORD_ECHO_PROBE` 缺省 OFF；只有精确
  `=1` 才启用对应恢复动作。每个 Lead 的 `DISCORD_ALERT_CHANNEL` 必须在灰度前显式写入其
  `DISCORD_STATE_DIR/.env`。
- forced reconnect 安全预算按 Lead 裁定写死为滚动 60 分钟最多 3 次尝试，不提供配置旋钮；
  第 4 次只告警并 latch 到窗口过期或插件进程重启。告警正文明确写出重启是人工恢复杆。

## 已完成验证

- 外部仓 `bun test`：212 passed / 0 failed，514 assertions。
- `bun build server.ts --target=bun`：PASS，产物 2.64 MB。
- `git diff --check`：PASS。
- Flywheel `pnpm lint`：PASS，仅保留 14 条既有 warning。
- Flywheel `pnpm -r build`：PASS（22/23 workspace projects）。
- Flywheel `pnpm test:packages:run`：已执行并顺序复跑；仅两条未修改的
  `packages/core/test/tmux-viewer.macos.test.ts` 真 Terminal.app 用例失败，原因是 resident
  runner 无法连接 macOS HiServices/Apple Events。排除该 GUI-only 文件后 core 19 files、
  219/219 tests 通过；本分支没有新增 `scripts/__tests__/*.test.sh`。
- 外部 PR #24 的 `Validate Discord Runtime` 与 membership guard：PASS。
- 本地 `codex:rescue` 只读 review 尝试在读取仓库前因 nested macOS sandbox
  `sandbox_apply: Operation not permitted` 退出，未记作 review PASS，也未绕过为 raw
  `codex exec`。有效 hard gate 是带 `targetRepoPath=.review-plugins` 的 request-driven
  cross-family code review。

## Code review

- Round 1 在 `c3fd31cef` 返回 CHANGES_REQUESTED：唯一 HIGH
  `unbounded-forced-reconnect-loop` 证明重复 READY-but-deaf episode 会持续消耗 IDENTIFY。
- Lead 裁定滚动 60 分钟 3 次的进程内硬预算；TDD 修复同时保证 probe/log bookkeeping
  永不把已经成功的 Discord send 变成 retry duplicate。
- Round 2（request `1b3cc29d-6632-4a0a-9f67-5bf01622f62a`）在精确 plugin head
  `8852c84fb` 得到 **APPROVED**，无 blocking finding；reviewer 的 24 小时仿真从
  1,372 次/day 收敛为 72 次/day，并通过 4,000-step 随机事件/timer fuzz。
- Lead 要求本轮修复两个 MEDIUM：已告警 recovery episode 后若再发生不可恢复
  `shardDisconnect`，现在会新开 terminal episode 再告警一次（重复 terminal event 仍去重）；
  startup guard 现在直接读取并验证实际安装的 transitive `@discordjs/ws` 版本及
  `WebSocketShardDestroyRecovery.Reconnect` enum，而不是只守 `discord.js` 包版本。
- Alert delivery 与 lifecycle logging 明确为 always-on，不受两个 default-off recovery flag
  控制；`ACCESS.md` 已补三个环境变量、失败路径和 rollout 语义。缺失/非法
  `DISCORD_ALERT_CHANNEL` 会在 startup 双路告警，后续失败只落本地 dead-letter，不猜频道。
- LOW follow-up（本 PR 不扩机制）：建议将 `gateway-health-dead-letter.jsonl` 按 lifecycle log
  同一纪律限制为 256 KiB + 1 个备份，并将 `handledEpisodes` 限制为最近 1,000 个 episode key
  （FIFO/LRU 均可，需另单 TDD），避免多年运行后无界增长。
- Round 3 focused review（gate `33ed9fd2-460c-4f82-90c4-a7eacdd33b42`，request
  `af7e8b96-f6e1-45de-ac8f-d974ab6aa89d`）在精确 plugin head `a5d0135a9` 得到
  **APPROVED**；reviewer 重放 budget-latch → 4014 close、34 分钟 storm 与完整 212 tests，
  确认两个 mandatory finding 均 resolved，且新 terminal episode 不重置 reconnect budget。
- 新 non-blocking MEDIUM `undeclared-discordjs-ws-dependency` 指出 module-scope transitive import
  在 strict-isolation package manager 下可能启动失败。当前 Bun install 的单份实际运行字节已由
  lock/runtime test 证明；本轮不添加 direct dependency，因为获批计划 §3 Chunk 2 明确禁止再引入
  一份可能与 `discord.js` 所用 transitive copy 漂移的 `@discordjs/ws`。该 advisory 已报告 Lead。

## QA 必过验收（cutover 前）

QA 节点必须在隔离 Lead 上挂载本 PR 的新 plugin bytes，并在任何 fleet cutover 之前完成：

1. 人为断开 gateway，证明一次真实 `shardReconnecting` / raw-shard destroy / `shardReady`
   恢复闭环。
2. 在同一进程、同一 strategy shard map 上重复第二次，证明第二次恢复不是空转。
3. 验证自愈失败告警使用插件自己的 Discord REST/token 路径；alert delivery 失败才写
   `gateway-health-dead-letter.jsonl`。
4. 观察两个 90 秒证据窗口：library lifecycle deadline 后并行启动 fire-and-forget reconnect
   与 recovery deadline；只有 `shardResume` / `shardReady` 算恢复证据。

独立 QA 已在旧 head `8852c84fb` 完成上述双 reconnect、半聋自愈与健康期窗口并给出 PASS；
Lead 要求 mandatory rework 后再对 `a5d0135a9` 做一次隔离 Lead 双 reconnect 复验。该复验由 DAG
orchestrator 的 QA 节点执行，本实现节点不自行调度、部署或注入真 gateway 故障。

今晨 slot 部署曾因环境目录走漏击杀生产 Codex 舰队（FLY-2231）。QA 创建任何隔离环境前，
必须确认环境包含 FLY-2174 的隔离修法；否则手动把全部三个
`FLYWHEEL_CODEX_*_ROOT` 配置钉到隔离目录。没有满足此前置，不得进行 gateway 故障注入。

## 上线提示

Merge 外部仓 PR 不会改变当前运行字节。上线仍必须走既有 `scripts/discord-plugin/` cutover
路径：先为所有 Lead 配置 alert channel 且保持两个开关 OFF，再只选一个低风险 Lead 同时启用
两个开关；完成两次真实 reconnect、至少 10 次真实插件出站及 24 小时零假阳性观察后，才可
分批启用其余 Lead。正常部署由独立 updater/QA 流程负责，本实现节点不执行。
