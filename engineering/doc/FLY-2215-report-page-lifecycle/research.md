# FLY-2215 报告页生命周期 — 调研
Issue: FLY-2215 (https://linear.app/geoforge3d/issue/FLY-2215/publish-report-每发一份报告泄漏一个-chrome-页面而两道-reaper-都够不着它-3-天攒了-125-页-145gb)
日期: 2026-09-02
基于: exploration.md

## 1. 权威证据

### 1.1 生产事故形状

事故浏览器的 `DevToolsActivePort` 对应 126 个 target / 125 个 page；121 个 page 是 `fw-reports-*.vercel.app/r/<id>`。Chrome main process 使用系统 TMPDIR 下的 `agent-browser-chrome-*` profile，带 `--headless=new`、不带 `--screenshot`。这同时证明：

- 页面来自 `publish-report` 的 ProofShot/agent-browser 路径，而不是某个单独项目；
- 每次调用留下的是同一复用浏览器里的新增 page，不是每份报告各起一套可被现有 reaper 认领的 browser；
- 验收必须数 CDP page 或 renderer，不能只数 main process。

### 1.2 仓库实现

`captureReportScreenshot()` 的所有 ProofShot 子命令使用同一临时 cwd，因此共用同一 ProofShot session。`started` 在 `start` 成功后置 true；finally 中无论截图、复制或后续校验是否失败，都会调用一次 `proofshot stop`，随后删临时目录并释放机器级 lock。

lock 在 `/tmp/flywheel-proofshot-port.lockd` 用原子 mkdir 实现，并用 pidfile 恢复 stale lock。它覆盖整个 `start → exec → finally` 区间，所以新增的“关闭当前 tab”不会与另一条 `publish-report` capture 并发争用 active tab。

现有 `publish-report.test.ts` 已覆盖：

- happy path 的 start / viewport / screenshot / stop 顺序；
- start 后截图失败仍 stop；
- stop 失败只 warning，不遮蔽截图；
- 2x→1x 截图降级；
- temp 与 lock 收尾。

缺口是这些测试把 `RunProofShot` 当作纯调用记录器，没有模拟 tab target 数；它们把“调用过 stop”错误地等同于“报告页已关闭”。

### 1.3 已安装 CLI 的真实契约

本机版本：ProofShot 1.3.1、agent-browser 0.27.1。

- `proofshot exec <args...>` 在 active recording session 下记录 action，然后把参数原样构造成 agent-browser 命令；子进程非零会向上传播。
- `agent-browser --help` 明确列出 `tab [new|list|close|<n>]`。
- `proofshot stop --help` 明确列出 `--no-close`，含义是完成 session 收尾但保留 browser。
- ProofShot 的 `stopCommand()` 默认调用 `closeBrowser()`；`closeBrowser()` 调用 `agent-browser close`，但 catch 块为空。也就是说 browser close 失败既不会让 stop 失败，也不会让 `publish-report` 看到 warning。事故中的 121 个报告 page 是这条静默失败路径已经发生的直接证据。

因此最小的确定性操作不是继续相信 `stop` 的 browser-level close，而是在活跃 session 与机器级 lock 内显式调用 `proofshot exec tab close`。

## 2. 候选方案

| 方案 | 是否满足 | 判断 |
|---|---|---|
| 不改，依赖 `proofshot stop` | 否 | 事故已证明会静默留下 page；现有测试是假阳性。 |
| 改 FLY-766 owner 归属 | 不首选 | 要把 Lead/infra-bot 的 TMPDIR 与 StateStore 所有权重新接线，改动大且仍是事后杀 browser。 |
| 扩大 FLY-1828 selector | 否 | 当前 Chrome 没有 `--screenshot`；放宽到所有 ownerless headless Chrome 会误杀未知调用方。 |
| 截图后 `proofshot exec tab close`，再 `proofshot stop --no-close` | 是 | 精确关闭本次 page，保留复用 browser；复用现有 CLI、lock、warning seam，无依赖、无新抽象。 |
| 每次截图后 `agent-browser close --all` | 否 | 全局破坏性操作，会关掉其他 session；FLY-766 已明确禁止。 |

按 Ponytail decision ladder，第四个方案停在“使用已安装依赖的原生命令”；不需要新 helper、配置或依赖。

## 3. 命令顺序

正确顺序是：

```text
proofshot start
proofshot exec set viewport
proofshot exec screenshot
proofshot exec tab close
proofshot stop --no-close
```

不能把 tab close 放在 stop 之后：ProofShot stop 会结束并删除 active session；`proofshot exec` 在 session 存在但 recording 已停时会 fail closed。也不能继续用无参数 stop：那会在 tab 已关闭后再走 browser-level close，与“只关本次 page、保留复用 browser”的锁定方案冲突。

## 4. 失败语义

截图产物与 Discord 链路已有“截图失败则 link-only”语义。页面清理属于 finally，不应反向破坏已拿到的合法 PNG 或链接投递：

- `tab close` 失败：发 `publish-report: report tab close failed: ...` warning，仍执行 `stop --no-close`，避免 ProofShot session/录屏状态残留。
- `stop --no-close` 失败：沿用现有 warning-only 语义。
- 无论哪条失败：仍删 temp dir、释放 lock。

不增加 browser-kill fallback。失败可见但不跨 ownership 边界杀共享 browser；现有 reaper 安全边界保持不变。

## 5. TDD 与验证设计

### 5.1 RED/GREEN 单测

修改现有测试而不是新增抽象：

1. happy path 断言最后两条调用严格为 `['exec','tab','close']` 和 `['stop','--no-close']`，且 cwd 与前序命令一致。现代码会因仍只有 `['stop']` 而红。
2. start 后截图失败的 finally 仍包含 tab close + stop-no-close。
3. 新增 tab-close failure 用例：close 抛错后 stop-no-close 仍执行、warning 可见、link delivery 不被阻断。
4. stop failure 用例改为匹配 stop-no-close，保留原语义。

### 5.2 真机 N 次回归

在可启动 Chrome 的 host 环境中，用隔离的 `AGENT_BROWSER_SESSION` 与隔离 HOME/TMPDIR，运行 built `publishReport()` N≥3 次；publish/deliver HTTP 用本地桩，截图跑真实 ProofShot/agent-browser。每轮：

1. 从 main process 的 `--user-data-dir` 读取 `DevToolsActivePort`；
2. 请求 `http://127.0.0.1:<port>/json/list`，记录报告 URL page count；
3. `ps` 统计该 profile 下 `--type=renderer` 数；
4. 断言每轮 capture 后报告 page 回到 baseline，renderer 序列不随轮数单调增长；
5. 最后只关闭该隔离 session，确认没有触碰默认/其他 agent-browser session。

当前 runner 沙箱的隔离 Chrome 在写 `DevToolsActivePort` 前退出，连 `--no-sandbox` 也相同；因此本地已验证 CLI 形状与失败边界，但真实 Chrome 计数要作为 host QA 证据，不能拿 mock 代替。

## 6. 变更范围

预计只改：

- `packages/flywheel-comm/src/commands/publish-report.ts`
- `packages/flywheel-comm/src/__tests__/publish-report.test.ts`
- 本单 DOC-FLOW 文档与最终 milestone

明确不改：chrome-session-reaper、TmuxAdapter、Bridge 定时器、ProofShot/agent-browser 包版本、CLI flags、公共 API 与 CLAUDE.md。
