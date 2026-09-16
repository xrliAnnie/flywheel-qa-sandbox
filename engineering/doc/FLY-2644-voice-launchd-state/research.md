# FLY-2644 launchctl 顶层 state 解析 — 调研
Issue: FLY-2644 (https://linear.app/geoforge3d/issue/FLY-2644/2598follow-up-install-voice-launchdsh-%E6%B0%B8%E8%BF%9C%E5%9B%9E%E6%BB%9A-voice-loaded-identity-%E8%A6%81%E6%B1%82)
日期: 2026-09-16
基于: exploration.md

## 当前实现

`_voice_loaded_identity` 把完整 `launchctl print` 文本交给 Python。`field(name)` 使用 `^\s*<name> = ...$` 收集所有缩进层级的同名字段，并且只有恰好一个匹配时才返回值。这个全局唯一约束适用于当前的 path、program 和 pid，但不适用于 launchd 会在嵌套事件/活动结构中重复输出的 state。

运行模式还要求：已加载 plist path 等于安装目标、program 为 `/bin/bash`、arguments 精确为 `/bin/bash` 和生产 wrapper、顶层 state 为 running、pid 为正整数。identity 模式省略 state/PID，只用于确认失败安装可以安全 bootout。

## 真实输出形状与缺口

2026-09-16 主机观察到：顶层字段使用一个 tab 缩进；顶层 `state = running` 后还有两处更深缩进的 `state = active`。生产证据中的 state 匹配数是 3，而 path/program/pid 各是 1。现有测试桩只输出一行无缩进的 state，因此没有覆盖 launchd 的层级结构。

## 方案比较

1. 取 state 的第一处匹配：改动小，但把正确性依赖于 launchctl 永远先输出顶层字段，语义没有直接编码。
2. 只匹配一个 tab 缩进的 state：直接表达顶层 launchd 字段，嵌套 active 不再参与判定；与主机输出形状一致。
3. 写完整花括号解析器：能表达层级，但对这个单字段缺陷过度复杂，也扩大 shell 内嵌 Python 的风险面。

选择方案 2。保留通用 `field()` 对身份字段的严格唯一校验，只为运行状态增加 `top_field()`。测试桩改为真实缩进，并同时输出两个嵌套 active；既有 refused 测试继续作为阴性控制，证明嵌套 active 不能把非 running 顶层状态误判为成功。

## 验证范围

- 红灯：先改夹具，不改解析器；安装 happy path 因三个 state 匹配而失败并回滚。
- 绿灯：最小 parser 修复后运行 `node --test scripts/__tests__/install-voice-launchd.test.mjs` 和 shell wrapper。
- 结构门：确认现有 CI 对 Node 套件和 shell wrapper 的枚举未漂移。
- 仓库门：lint、递归 build、package aggregate，以及新增/相关 root script tests。
- 不以本地夹具代替合入、部署或真实主机激活证明。
