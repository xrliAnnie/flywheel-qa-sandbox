# FLY-2215 报告页生命周期 — 探索
Issue: FLY-2215 (https://linear.app/geoforge3d/issue/FLY-2215/publish-report-每发一份报告泄漏一个-chrome-页面而两道-reaper-都够不着它-3-天攒了-125-页-145gb)
日期: 2026-09-02
基于: 无

## 1. 问题边界

本单只修 `flywheel-comm publish-report` 截图后的报告页泄漏。事故证据来自 Chrome 自己的 CDP target 列表：同一个自动化浏览器里有 125 个 page，其中 121 个是已发布报告 URL；连续发布或 republish 会各自再留一页。三天后这套浏览器达到 139 个进程、约 14.5 GB RSS。

这不是 WindowServer 卡顿单。事故浏览器由 `--headless=new` 启动；关闭它没有降低 WindowServer 占用。本单的成功口径只有报告发布后的 Chrome page/renderer 不再随发布次数累积。

## 2. 当前链路

`packages/flywheel-comm/src/commands/publish-report.ts` 的截图路径是：

```text
publish hosted HTML
  → proofshot start --url <hosted report>
  → proofshot exec set viewport
  → proofshot exec screenshot --full
  → finally: proofshot stop
  → deliver Discord message
```

`captureReportScreenshot()` 已用全局 ProofShot lock 串行化这条链路，并保证 start 成功后进入 `finally`。问题是 finally 只调用 `proofshot stop`。

本机安装的 ProofShot 1.3.1 中，`stop` 依次收集日志、停止录屏，然后调用 `agent-browser close`；其 `closeBrowser()` 会吞掉全部异常。事故实测说明这一步并没有回收当前报告 page，而调用方因为异常被吞也无法发现。现有单测只断言收到一次 `stop`，mock 不维护真实 tab/target 数，因此会在页面泄漏时继续通过。

## 3. 两道 reaper 为什么不是修复点

- FLY-766 只认 `~/.flywheel/runner-state/<execId>/browser-tmp/` 下且带 owner marker 的 Chrome。Lead 与 infra-bot 直接调用 `publish-report` 时使用系统 TMPDIR，按安全设计不可归属、不可杀。
- FLY-1828 只收同时带 `--headless` 和 `--screenshot` 的一次性 Chrome main process。本链路由 agent-browser/CDP 截图，main argv 没有 `--screenshot`。

扩大任一道 reaper 的选择器都会把“关闭本次确定拥有的 page”变成“猜测哪个无主浏览器可以杀”，既扩大 blast radius，也不符合 Lead 锁定的最小范围。

## 4. 最小可行修法

沿用 Cass 在 issue 评论中的“只关页、不杀复用浏览器”手法：截图完成后显式执行 `proofshot exec tab close`，再执行 `proofshot stop --no-close` 完成录屏和 artifact 收尾。这样：

- 当前报告 tab 在仍有活跃 ProofShot session 时被精确关闭；
- `--no-close` 阻止 ProofShot 再尝试关闭共享的 agent-browser；
- browser/daemon 可继续复用，下一次发布不需要重新拉起；
- 不需要改 reaper、owner 归属或增加配置旋钮。

关闭 tab 与 stop 必须分别 best-effort：前者失败仍要尝试 stop，后者失败也不能遮蔽已经成功的截图结果；两条失败都进入现有 warning 通道。

## 5. 假设与待验证项

1. ProofShot 1.3.1 的 `exec <args...>` 会把 `tab close` 原样转给已安装的 agent-browser；agent-browser 0.27.1 的 CLI 明确提供 `tab close`。
2. 全局 ProofShot lock 保证同一时刻只有一个 publish-report capture，因此“当前 tab”就是本次打开的报告页，不会关到另一份并发报告。
3. `tab close` 必须发生在 `stop` 之前；stop 删除活跃 session 后，`proofshot exec` 会拒绝无 recording 的调用。
4. 本 runner 的沙箱不能启动 Chrome（隔离 HOME 后 Chrome 在写出 `DevToolsActivePort` 前退出），所以真实 N 次 target/renderer 计数要在实现完成后通过允许 Chrome 的 host 验证环境执行并留证；这个环境限制不用于缩小验收标准。

## 6. 验收

- 单测先红后绿：成功路径顺序必须是 screenshot → `exec tab close` → `stop --no-close`。
- 负向用例：tab close 失败时仍调用 `stop --no-close`，并产生明确 warning；stop 失败保持现有降级语义。
- 真机回归：在隔离 agent-browser session 中连续执行 N≥3 次报告截图，逐轮用 CDP `/json/list` 记录报告 page 数，并用 `ps` 记录 `--type=renderer` 数；报告 page 每轮回到基线，renderer 数不得随 N 单调增长。
- 范围守卫：`chrome-session-reaper.ts`、TmuxAdapter、reaper 配置与 CLAUDE.md 均无改动，也不新增依赖或旋钮。
