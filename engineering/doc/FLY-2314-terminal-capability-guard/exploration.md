# FLY-2314 Terminal 能力守卫 — 探索
Issue: FLY-2314 (https://linear.app/geoforge3d/issue/FLY-2314/判据卫生-macos-terminal-测试的-skip-守卫只查-which-osascript不查-terminalapp-能否解析)
日期: 2026-09-03
基于: 无

## 问题

`packages/core/test/tmux-viewer.macos.test.ts` 包含两条需要真实 `osascript` 与真实 Terminal.app 的 GUI 回归测试。当前 suite 的启用条件是 `process.platform === "darwin"` 且 `which osascript` 成功。macOS 自带 `/usr/bin/osascript`，因此这个条件只证明命令存在，不能证明当前 LaunchServices/Aqua 上下文能解析 Terminal.app。

已知不可解析环境的决定性失败是：

```text
osascript: Can't get application Terminal
open -a Terminal: Unable to find application
```

同一晚既有 runner 在该错误上失败，也有 runner 跑完 `packages/core` 全绿，说明测试本身仍有真实可运行环境，不能粗暴地在所有 resident runner 或所有 CI 上跳过。

## 当前实现与缺口

当前守卫：

```ts
function osascriptAvailable(): boolean {
	if (!isMacOS) return false;
	try {
		execFileSync("which", ["osascript"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
```

它检查的是代理信号“二进制可发现”，而 suite 真正依赖的是“AppleScript 能解析 Terminal application 对象”。两者在 macOS resident/no-GUI 环境中不等价。

## 锁定范围

- 只修正该测试文件的 suite capability guard 与守卫的回归覆盖。
- 保持两条真实 GUI 测试的断言、操作步骤与清理逻辑不变。
- 不修改生产 `closeRunnerTerminalView` 行为。
- 不通过修改 PATH 或隐藏 `osascript` 来制造 skip。
- 探针必须同步、有限时、失败闭合，且只读取 Terminal 状态，不打开或关闭测试窗口。为真实验证 Apple event 通路，若 Terminal 尚未运行，macOS 可能按正常 application command 语义启动它；这与 suite 随后本就要驱动 Terminal 的范围一致。

## 测试 seam

issue 已预先锁定的公共 seam 是“真实 GUI suite 是否具备运行能力”。可执行测试在 `execFileSync` 系统边界注入两类结果：

1. macOS + `osascript` 能执行最小 Terminal 字典读取 ⇒ 返回可运行。
2. macOS + `osascript` 二进制存在、名称属性可读，但 Terminal 字典/Apple event 通路不可用 ⇒ 返回不可运行。
3. 非 macOS ⇒ 不调用探针并返回不可运行。

第二类必须让退回 `which osascript` 的变异变红；它不能只断言命令存在。

## 验收映射

| 验收 | 权威证据 |
| --- | --- |
| A：可驱动 Terminal 时真实测试照常运行 | 守卫阳性单测 + suite 直接复用同一判据；由 `flywheel-eng-lead` 协调 GUI-capable process 对 exact head 跑真实两条并回传用例级结果 |
| B：不可解析 Terminal 时 skip 而非失败 | 守卫阴性单测模拟确定的 `Can't get application Terminal` 边界；suite 使用同一布尔结果 |
| 退回 `which osascript` 时 B 变红 | 在隔离副本应用真实旧实现变异并运行定向测试，记录预期失败 |
| 不削弱真实 GUI 断言 | `git diff` 证明两条既有 `it(...)` 的主体与断言未改 |

## 风险

- 仅查 application 内建 `name` 属性仍可能在 resident XPC 失效时假阳性；探针必须使用 Terminal 自己字典中的只读命令，不能停在名称定位。
- capability 是 process-context 属性，不是整台主机的固定属性；同一机器的不同 sandbox/LaunchServices bootstrap namespace 可能一侧成功、一侧失败。
- 若测试只断言调用参数而不模拟“which 成功、Terminal 解析失败”，可能实现耦合且无法证明 B；阴性用例必须表达能力差异。
- collection 时若重复执行探针，会增加噪音；应只计算一次并复用 suite 判定与 skip 说明。
