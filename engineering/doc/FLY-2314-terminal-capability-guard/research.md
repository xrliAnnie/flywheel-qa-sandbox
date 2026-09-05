# FLY-2314 Terminal 能力守卫 — 调研
Issue: FLY-2314 (https://linear.app/geoforge3d/issue/FLY-2314/判据卫生-macos-terminal-测试的-skip-守卫只查-which-osascript不查-terminalapp-能否解析)
日期: 2026-09-03
基于: exploration.md

## 本地证据

在当前 macOS runner 上：

```text
which osascript
→ /usr/bin/osascript

osascript -e 'name of application "Terminal"'
→ Terminal

osascript -e 'tell application "Terminal" to count windows'
→ execution error: Can’t get application "Terminal". (-1728)

pnpm --filter flywheel-core exec vitest run test/tmux-viewer.macos.test.ts
→ 2 failed；stderr 同时包含 com.apple.hiservices-xpcservice Connection Invalid 与 Terminal 字典语法错误
```

这组基线把当前环境定为验收 B：`which` 和内建 `name` 属性都成功，但一旦执行 Terminal 自己字典中的最小只读命令就得到 issue 同族的 `Can't get application Terminal`，既有两条 GUI 测试也随即失败。因此 `name` 仍是过弱代理，不能作为最终判据。两侧真正的分歧是 Terminal 字典/Apple event 通路，不在二进制发现，也不止在 application 名称属性定位。

设计评审 lane 在同一台机器、另一进程上下文中两次运行 `count windows` 都得到 `2`、rc=0。这个反向观测说明 capability 属于当前进程的 LaunchServices/Apple-event 上下文，不能从“同一台主机”推导；实现与验收都必须记录调用进程实际 probe 结果。

另一个阴性对照进一步证伪 `name`：

```text
osascript -e 'name of application "FlywheelDefinitelyMissingXYZ"'
→ FlywheelDefinitelyMissingXYZ (rc=0)

osascript -e 'id of application "FlywheelDefinitelyMissingXYZ"'
→ Can’t get application "FlywheelDefinitelyMissingXYZ". (-1728)

osascript -e 'path to application "FlywheelDefinitelyMissingXYZ"'
→ Can’t get application "FlywheelDefinitelyMissingXYZ". (-1728)
```

`name` 对不存在的名称只回显 specifier，连 LaunchServices 存在性都没有证明，因此不能用作 capability probe。

## AppleScript 语义

Apple 官方资料给出三条直接相关的语义：

1. Terminal 是 scriptable application，`osascript` 可从命令行执行 AppleScript。来源：[Terminal User Guide — Automate tasks using AppleScript and Terminal](https://support.apple.com/guide/terminal/trml1003/mac)。
2. AppleScript 的 application 对象会动态定位；对象 specifier（包括 `tell application` 中的对象）每次执行都会重新求值。来源：[AppleScript Language Guide — application class](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_classes.html)。
3. application 的内建 `name` 属性会返回应用名，且不会启动应用或发送 Apple event；相反，需要应用响应的 `tell` 命令会在必要时启动本地应用并向它发送事件。来源：[application class](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_classes.html) 与 [tell statements](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_control_statements.html)。

因此最终采用 `osascript -e 'tell application "Terminal" to count windows'`。`count windows` 是 Terminal 字典中的只读操作：它不创建或关闭测试窗口，但必须完成与真实用例相同的 Terminal dictionary 编译、application resolution 和 Apple event 往返。当前 resident session 直接证明它能抓住 `name` 属性漏掉的故障。

## 方案比较

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| `which osascript` | 淘汰 | 只检查解释器存在，正是当前缺陷 |
| `System Events` 查询 `application process "Terminal"` | 淘汰 | 查询的是 Terminal 当前是否已运行；Terminal 未运行但可解析时会产生不必要 skip，削弱验收 A |
| `path to application "Terminal"` | 淘汰 | 只证明 LaunchServices 定位；当前证据已证明定位成功不等于 Terminal dictionary/Apple event 通路可用 |
| `name of application "Terminal"` | 淘汰 | 当前 resident session 上返回成功，但真实两条仍全红；它不发送事件，判据仍塌在代理信号 |
| `tell application "Terminal" to count windows` | 采用 | Terminal 字典的最小只读操作；当前阴性环境复现 `Can’t get application "Terminal"`，同时不篡改测试窗口 |

## 失败处理与超时

- 非 Darwin：立即返回 `false`，不调用任何子进程。
- Darwin：同步运行 `osascript`，参数固定为 `-e` 和 `tell application "Terminal" to count windows`。
- 设置 15 秒 timeout，给未运行的 Terminal 留出冷启动余量。命令不存在、解析失败、权限/上下文错误、signal kill、timeout 均通过 `execFileSync` 抛错并 fail-closed；skip reason 明确写出当前 process context 的 probe 失败，避免与非 macOS 混淆。
- 在模块 collection 时只计算一次 capability，真实 suite 和显式 skipped suite 复用该值，避免重复探测结果不一致。

## 可执行回归策略

守卫仍是测试基础设施内部逻辑，因此用窄 dependency injection 暴露子进程边界，不修改生产 API：

- 阳性 fake 只允许精确的 `osascript -e 'tell application "Terminal" to count windows'`，否则抛错。
- 阴性 fake 明确让 `which osascript` 成功、让真实 Terminal probe 抛出 `Can't get application Terminal`。新实现应返回 `false`；旧实现变异会错误返回 `true`，测试必红。
- 非 Darwin fake 在任何调用时抛错；预期仍返回 `false`，证明短路。

测试只验证 suite capability 这个 seam；既有两条真实 GUI 测试继续验证 Terminal 字典和关闭行为，不改其断言。

## 会过期的结论

| 结论 | as-of | 重核命令 |
| --- | --- | --- |
| 当前 implement lane 的 `count windows` probe 为 -1728，旧真实 GUI suite 为 2 failed | 2026-09-03 20:11–20:12 PDT | `osascript -e 'tell application "Terminal" to count windows'`；`pnpm --filter flywheel-core exec vitest run test/tmux-viewer.macos.test.ts --reporter=verbose` |
| design-review lane 的同一 probe 两次为 `2`, rc=0 | design review round 2，2026-09-03 | 由该 lane/Lead 在 exact head 上重跑；不可用本 lane 代替 |
| 仓库 CI runner 全为 Ubuntu，因此真实 Terminal GUI 两条不在 CI 执行 | 2026-09-03, `origin/main` 61e6c6798 | `rg -n 'runs-on:' .github/workflows/ci.yml` |

以上都是环境或仓库配置观测，不是永久事实。尤其 probe 结果必须按当前进程重新测量，不能沿用另一 lane 的结论。
